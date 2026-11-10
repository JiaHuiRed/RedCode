import { cmd } from "@/cli/cmd/cmd"
import { Rpc } from "@/util/rpc"
import { type rpc } from "./worker"
import path from "path"
import { fileURLToPath } from "url"
import { UI } from "@/cli/ui"
import { ProjectHistory } from "./project-history"
import * as Log from "@redcode-ai/core/util/log"
import { errorMessage } from "@/util/error"
import { withTimeout } from "@/util/timeout"
import { withNetworkOptions, resolveNetworkOptionsNoConfig } from "@/cli/network"
import { Filesystem } from "@/util/filesystem"
import type { GlobalEvent } from "@redcode-ai/sdk/v2"
import type { EventSource } from "./context/sdk"
import { win32DisableProcessedInput, win32InstallCtrlCGuard } from "./win32"
import { writeHeapSnapshot } from "v8"
import { TuiConfig } from "./config/tui"
import {
  REDCODE_PROCESS_ROLE,
  REDCODE_RUN_ID,
  ensureRunID,
  sanitizedProcessEnv,
} from "@redcode-ai/core/util/redcode-process"
import { validateSession } from "./validate-session"

declare global {
  const REDCODE_WORKER_PATH: string
}

type RpcClient = ReturnType<typeof Rpc.client<typeof rpc>>

export function createWorkerFetch(client: RpcClient): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = request.body ? await request.text() : undefined
    const result = await client.call("fetch", {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }
  return fn as typeof fetch
}

export function createEventSource(client: RpcClient): EventSource {
  return {
    subscribe: async (handler) => {
      return client.on<GlobalEvent>("global.event", (e) => {
        handler(e)
      })
    },
  }
}

async function target() {
  if (typeof REDCODE_WORKER_PATH !== "undefined") return REDCODE_WORKER_PATH
  const dist = new URL("./cli/cmd/tui/worker.js", import.meta.url)
  if (await Filesystem.exists(fileURLToPath(dist))) return dist
  return new URL("./worker.ts", import.meta.url)
}

async function input(value?: string) {
  const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
  if (!value) return piped
  if (!piped) return value
  return piped + "\n" + value
}

export function resolveThreadDirectory(project?: string, envPWD = process.env.PWD, cwd = process.cwd()) {
  const root = Filesystem.resolve(envPWD ?? cwd)
  if (project) return Filesystem.resolve(path.isAbsolute(project) ? project : path.join(root, project))
  return Filesystem.resolve(cwd)
}

// 261110 Red 编译产物双击/快捷方式启动时，调用位置会落在 exe 自己的目录——那不是用户想工作的
// 项目。只有 cwd 确实等于可执行文件所在目录时才判定为安装位置；不按目录名（如 bin）猜。
export function resolveInvocationDirectory(input: { cwd: string; execPath: string; compiled: boolean }) {
  const cwd = Filesystem.resolve(input.cwd)
  if (!input.compiled) return cwd
  const install = path.dirname(Filesystem.resolve(input.execPath))
  if (sameDirectory(cwd, install)) return undefined
  return cwd
}

function sameDirectory(a: string, b: string) {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "")
  const left = normalize(a)
  const right = normalize(b)
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

