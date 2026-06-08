import { drizzle } from "drizzle-orm/node-sqlite/driver"
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
  parentPort.postMessage({ type: "error", error: serializeError(reason instanceof Error ? reason : new Error(String(reason))) })
  setImmediate(() => process.exit(1))
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
  const mark = (label: string) =>
    console.error(`[sidecar-timing] ${label}: ${Math.round(performance.now() - t0)}ms`)
  try {
    prepareSidecarEnv(command.password, command.userDataPath)
    ensureLoopbackNoProxy()
    useSystemCertificates()
    useEnvProxy()
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
