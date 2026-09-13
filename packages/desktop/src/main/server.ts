import { killSidecarTree, killSidecarTreeSync } from "./sidecar-process"

// 260913 Red sidecar 进程树清理提取到 sidecar-process.ts：
//   - 严格 PID guard（NaN / <=1 / process.pid 全拦截）
//   - Windows taskkill /T 返回可等待 Promise，有界 timeout 10s
//   - 同步路径 spawnSync 带 timeout，防止主进程 exit 卡死
// 旧 fire-and-forget 逻辑见 git history；竞态见 sidecar-process.test.ts

import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { app, session, utilityProcess } from "electron"
import type { Details } from "electron"
import { DEFAULT_SERVER_URL_KEY, WSL_ENABLED_KEY } from "./constants"
import { getUserShell, loadShellEnv } from "./shell-env"
import { getStore } from "./store"
import type { SqliteMigrationProgress } from "../preload/types"

export type WslConfig = { enabled: boolean }

export type HealthCheck = { wait: Promise<void> }

type SidecarMessage =
  | { type: "sqlite"; progress: SqliteMigrationProgress }
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

export type SidecarListener = { stop: () => Promise<void>; pid: number | undefined }


const SIDECAR_SERVICE_NAME = "redcode server"
const SIDECAR_START_STALL_TIMEOUT = 60_000
const SIDECAR_STOP_TIMEOUT = 6_000

type SpawnLocalServerOptions = {
  needsMigration: boolean
  userDataPath: string
  onSqliteProgress?: (progress: SqliteMigrationProgress) => void
  onStdout?: (message: string) => void
  onStderr?: (message: string) => void
  onExit?: (code: number) => void
}

export function getDefaultServerUrl(): string | null {
  const value = getStore().get(DEFAULT_SERVER_URL_KEY)
  return typeof value === "string" ? value : null
}

export function setDefaultServerUrl(url: string | null) {
  if (url) {
    getStore().set(DEFAULT_SERVER_URL_KEY, url)
    return
  }

  getStore().delete(DEFAULT_SERVER_URL_KEY)
}

export function getWslConfig(): WslConfig {
  const value = getStore().get(WSL_ENABLED_KEY)
  return { enabled: typeof value === "boolean" ? value : false }
}

export function setWslConfig(config: WslConfig) {
  getStore().set(WSL_ENABLED_KEY, config.enabled)
}

export function preferAppEnv(userDataPath: string) {
  const shell = process.platform === "win32" ? null : getUserShell()
  Object.assign(process.env, {
    ...(shell ? loadShellEnv(shell) : null),
    REDCODE_EXPERIMENTAL_ICON_DISCOVERY: "true",
    // 260807 Red: 移除 FILEWATCHER 注入——@parcel/watcher 原生模块
    // 在 GUI sidecar 常驻触发 V8 Invalid handle abort（0x9E44），
    // 表现为运行约 20 分钟后 sidecar 崩溃、GUI 全面 Failed to fetch。
    // TUI 默认不加载 watcher，从未崩溃；GUI 失去文件监听为可接受副作用。
    REDCODE_CLIENT: "desktop",
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath,
  })
}

