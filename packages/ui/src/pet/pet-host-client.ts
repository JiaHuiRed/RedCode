import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import type { DesktopPetSnapshot } from "@redcode-ai/ui/desktop-pet"
import {
  validatePetHostFile,
  validatePetInstallFile,
  type PetHostEvent,
  type PetHostFile,
  type PetSourceKind,
} from "./pet-host-protocol"
import { PET_HOST_FILE, PET_HOST_INSTALL_FILE, readPetStateJson } from "./pet-host-files"

// 261119 Red 桌宠宿主的来源客户端（GUI 主进程与 TUI 共用，kind 区分来源）。
// 职责：按需发现/spawn 宿主、注册来源、推快照、显式激活（窗口焦点/切会话）、退出释放。
// 宿主不可用时 push 返回 false，渲染层保持既有 inline 兜底（DesktopPetBridge 契约不变）。
// 依赖全部可注入（照 sidecar-supervisor 的测试模式）：fetch/文件/spawn/sleep 均为 fake 点。

const CONNECT_TIMEOUT_MS = 3_000
const RELEASE_TIMEOUT_MS = 1_500
const SPAWN_WAIT_MS = 10_000
const POLL_INTERVAL_MS = 250

type Connection = { abort: AbortController; generation: number }

export type PetHostClient = {
  /** 推快照；false = 宿主不可用（渲染层走 inline 兜底）。 */
  push(snapshot: DesktopPetSnapshot | null): Promise<boolean>
  /** 显式激活接管（GUI 窗口焦点、渲染层切会话）。未连接时记下待办，连上后补发。 */
  activate(): void
  /** 宿主→来源：用户点了赤的关闭按钮（只关本次显示）。 */
  onClosed(listener: () => void): () => void
  dispose(): void
}

