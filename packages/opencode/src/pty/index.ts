import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { BackgroundStore } from "@/background/store"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import { spawn as cpSpawn } from "child_process"
import { lazy } from "@redcode-ai/core/util/lazy"
import { Plugin } from "@/plugin"
import { Shell } from "@/shell/shell"
import type { Proc } from "#pty"
import * as Log from "@redcode-ai/core/util/log"
import { PtyID } from "./schema"
import { Effect, Layer, Context, Option, Schema, Types } from "effect"
import { NonNegativeInt, PositiveInt } from "@redcode-ai/core/schema"

const log = Log.create({ service: "pty" })

const BUFFER_LIMIT = 1024 * 1024 * 2
const BUFFER_CHUNK = 64 * 1024
// 261105 Red PTY 终端登记落盘：与任务快照共用 background 目录但单列文件（namespace 隔离）。
// 孤儿记录条数与 store 的完成态上限同口径。决策见
// docs/notes/implemented/feature/2026-11-04-background-center.md
const PTY_NAMESPACE = "pty"
const ORPHAN_KEEP = 50
const encoder = new TextEncoder()

type Socket = {
  readyState: number
  data?: unknown
  send: (data: string | Uint8Array | ArrayBuffer) => void
  close: (code?: number, reason?: string) => void
}

const sock = (ws: Socket) => (ws.data && typeof ws.data === "object" ? ws.data : ws)

// 261105 Red pty 登记与 store Entry 的互转：定位字段进 metadata，快照只存运行中的
// 终端与待再见的孤儿记录，不含输出缓冲。
function toEntry(info: Info, started_at: number): BackgroundStore.Entry {
  return {
    id: info.id,
    type: "pty",
    title: info.title,
    status: "running",
    started_at,
    metadata: { command: info.command, args: info.args, cwd: info.cwd, pid: info.pid },
  }
}

function orphanFromEntry(record: BackgroundStore.Entry): Orphan | undefined {
  // store.read 已在边界处校验过 Entry 的基础字段；metadata 是各 namespace 自己的载荷，
  // 这里继续按 PTY 的形状逐项校验，不往服务内部传未知值。
  const meta = record.metadata
  if (!meta || typeof meta !== "object") return undefined
  const { pid, command, args, cwd } = meta as Record<string, unknown>
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined
  if (typeof command !== "string" || typeof cwd !== "string") return undefined
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) return undefined
  if (typeof record.id !== "string" || !record.id.startsWith("pty")) return undefined
  const info: Info = {
    id: PtyID.ascending(record.id),
    title: typeof record.title === "string" ? record.title : `Terminal ${record.id.slice(-4)}`,
    command,
    args: args as string[],
    cwd,
    status: "orphaned",
    pid,
  }
  return { info, started_at: record.started_at }
}

// 261105 Red 审计 RC-015-05：taskkill 的可等待版本。退出码 0 = 成功；非 0 交给存活
// 探测复核（进程可能已自行退出）；超时/null 也走复核，不把「没等到」当成「已结束」。
const TEARDOWN_TIMEOUT = 5_000

function taskkill(pid: number) {
  return Effect.promise(
    () =>
      new Promise<number | null>((resolve) => {
        const child = cpSpawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
          stdio: "ignore",
          windowsHide: true,
        })
        child.once("error", () => resolve(null))
        child.once("exit", (code) => resolve(code))
      }),
  ).pipe(
    Effect.timeoutOption(TEARDOWN_TIMEOUT),
    Effect.map((result) => (Option.isSome(result) ? result.value : null)),
  )
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程存在但无权探测；只有 ESRCH（找不到）才算结束。
    return (error as NodeJS.ErrnoException)?.code === "EPERM"
  }
}

type Active = {
  info: Info
  started_at: number
  process: Proc
  buffer: string
  bufferCursor: number
  cursor: number
  subscribers: Map<unknown, Socket>
}

// 261105 Red 从快照恢复的孤儿登记：进程随上次退出失去归属（Unix 下可能仍在跑），
// 只在内存里挂到本次 list；快照侧保持 running，重复重启仍可见，直到被 finalizer 清空。
type Orphan = {
  info: Info
  started_at: number
}

type State = {
  dir: string
  store: string
  sessions: Map<PtyID, Active>
  orphans: Map<PtyID, Orphan>
}

// WebSocket control frame: 0x00 + UTF-8 JSON.
const meta = (cursor: number) => {
  const json = JSON.stringify({ cursor })
  const bytes = encoder.encode(json)
  const out = new Uint8Array(bytes.length + 1)
  out[0] = 0
  out.set(bytes, 1)
  return out
}

