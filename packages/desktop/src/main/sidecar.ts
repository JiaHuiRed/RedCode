import { drizzle } from "drizzle-orm/node-sqlite/driver"
import * as module from "node:module"
import * as http from "node:http"
import * as tls from "node:tls"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

type NodeHttpWithEnvProxy = typeof http & {
  setGlobalProxyFromEnv: () => void
}

type NodeTlsWithSystemCertificates = typeof tls & {
  getCACertificates: (type: "default" | "system") => string[]
  setDefaultCACertificates: (certificates: string[]) => void
}

type StartCommand = {
  type: "start"
  hostname: string
  port: number
  password: string
  userDataPath: string
  needsMigration: boolean
}

/**
 * 给那个 20MB 的服务端 bundle 开 V8 编译缓存。
 *
 * 260901 cc `import virtual:redcode-server` 是启动里最大的单项，他机器上实测
 * 1132 / 1183 / 1343 / 1777 ms，占 sidecar 就绪时间的 92%（剩下的 Server.listen 只要 100ms）。
 * 那不是 I/O，是 V8 解析编译执行 20MB JS。
 *
 * 拿真实 bundle 做过冷热对照（Electron 42.4.1 自带 Node 24.16.0，enableCompileCache 可用）：
 *   不开缓存        1245 / 1294 / 1312 ms
 *   开缓存·首次冷   1403 ms   （多付约 110ms 写缓存）
 *   开缓存·后续热   1035 / 1019 / 1149 ms
 * 约省 260ms（20%），缓存 3.1MB / 131 个文件。省不掉更多是因为这 1.3 秒里大部分是模块
 * **执行**而不是编译——编译缓存只能吃掉编译那部分，别指望它把 import 变成零。
 *
 * 必须在 `await import("virtual:redcode-server")` **之前**调用，静态 import 会被提升到
 * 模块顶部、来不及。缓存目录名里带 Node 版本与内容哈希（v24.16.0-x64-17dfeeaa），
 * 升级 Electron 或重新构建 bundle 会自然失效，不需要手工清。
 *
 * 失败一律吞掉：它纯粹是加速，任何原因不可用（磁盘只读、API 变动）都不该影响启动。
 */
function enableCompileCache(userDataPath: string) {
  try {
    const enable = (module as unknown as { enableCompileCache?: (dir: string) => unknown }).enableCompileCache
    if (typeof enable !== "function") return
    enable(path.join(userDataPath, "compile-cache"))
  } catch {
    // 加速失败不是错误
  }
}

type StopCommand = { type: "stop" }
type SidecarCommand = StartCommand | StopCommand

type SidecarMessage =
  | { type: "sqlite"; progress: { type: "InProgress"; value: number } | { type: "Done" } }
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "error"; error: { message: string; stack?: string } }

type ParentPort = {
  postMessage(message: SidecarMessage): void
  on(event: "message", listener: (event: { data: unknown }) => void): void
}

type Listener = {
  stop(close?: boolean): void | Promise<void>
}

const parentPort = getParentPort()