export function createPetHostClient(deps: {
  /** 来源类型：GUI 主进程与 TUI 进程各持一个客户端实例。 */
  kind: PetSourceKind
  log: (message: string, fields?: Record<string, unknown>) => void
  fetchImpl?: typeof fetch
  readJson?: (name: string) => unknown | undefined
  spawnHost?: (command: string[]) => void
  sleep?: (ms: number) => Promise<void>
}) {
  const fetchImpl = deps.fetchImpl ?? fetch
  const readJson = deps.readJson ?? readPetStateJson
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const sourceID = randomUUID()
  const closedListeners = new Set<() => void>()
  let generation = 0
  let sequence = 0
  let connection: Connection | undefined
  let connecting: Promise<boolean> | undefined
  let pendingActivate = false
  let disposed = false

  function authHeaders(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}`, "content-type": "application/json" }
  }

  function request(host: PetHostFile, path: string, body?: unknown, timeoutMs = CONNECT_TIMEOUT_MS): Promise<Response> {
    return fetchImpl(`http://127.0.0.1:${host.port}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: authHeaders(host.token),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  }

  function dropConnection(stale: Connection) {
    if (connection === stale) connection = undefined
  }

  function handleEventStream(host: PetHostFile, conn: Connection) {
    void (async () => {
      const res = await fetchImpl(`http://127.0.0.1:${host.port}/v1/pet/events?sourceID=${sourceID}`, {
        headers: authHeaders(host.token),
        signal: conn.abort.signal,
      })
      if (!res.ok || !res.body) throw new Error(`event stream rejected: ${res.status}`)
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let frameEnd: number
        while ((frameEnd = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, frameEnd)
          buffer = buffer.slice(frameEnd + 2)
          const data = frame.split("\n").find((line) => line.startsWith("data: "))
          if (!data) continue
          try {
            const event = JSON.parse(data.slice(6)) as PetHostEvent
            if (event.type === "closed") {
              for (const listener of closedListeners) listener()
            }
          } catch (error) {
            // 吞掉的是 SSE 帧里的 JSON 损坏：单帧丢弃，流继续；宿主帧是本进程写的不应发生
            deps.log("pet host event frame discarded", { error: String(error) })
          }
        }
      }
      dropConnection(conn)
    })().catch(() => {
      // 流断开（宿主退出/被杀/dispose abort）：清掉本代次连接，下一次 push 走重连（新代次）
      dropConnection(conn)
    })
  }

  async function sendActivate(host: PetHostFile, conn: Connection) {
    const res = await request(host, "/v1/pet/activate", { type: "activate", sourceID, generation: conn.generation }).catch(
      () => undefined,
    )
    if (res?.ok) pendingActivate = false
  }

  async function openConnection(host: PetHostFile): Promise<boolean> {
    const conn: Connection = { abort: new AbortController(), generation: ++generation }
    const register = await request(host, "/v1/pet/register", {
      type: "register",
      sourceID,
      kind: deps.kind,
      generation: conn.generation,
    })
    if (!register.ok) {
      deps.log("pet host register failed", { status: register.status })
      return false
    }
    connection = conn
    handleEventStream(host, conn)
    if (pendingActivate) await sendActivate(host, conn)
    return true
  }

  async function connectOnce(): Promise<boolean> {
    const running = validatePetHostFile(readJson(PET_HOST_FILE))
    if (running) {
      try {
        const health = await request(running, "/v1/pet/health")
        if (health.ok) return await openConnection(running)
      } catch (error) {
        deps.log("pet host health probe failed", { error: String(error) })
      }
    }
    // 宿主未运行或不应答：有 spawn 登记就拉起（detached，GUI 退出不影响宿主），轮询登记文件
    const install = validatePetInstallFile(readJson(PET_HOST_INSTALL_FILE))
    if (!install) return false
    if (running) {
      try {
        process.kill(running.pid, 0)
        return false // 进程还活着但不应答：不是我们该抢的宿主，直接放弃本轮
      } catch {
        // ESRCH：登记文件是残留，宿主进程已死，可以 spawn 新的
      }
    }
    ;(deps.spawnHost ?? ((command: string[]) => {
      const child = spawn(command[0], command.slice(1), { detached: true, stdio: "ignore", windowsHide: true })
      child.unref()
    }))(install.command)
    for (let waited = 0; waited < SPAWN_WAIT_MS; waited += POLL_INTERVAL_MS) {
      await sleep(POLL_INTERVAL_MS)
      if (disposed) return false
      const next = validatePetHostFile(readJson(PET_HOST_FILE))
      if (next && next.startedAt !== running?.startedAt) {
        try {
          const health = await request(next, "/v1/pet/health")
          if (health.ok) return await openConnection(next)
        } catch (error) {
          deps.log("pet host probe after spawn failed", { error: String(error) })
        }
      }
    }
    return false
  }

  function ensureConnected(): Promise<boolean> {
    if (disposed) return Promise.resolve(false)
    if (connection) return Promise.resolve(true)
    connecting ??= connectOnce().finally(() => {
      connecting = undefined
    })
    return connecting
  }

  return {
    async push(snapshot: DesktopPetSnapshot | null): Promise<boolean> {
      if (disposed) return false
      const ok = await ensureConnected()
      const host = ok ? validatePetHostFile(readJson(PET_HOST_FILE)) : undefined
      const conn = connection
      if (!ok || !host || !conn) return false
      try {
        const res = await request(host, "/v1/pet/update", {
          type: "snapshot",
          sourceID,
          generation: conn.generation,
          sequence: ++sequence,
          snapshot,
        })
        if (!res.ok) {
          // 代次/序号被宿主拒绝 = 连接已过期：断开重连走下一轮
          conn.abort.abort()
          dropConnection(conn)
          return false
        }
        return true
      } catch (error) {
        deps.log("pet host push failed", { error: String(error) })
        conn.abort.abort()
        dropConnection(conn)
        return false
      }
    },

    activate() {
      if (disposed) return
      pendingActivate = true
      void (async () => {
        const ok = await ensureConnected()
        const host = ok ? validatePetHostFile(readJson(PET_HOST_FILE)) : undefined
        const conn = connection
        if (host && conn) await sendActivate(host, conn)
      })()
    },

    onClosed(listener: () => void) {
      closedListeners.add(listener)
      return () => closedListeners.delete(listener)
    },

    dispose() {
      if (disposed) return
      disposed = true
      const host = validatePetHostFile(readJson(PET_HOST_FILE))
      const conn = connection
      conn?.abort.abort()
      connection = undefined
      if (host) {
        void request(host, "/v1/pet/release", { type: "release", sourceID }, RELEASE_TIMEOUT_MS).catch(() => {
          // 释放失败只可能是宿主已退出：宿主会按 SSE 断连自行释放，无需补救
        })
      }
    },
  }
}