// 261110 Red 取最近记录里第一个仍然存在的目录；历史里被删/改名的路径不能当启动位置。
export async function latestProjectDirectory(): Promise<string | undefined> {
  for (const visit of await ProjectHistory.readProjectHistory()) {
    if (await Filesystem.isDir(visit.directory)) return visit.directory
  }
  return undefined
}

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: "start redcode tui",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", {
        type: "string",
        describe: "path to start redcode in",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      }),
  handler: async (args) => {
    // Keep ENABLE_PROCESSED_INPUT cleared even if other code flips it.
    // (Important when running under `bun run` wrappers on Windows.)
    const unguard = win32InstallCtrlCGuard()
    try {
      // Must be the very first thing — disables CTRL_C_EVENT before any Worker
      // spawn or async work so the OS cannot kill the process group.
      win32DisableProcessedInput()

      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }

      // 261110 Red 不再弹启动前的 raw 选择器：显式 path 优先；否则尊重真实调用 cwd，
      // 只有 cwd 落在 exe 安装目录时才恢复最近仍有效的项目；都没有就留空直达首页。
      const next =
        args.project !== undefined && args.project !== ""
          ? resolveThreadDirectory(args.project)
          : (resolveInvocationDirectory({
              cwd: process.cwd(),
              execPath: process.execPath,
              compiled: typeof REDCODE_WORKER_PATH !== "undefined",
            }) ?? (await latestProjectDirectory()))
      const file = await target()
      if (next) {
        try {
          process.chdir(next)
        } catch {
          UI.error("Failed to change directory to " + next)
          return
        }
      }
      // 261110 Red 没有可靠目录时保持 directory 为空，不能拿安装目录当项目。
      const cwd = next ? Filesystem.resolve(process.cwd()) : undefined
      // 261110 Red 显式会话必须有归属目录可校验，否则中间件会按默认实例把它路由到别的项目。
      if (args.session && !cwd) {
        UI.error("--session requires a project directory: start redcode in that project or pass its path")
        process.exitCode = 1
        return
      }
      const env = sanitizedProcessEnv({
        [REDCODE_PROCESS_ROLE]: "worker",
        [REDCODE_RUN_ID]: ensureRunID(),
      })

      const worker = new Worker(file, {
        env,
      })
      worker.onerror = (e) => {
        Log.Default.error("thread error", {
          message: e.message,
          filename: e.filename,
          lineno: e.lineno,
          colno: e.colno,
          error: e.error,
        })
      }

      const client = Rpc.client<typeof rpc>(worker)
      const error = (e: unknown) => {
        Log.Default.error("process error", { error: errorMessage(e) })
      }
      const reload = () => {
        client.call("reload", undefined).catch((err) => {
          Log.Default.warn("worker reload failed", {
            error: errorMessage(err),
          })
        })
      }
      process.on("uncaughtException", error)
      process.on("unhandledRejection", error)
      process.on("SIGUSR2", reload)

      let stopped = false
      const stop = async () => {
        if (stopped) return
        stopped = true
        process.off("uncaughtException", error)
        process.off("unhandledRejection", error)
        process.off("SIGUSR2", reload)
        await withTimeout(client.call("shutdown", undefined), 5000).catch((error) => {
          Log.Default.warn("worker shutdown failed", {
            error: errorMessage(error),
          })
        })
        worker.terminate()
      }

      const prompt = await input(args.prompt)
      const config = await TuiConfig.get(cwd)

      const network = resolveNetworkOptionsNoConfig(args)
      const external =
        process.argv.includes("--port") ||
        process.argv.includes("--hostname") ||
        process.argv.includes("--mdns") ||
        network.mdns ||
        network.port !== 0 ||
        network.hostname !== "127.0.0.1"

      const transport = external
        ? {
            url: (await client.call("server", network)).url,
            fetch: undefined,
            events: undefined,
          }
        : {
            url: "http://redcode.internal",
            fetch: createWorkerFetch(client),
            events: createEventSource(client),
          }

      try {
        await validateSession({
          url: transport.url,
          sessionID: args.session,
          directory: cwd,
          fetch: transport.fetch,
        })
      } catch (error) {
        UI.error(errorMessage(error))
        process.exitCode = 1
        return
      }

      if (cwd) {
        setTimeout(() => {
          client.call("checkUpgrade", { directory: cwd }).catch(() => {})
        }, 1000).unref?.()
      }

      try {
        const { tui } = await import("./app")
        await tui({
          url: transport.url,
          async onSnapshot() {
            const tui = writeHeapSnapshot("tui.heapsnapshot")
            const server = await client.call("snapshot", undefined)
            return [tui, server]
          },
          config,
          directory: cwd,
          local: true,
          fetch: transport.fetch,
          events: transport.events,
          args: {
            continue: args.continue,
            sessionID: args.session,
            agent: args.agent,
            model: args.model,
            prompt,
            fork: args.fork,
          },
        })
      } finally {
        await stop()
      }
    } finally {
      unguard?.()
    }
    process.exit(0)
  },
})
// scratch