const pty = lazy(() => import("#pty"))

export const Info = Schema.Struct({
  id: PtyID,
  title: Schema.String,
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  // 261105 Red orphaned：上次进程退出时仍在运行的终端登记，重启后从快照恢复。
  // 进程本身状态未知（可能仍是孤儿），不用 exited 撒谎；只展示、不可终止（PID 可能已被复用）。
  status: Schema.Literals(["running", "exited", "orphaned"]),
  pid: PositiveInt,
}).annotate({ identifier: "Pty" })

export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Info>>

export const CreateInput = Schema.Struct({
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})

export type CreateInput = Types.DeepMutable<Schema.Schema.Type<typeof CreateInput>>

export const UpdateInput = Schema.Struct({
  title: Schema.optional(Schema.String),
  size: Schema.optional(
    Schema.Struct({
      rows: PositiveInt,
      cols: PositiveInt,
    }),
  ),
})

export type UpdateInput = Types.DeepMutable<Schema.Schema.Type<typeof UpdateInput>>

export const Event = {
  Created: BusEvent.define("pty.created", Schema.Struct({ info: Info })),
  Updated: BusEvent.define("pty.updated", Schema.Struct({ info: Info })),
  Exited: BusEvent.define("pty.exited", Schema.Struct({ id: PtyID, exitCode: NonNegativeInt })),
  Deleted: BusEvent.define("pty.deleted", Schema.Struct({ id: PtyID })),
}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: PtyID) => Effect.Effect<Info | undefined>
  readonly create: (input: CreateInput) => Effect.Effect<Info>
  readonly update: (id: PtyID, input: UpdateInput) => Effect.Effect<Info | undefined>
  // 261105 Red 返回终止结果：false = 进程可能仍存活、登记保留，API 层如实透传。
  readonly remove: (id: PtyID) => Effect.Effect<boolean>
  readonly resize: (id: PtyID, cols: number, rows: number) => Effect.Effect<void>
  readonly write: (id: PtyID, data: string) => Effect.Effect<void>
  readonly connect: (
    id: PtyID,
    ws: Socket,
    cursor?: number,
  ) => Effect.Effect<{ onMessage: (message: string | ArrayBuffer) => void; onClose: () => void } | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@redcode/Pty") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const plugin = yield* Plugin.Service

    // 260625 Red fix: Windows 上用 taskkill /T 杀整棵进程树，防止 shell 子进程泄漏。
    // 261105 Red 审计 RC-015-05：终止必须等到结果——返回 false 表示进程可能仍存活，
    // 调用方不能删登记，否则面板上看不到它、实际进程还在跑。
    const stop = Effect.fn("Pty.stop")(function* (session: Active) {
      let stopped = true
      if (session.info.status !== "exited") {
        if (process.platform === "win32" && session.process.pid) {
          const pid = session.process.pid
          const code = yield* taskkill(pid)
          stopped = code === 0 || !alive(pid)
          if (!stopped) log.warn("taskkill did not confirm termination", { pid, exitCode: code })
        } else {
          try {
            session.process.kill()
          } catch (error) {
            // 261105 Red kill 抛错不再当作成功：ESRCH 表示进程已经不在（目标达成），
            // 其余（EPERM 等）保留 stopped=false，让调用方保留登记而不是谎报已终止。
            const code = (error as NodeJS.ErrnoException)?.code
            if (code !== "ESRCH") {
              stopped = false
              log.warn("process kill failed; termination not confirmed", { pid: session.process.pid, code })
            }
          }
        }
      }
      for (const [sub, ws] of session.subscribers.entries()) {
        try {
          if (sock(ws) === sub) ws.close()
        } catch {
          // 261015 Red 单个 socket 已关闭/已断开 → 跳过它，继续关其余订阅者
        }
      }
      session.subscribers.clear()
      return stopped
    })

    const state = yield* InstanceState.make<State>(
      Effect.fn("Pty.state")(function* (ctx) {
        // 261105 Red 启动时读回上次的终端登记：崩溃/硬杀退出时没机会走 remove 的记录
        // 归位成 orphaned——面板要能看见「上次还有个终端没关」。正常退出走 finalizer
        // 清空快照，不会产生假孤儿。
        const store = yield* BackgroundStore.directory
        const snapshot = yield* BackgroundStore.read(store, ctx.directory, PTY_NAMESPACE)
        const orphans = new Map<PtyID, Orphan>()
        const stale = (snapshot?.records ?? [])
          .filter((record) => record.status === "running")
          .sort((a, b) => a.started_at - b.started_at)
          .slice(-ORPHAN_KEEP)
        for (const record of stale) {
          const orphan = orphanFromEntry(record)
          if (orphan) orphans.set(orphan.info.id, orphan)
        }

        const state: State = {
          dir: ctx.directory,
          store,
          sessions: new Map<PtyID, Active>(),
          orphans,
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            // 261105 Red teardown 杀掉全部终端后把快照一并清空：孤儿记录只在进程来不及
            // 清理（崩溃、硬杀）时出现，干净退出/状态被 LRU 回收（cap 10）不留旧记录。
            // 261105 Red 审计 RC-015-05：终止未确认的终端保留登记，下次启动以孤儿身份
            // 继续可见；不能因为实例被回收就把还活着的进程从记录里抹掉。
            const remaining: BackgroundStore.Entry[] = []
            for (const session of state.sessions.values()) {
              if (!(yield* stop(session))) remaining.push(toEntry(session.info, session.started_at))
            }
            state.sessions.clear()
            yield* BackgroundStore.write(store, ctx.directory, remaining, PTY_NAMESPACE)
          }),
        )

        return state
      }),
      // 260916 Red 与 MCP 同理：PTY 是子进程，服务端实例无上限时不活跃目录的终端永不回收。
      10,
    )

    // 261105 Red 当前登记写进快照：运行中的终端 + 已恢复的孤儿记录（保持 running，
    // 重复重启仍可见）。写失败由 store 内部记日志，不影响终端本身。
    const persist = Effect.fn("Pty.persist")(function* () {
      const s = yield* InstanceState.get(state)
      const entries = [
        ...Array.from(s.sessions.values(), (session) => toEntry(session.info, session.started_at)),
        ...Array.from(s.orphans.values(), (orphan) => toEntry(orphan.info, orphan.started_at)),
      ]
      yield* BackgroundStore.write(s.store, s.dir, entries, PTY_NAMESPACE)
    })

    const remove = Effect.fn("Pty.remove")(function* (id: PtyID) {
      const s = yield* InstanceState.get(state)
      const session = s.sessions.get(id)
      // 261105 Red 不存在视为已删除（幂等），与旧 void 行为对调用方等价。
      if (!session) return true
      // 261105 Red 审计 RC-015-05：先确认终止再删登记。此前先删记录再发起 taskkill，
      // 杀失败时面板已经看不到这个终端，实际进程还在跑。
      if (!(yield* stop(session))) {
        log.warn("terminal termination not confirmed; keeping record", { id, pid: session.info.pid })
        return false
      }
      s.sessions.delete(id)
      // 261105 Red 终端退场即删记录：正常退出不留痕，孤儿只来自没机会走 remove 的崩溃。
      yield* persist()
      log.info("removing session", { id })
      yield* bus.publish(Event.Deleted, { id: session.info.id })
      return true
    })

    const list = Effect.fn("Pty.list")(function* () {
      const s = yield* InstanceState.get(state)
      return [
        ...Array.from(s.sessions.values()).map((session) => session.info),
        ...Array.from(s.orphans.values()).map((orphan) => orphan.info),
      ]
    })

    const get = Effect.fn("Pty.get")(function* (id: PtyID) {
      const s = yield* InstanceState.get(state)
      return s.sessions.get(id)?.info ?? s.orphans.get(id)?.info
    })

    const create = Effect.fn("Pty.create")(function* (input: CreateInput) {
      const s = yield* InstanceState.get(state)
      const bridge = yield* EffectBridge.make()
      const cfg = yield* config.get()
      const id = PtyID.ascending()
      const command = input.command || Shell.preferred(cfg.shell)
      const args = input.args || []
      if (Shell.login(command)) {
        args.push("-l")
      }

      const cwd = input.cwd || s.dir
      const shell = yield* plugin.trigger("shell.env", { cwd }, { env: {} })
      const env = {
        ...process.env,
        ...input.env,
        ...shell.env,
        TERM: "xterm-256color",
        REDCODE_TERMINAL: "1",
      } as Record<string, string>

      if (process.platform === "win32") {
        env.LC_ALL = "C.UTF-8"
        env.LC_CTYPE = "C.UTF-8"
        env.LANG = "C.UTF-8"
      }
      log.info("creating session", { id, cmd: command, args, cwd })

      const { spawn } = yield* Effect.promise(() => pty())
      const proc = yield* Effect.sync(() =>
        spawn(command, args, {
          name: "xterm-256color",
          cwd,
          env,
        }),
      )

      const info = {
        id,
        title: input.title || `Terminal ${id.slice(-4)}`,
        command,
        args,
        cwd,
        status: "running",
        pid: proc.pid,
      } as const
      const started_at = Date.now()
      const session: Active = {
        info,
        started_at,
        process: proc,
        buffer: "",
        bufferCursor: 0,
        cursor: 0,
        subscribers: new Map(),
      }
      s.sessions.set(id, session)
      // 261105 Red 审计 RC-015-03：监听必须在异步落盘之前挂好——短生命周期进程可能在
      // persist 的磁盘 I/O 期间退出，退出事件不重放，登记就会永远停在 running。
      proc.onData((chunk) => {
        session.cursor += chunk.length

        for (const [key, ws] of session.subscribers.entries()) {
          if (ws.readyState !== 1) {
            session.subscribers.delete(key)
            continue
          }
          if (sock(ws) !== key) {
            session.subscribers.delete(key)
            continue
          }
          try {
            ws.send(chunk)
          } catch {
            session.subscribers.delete(key)
          }
        }

        session.buffer += chunk
        if (session.buffer.length <= BUFFER_LIMIT) return
        const excess = session.buffer.length - BUFFER_LIMIT
        session.buffer = session.buffer.slice(excess)
        session.bufferCursor += excess
      })
      proc.onExit(({ exitCode }) => {
        if (session.info.status === "exited") return
        log.info("session exited", { id, exitCode })
        session.info.status = "exited"
        bridge.fork(bus.publish(Event.Exited, { id, exitCode }))
        bridge.fork(remove(id))
      })
      yield* persist()
      yield* bus.publish(Event.Created, { info })
      return info
    })

    const update = Effect.fn("Pty.update")(function* (id: PtyID, input: UpdateInput) {
      const s = yield* InstanceState.get(state)
      const session = s.sessions.get(id)
      if (!session) return
      if (input.title) {
        session.info.title = input.title
        // 261105 Red 标题是快照的定位字段，改了要跟着落盘；resize 不落盘。
        yield* persist()
      }
      if (input.size) {
        session.process.resize(input.size.cols, input.size.rows)
      }
      yield* bus.publish(Event.Updated, { info: session.info })
      return session.info
    })

    const resize = Effect.fn("Pty.resize")(function* (id: PtyID, cols: number, rows: number) {
      const s = yield* InstanceState.get(state)
      const session = s.sessions.get(id)
      if (session && session.info.status === "running") {
        session.process.resize(cols, rows)
      }
    })

    const write = Effect.fn("Pty.write")(function* (id: PtyID, data: string) {
      const s = yield* InstanceState.get(state)
      const session = s.sessions.get(id)
      if (session && session.info.status === "running") {
        session.process.write(data)
      }
    })

    const connect = Effect.fn("Pty.connect")(function* (id: PtyID, ws: Socket, cursor?: number) {
      const s = yield* InstanceState.get(state)
      const session = s.sessions.get(id)
      if (!session) {
        ws.close()
        return
      }
      log.info("client connected to session", { id })

      const sub = sock(ws)
      session.subscribers.delete(sub)
      session.subscribers.set(sub, ws)

      const cleanup = () => {
        session.subscribers.delete(sub)
      }

      const start = session.bufferCursor
      const end = session.cursor
      const from =
        cursor === -1 ? end : typeof cursor === "number" && Number.isSafeInteger(cursor) ? Math.max(0, cursor) : 0

      const data = (() => {
        if (!session.buffer) return ""
        if (from >= end) return ""
        const offset = Math.max(0, from - start)
        if (offset >= session.buffer.length) return ""
        return session.buffer.slice(offset)
      })()

      if (data) {
        try {
          for (let i = 0; i < data.length; i += BUFFER_CHUNK) {
            ws.send(data.slice(i, i + BUFFER_CHUNK))
          }
        } catch {
          cleanup()
          ws.close()
          return
        }
      }

      try {
        ws.send(meta(end))
      } catch {
        cleanup()
        ws.close()
        return
      }

      return {
        onMessage: (message: string | ArrayBuffer) => {
          session.process.write(typeof message === "string" ? message : new TextDecoder().decode(message))
        },
        onClose: () => {
          log.info("client disconnected from session", { id })
          cleanup()
        },
      }
    })

    return Service.of({ list, get, create, update, remove, resize, write, connect })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Bus.layer),
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(Config.defaultLayer),
)

export * as Pty from "."