export async function spawnLocalServer(
  hostname: string,
  port: number,
  password: string,
  options: SpawnLocalServerOptions,
) {
  const sidecar = join(dirname(fileURLToPath(import.meta.url)), "sidecar.js")
  const child = utilityProcess.fork(sidecar, [], {
    cwd: process.cwd(),
    env: await createSidecarEnv(),
    serviceName: SIDECAR_SERVICE_NAME,
    stdio: "pipe",
  })
  let exited = false
  const exit = defer<number>()

  const onProcessGone = (_event: unknown, details: Details) => {
    if (details.type !== "Utility" || details.name !== SIDECAR_SERVICE_NAME) return
    options.onStderr?.(`utility process gone reason=${details.reason} exitCode=${details.exitCode}`)
  }

  app.on("child-process-gone", onProcessGone)
  child.once("exit", (code) => {
    exited = true
    app.off("child-process-gone", onProcessGone)
    options.onExit?.(code)
    exit.resolve(code)
  })
  child.on("error", (error) => options.onStderr?.(`utility process error: ${serializeError(error).message}`))
  // Permanent listener for runtime errors (survives cleanup after "ready")
  child.on("message", (message: SidecarMessage) => {
    if (message.type === "error") options.onStderr?.(`sidecar runtime error: ${message.error.message}`)
  })

  child.stdout?.on("data", (chunk: Buffer) => options.onStdout?.(chunk.toString("utf8").trimEnd()))
  child.stderr?.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8").trimEnd()))

  await new Promise<void>((resolve, reject) => {
    let done = false
    let timeout: NodeJS.Timeout

    const fail = (error: Error) => {
      if (done) return
      done = true
      cleanup()
      reject(error)
    }

    const refreshTimeout = () => {
      clearTimeout(timeout)
      timeout = setTimeout(() => {
        fail(new Error(`Sidecar did not become ready within ${SIDECAR_START_STALL_TIMEOUT}ms: ${sidecar}`))
      }, SIDECAR_START_STALL_TIMEOUT)
    }

    const onMessage = (message: SidecarMessage) => {
      if (message.type === "sqlite") {
        refreshTimeout()
        options.onSqliteProgress?.(message.progress)
        return
      }
      if (message.type === "ready") {
        if (done) return
        done = true
        cleanup()
        resolve()
        return
      }
      if (message.type === "error") {
        fail(Object.assign(new Error(message.error.message), { stack: message.error.stack }))
      }
    }
    const onExit = (code: number) => {
      fail(new Error(`Sidecar exited before ready with code ${code}`))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      child.off("message", onMessage)
      child.off("exit", onExit)
    }

    child.on("message", onMessage)
    child.on("exit", onExit)
    refreshTimeout()
    child.postMessage({
      type: "start",
      hostname,
      port,
      password,
      userDataPath: options.userDataPath,
      needsMigration: options.needsMigration,
    })
  }).catch(async (error) => {
    if (!exited) {
      // 260913 Red 启动失败也要等待 tree kill，避免孙进程成孤儿
      try {
        await killSidecarTree(child.pid)
      } catch {
        // 忽略：sidecar 可能已经退出
      }
      try {
        child.kill()
      } catch {
        // 忽略
      }
    }
    throw error
  })

  const wait = (async () => {
    const url = `http://${hostname}:${port}`
    let healthy = false
    const gone = exit.promise.then((code) => {
      if (healthy) return
      throw new Error(`Sidecar exited before health check passed with code ${code}`)
    })

    // 260901 cc 先探一次再睡，别先睡再探。
    //
    // 这个循环是在收到 sidecar 的 "ready" 之后才开始跑的（上面那个 await new Promise
    // 等的就是它），而 sidecar 是 `await Server.listen(...)` 成功之后才 postMessage("ready")
    // 的（sidecar.ts:119 → :127）。也就是说循环启动时端口 100% 已经在监听，第一次
    // checkHealth 必然成功 —— 原先那句放在循环头的 sleep(100) 是纯粹的固定损耗。
    //
    // 他打包版日志里 ready→healthy 的间隔：118 / 123 / 123 / 134 ms（五次），基本全是这 100ms。
    const ready = async () => {
      // 260909 Red 轮询必须能自己停：调用方 30s 超时是纯放弃（不杀 sidecar），
      // 没有谁会再来消费这个循环——sidecar 活着但 health 一直不过（密码错配、
      // migration 卡住）时，原实现的 10Hz 空转 fetch 会烧到进程退出。
      // 预算 120s 覆盖合法慢启动，之后静默停轮（healthy 保持 false 由调用方处置）。
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline) {
        if (await checkHealth(url, password)) {
          healthy = true
          return
        }
        if (exited) return
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }

    await Promise.race([ready(), gone])
  })()

  let stopping: Promise<void> | undefined

  return {
    listener: {
      stop: () => {
        if (stopping) return stopping
        if (exited) return Promise.resolve()
        child.postMessage({ type: "stop" })
        stopping = (async () => {
          await Promise.race([
            exit.promise.then(() => undefined),
            delay(SIDECAR_STOP_TIMEOUT),
          ])
          if (!exited) {
            // 260913 Red 等待 tree kill 完成，再 fallback kill sidecar 自己；
            // 避免 fire-and-forget taskkill 在父进程退出时被带走。
            try {
              await killSidecarTree(child.pid)
            } catch {
              // 忽略：sidecar 可能已经退出，taskkill 找不到 PID
            }
            try {
              child.kill()
            } catch {
              // 忽略：sidecar 可能已经退出
            }
          }
          // 有界确认：等 sidecar 退出事件，最多再等 5 秒
          await Promise.race([exit.promise.then(() => undefined), delay(5_000)]).catch(() => undefined)
        })()
        return stopping
      },
      pid: child.pid,
    },
    health: { wait },
  }
}

export async function checkHealth(url: string, password?: string | null): Promise<boolean> {
  let healthUrl: URL
  try {
    healthUrl = new URL("/global/health", url)
  } catch {
    return false
  }

  const headers = new Headers()
  if (password) {
    const auth = Buffer.from(`redcode:${password}`).toString("base64")
    headers.set("authorization", `Basic ${auth}`)
  }

  try {
    const res = await fetch(healthUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}

async function createSidecarEnv(): Promise<Record<string, string>> {
  const env = Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])),
  )
  delete env.DEBUG
  if (process.platform === "linux") delete env.LD_PRELOAD
  // 260608 Red sidecar 是 Node，只认 HTTP(S)_PROXY 环境变量、不读系统代理；Clash 等只设系统代理 →
  // sidecar 直连卡死（npm reify @opencode-ai/plugin 拖到 ~37s，冻住首页）。把系统代理注入 env 让其走代理。
  if (!env.HTTP_PROXY && !env.http_proxy && !env.HTTPS_PROXY && !env.https_proxy) {
    const proxy = await resolveSystemProxyUrl()
    if (proxy) {
      env.HTTP_PROXY = proxy
      env.HTTPS_PROXY = proxy
    }
  }
  return env
}

// 260608 Red 用 Electron 解析 Windows 系统代理（Clash 设的就是这个），转成 npm/Node 认的 http://host:port
async function resolveSystemProxyUrl(): Promise<string | undefined> {
  try {
    const resolved = await session.defaultSession.resolveProxy("https://registry.npmjs.org")
    for (const entry of resolved.split(";")) {
      const part = entry.trim()
      if (!part || part === "DIRECT") continue
      const match = part.match(/^(?:PROXY|HTTPS)\s+(\S+)$/i)
      if (match) return `http://${match[1]}`
    }
  } catch {
    // 解析失败就当无代理、直连，与原行为一致
  }
  return undefined
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