process.on("uncaughtException", (error) => {
  const msg = `[sidecar-fatal] uncaughtException: ${error.stack ?? error.message}\n`
  fs.appendFileSync(path.join(os.tmpdir(), "redcode-sidecar-crash.log"), msg)
  parentPort.postMessage({ type: "error", error: serializeError(error) })
  setImmediate(() => process.exit(1))
})
process.on("unhandledRejection", (reason) => {
  const msg = `[sidecar-fatal] unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}\n`
  fs.appendFileSync(path.join(os.tmpdir(), "redcode-sidecar-crash.log"), msg)
  parentPort.postMessage({
    type: "error",
    error: serializeError(reason instanceof Error ? reason : new Error(String(reason))),
  })
  setImmediate(() => process.exit(1))
})
// 260813 cc "code 0 静默蒸发"取证钩子。start() 里那句保活注释是错觉——
// `await new Promise(() => {})` 不产生 active handle，真正撑住事件循环的是 listener 的
// listen socket。listener 一旦被意外关闭，事件循环排空 → Node 自然 exit 0：不走上面任何
// exit(1) 路径，crash log 全空（260813 实证：sidecar 10:58 无声退出，主进程只看到
// exited {code:0}，死无对证）。beforeExit 只在自然排空时触发——process.exit() 不触发，
// 所以合法的 stop()/exit(1) 都不会误报；在这里留遗言 + 通知主进程，下次再死必有现场。
process.on("beforeExit", (code) => {
  try {
    const resources = (process as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo?.() ?? []
    const msg =
      `[sidecar-fatal] event loop drained (beforeExit code=${code}) ` +
      `listener=${listener ? "alive" : "gone"} resources=${JSON.stringify(resources)}\n`
    fs.appendFileSync(path.join(os.tmpdir(), "redcode-sidecar-crash.log"), msg)
    parentPort.postMessage({ type: "error", error: serializeError(new Error(msg.trim())) })
  } catch {}
})

let listener: Listener | undefined

parentPort.on("message", (event) => {
  const command = parseCommand(event.data)
  if (!command) return
  if (command.type === "stop") {
    void stop()
    return
  }
  void start(command)
})

async function start(command: StartCommand) {
  // 260608 Red 启动计时：定位首页"加载中"卡在 sidecar 哪段（import/migration/listen），测完即删
  const t0 = performance.now()
  const mark = (label: string) => console.error(`[sidecar-timing] ${label}: ${Math.round(performance.now() - t0)}ms`)
  try {
    prepareSidecarEnv(command.password, command.userDataPath)
    ensureLoopbackNoProxy()
    useSystemCertificates()
    useEnvProxy()
    enableCompileCache(command.userDataPath)
    const { Database, JsonMigration, Log, Server } = await import("virtual:redcode-server")
    mark("import virtual:redcode-server")
    await Log.init({ level: "WARN" })

    if (command.needsMigration) {
      await JsonMigration.run(drizzle({ client: Database.Client().$client }), {
        progress: (event: { current: number; total: number }) => {
          parentPort.postMessage({
            type: "sqlite",
            progress: {
              type: "InProgress",
              value: event.total === 0 ? 100 : Math.round((event.current / event.total) * 100),
            },
          })
        },
      })
      parentPort.postMessage({ type: "sqlite", progress: { type: "Done" } })
      mark("migration")
    }

    listener = await Server.listen({
      port: command.port,
      hostname: command.hostname,
      username: "redcode",
      password: command.password,
      cors: ["oc://renderer"],
    })
    mark("Server.listen (ready)")
    parentPort.postMessage({ type: "ready" })
    // Keep the process alive until told otherwise
    await new Promise<void>(() => {})
  } catch (error) {
    const msg = `[sidecar-caught] ${error instanceof Error ? error.stack : String(error)}\n`
    fs.appendFileSync(path.join(os.tmpdir(), "redcode-sidecar-crash.log"), msg)
    parentPort.postMessage({ type: "error", error: serializeError(error) })
    setImmediate(() => process.exit(1))
  }
}

async function stop() {
  try {
    await listener?.stop()
  } finally {
    listener = undefined
    parentPort.postMessage({ type: "stopped" })
    setImmediate(() => process.exit(0))
  }
}

function prepareSidecarEnv(password: string, userDataPath: string) {
  Object.assign(process.env, {
    REDCODE_SERVER_USERNAME: "redcode",
    REDCODE_SERVER_PASSWORD: password,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? userDataPath,
  })
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

function useSystemCertificates() {
  try {
    const nodeTls = tls as NodeTlsWithSystemCertificates
    nodeTls.setDefaultCACertificates([
      ...new Set([...nodeTls.getCACertificates("default"), ...nodeTls.getCACertificates("system")]),
    ])
  } catch (error) {
    console.warn("failed to load system certificates", error)
  }
}

function useEnvProxy() {
  try {
    ;(http as NodeHttpWithEnvProxy).setGlobalProxyFromEnv()
  } catch (error) {
    console.warn("failed to load proxy environment", error)
  }
}

function parseCommand(value: unknown): SidecarCommand | undefined {
  if (!value || typeof value !== "object") return
  const command = value as Partial<StartCommand | StopCommand>
  if (command.type === "stop") return { type: "stop" }
  if (command.type !== "start") return
  if (typeof command.hostname !== "string") return
  if (typeof command.port !== "number") return
  if (typeof command.password !== "string") return
  if (typeof command.userDataPath !== "string") return
  if (typeof command.needsMigration !== "boolean") return
  return {
    type: "start",
    hostname: command.hostname,
    port: command.port,
    password: command.password,
    userDataPath: command.userDataPath,
    needsMigration: command.needsMigration,
  }
}

function serializeError(error: unknown) {
  if (error instanceof Error) return { message: error.message, stack: error.stack }
  return { message: String(error) }
}

function getParentPort() {
  const port = process.parentPort as ParentPort | undefined
  if (!port) throw new Error("Sidecar parent port unavailable")
  return port
}
