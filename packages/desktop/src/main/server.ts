import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, spawnSync } from "node:child_process"
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

// 260609 CC sidecar 的 MCP 孙进程（npx→tsx→node）不在任何 job 里：sidecar 一旦被掐死
//   （dev 热重启 / stop 超时回退 / 崩溃）就成孤儿，堆积打满 commit charge → 渲染进程 OOM 白屏。
//   引擎侧 killProcessTree 的 taskkill /F /T 没机会跑（finalizer 不触发），故在主进程兜底：
//   趁 sidecar 还活着，按其 PID 杀整棵树（/T 连孙进程一起清）。taskkill 必须趁父进程未死才走得下去。
function killSidecarTreeWith(pid: number | undefined, sync: boolean) {
  if (typeof pid !== "number") return
  // 260724 Red 拒绝杀退化目标（同 core/cross-spawn-spawner.ts 今天的改动）：sidecarPid 万一
  // 因为某个 bug 被记错成主进程自己的 pid，/T /F 会把整个 Electron 主进程连自己一起带走。
  if (pid <= 1 || pid === process.pid) return
  if (process.platform === "win32") {
    const args = ["/F", "/T", "/PID", String(pid)]
    try {
      if (sync) spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true })
      else spawn("taskkill", args, { stdio: "ignore", windowsHide: true }).unref()
    } catch {}
    return
  }
  try {
    process.kill(pid, "SIGTERM")
  } catch {}
}

export function killSidecarTree(pid: number | undefined) {
  killSidecarTreeWith(pid, false)
}

// 同步版：仅供主进程 exit/SIGINT/SIGTERM 处理器使用（这些回调里只能跑同步代码）。
export function killSidecarTreeSync(pid: number | undefined) {
  killSidecarTreeWith(pid, true)
}

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
    REDCODE_EXPERIMENTAL_FILEWATCHER: "true",
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
  }).catch((error) => {
    if (!exited) {
      killSidecarTree(child.pid)
      child.kill()
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

    const ready = async () => {
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (await checkHealth(url, password)) {
          healthy = true
          return
        }
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
        stopping = Promise.race([
          exit.promise.then(() => undefined),
          delay(SIDECAR_STOP_TIMEOUT).then(() => {
            // 260609 CC 优雅 stop 超时：旧逻辑 child.kill() 只杀 sidecar 自己，MCP 孙进程留下成孤儿。
            //   趁 sidecar 还在，taskkill /T 杀整树再 kill。
            if (!exited) {
              killSidecarTree(child.pid)
              child.kill()
            }
          }),
        ])
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
