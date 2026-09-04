import { Effect, Layer, Context, Schema } from "effect"
import { Bus } from "@/bus"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID } from "./schema"
import * as Log from "@redcode-ai/core/util/log"

const log = Log.create({ service: "session.summary" })

// 260904 cc (from,to) 指纹短路用的进程内小缓存（A1 第 2 步）。
// git tree 是内容寻址的：工作树没变，write-tree 给同一个 hash；diffFull(from,to) 只读两棵 tree、
// 不碰工作树 —— (from,to) 不变 ⇒ 结果必然不变。summarize 每个 step-finish 跑一次
// （processor.ts 的 step-finish 分支），一轮里多数 step 只读不写，指纹命中是常态。
// 对抗审查点出来的三个坑，这里逐条避开：
//   · 不 memo sessionFrom 本身——每次都从 parts 重新扫 from/to，新会话不会被钉成 undefined
//   · 只在 diffFull 成功后写 memo——快照被 gc 掉时 diffFull 显式失败（DiffError），[] 不会被固化
//   · 有界：会话级条目挂着整份 diffs（病态会话 30MB+），LRU 只留 4 个；turn 级只存两个 hash
export function createSpanMemo<K, V extends { from: string; to: string }>(limit: number) {
  const map = new Map<K, V>()
  return {
    /** (from,to) 完全相同才算命中；命中顺带刷新 LRU 位置 */
    hit(key: K, span: { from: string; to: string }): V | undefined {
      const cur = map.get(key)
      if (!cur || cur.from !== span.from || cur.to !== span.to) return undefined
      map.delete(key)
      map.set(key, cur)
      return cur
    },
    set(key: K, value: V) {
      map.delete(key)
      map.set(key, value)
      while (map.size > limit) {
        for (const oldest of map.keys()) {
          map.delete(oldest)
          break
        }
      }
    },
    delete(key: K) {
      map.delete(key)
    },
    get size() {
      return map.size
    },
  }
}

const sessionSpans = createSpanMemo<SessionID, { from: string; to: string; diffs: Snapshot.FileDiff[] }>(4)
const turnSpans = createSpanMemo<MessageID, { from: string; to: string }>(256)

/**
 * revert 之后 session_diff 文件已被改写成「revert 点起的范围 diff」（revert.ts），会话级 memo 必须失效：
 * 否则下一步若 (from,to) 恰好命中旧条目，会跳过文件重写，留下文件与总线事件不一致。
 * turn 级不用失效——它守的是消息行内容，与 revert 写的文件无关。
 */
export function invalidate(sessionID: SessionID) {
  sessionSpans.delete(sessionID)
}

/** 从消息 parts 里取 diff 端点：会话/本轮的首个 step-start.snapshot 当 from，最后一个 step-finish.snapshot 当 to */
function endpoints(messages: MessageV2.WithParts[]) {
  let from: string | undefined
  let to: string | undefined
  for (const item of messages) {
    if (!from) {
      for (const part of item.parts) {
        if (part.type === "step-start" && part.snapshot) {
          from = part.snapshot
          break
        }
      }
    }
    for (const part of item.parts) {
      if (part.type === "step-finish" && part.snapshot) to = part.snapshot
    }
  }
  return from && to ? { from, to } : undefined
}

function unquoteGitPath(input: string) {
  if (!input.startsWith('"')) return input
  if (!input.endsWith('"')) return input
  const body = input.slice(1, -1)
  const bytes: number[] = []

  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0))
      continue
    }

    const next = body[i + 1]
    if (!next) {
      bytes.push("\\".charCodeAt(0))
      continue
    }

    if (next >= "0" && next <= "7") {
      const chunk = body.slice(i + 1, i + 4)
      const match = chunk.match(/^[0-7]{1,3}/)
      if (!match) {
        bytes.push(next.charCodeAt(0))
        i++
        continue
      }
      bytes.push(parseInt(match[0], 8))
      i += match[0].length
      continue
    }

    const escaped =
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === "v"
                  ? "\v"
                  : next === "\\" || next === '"'
                    ? next
                    : undefined

    bytes.push((escaped ?? next).charCodeAt(0))
    i++
  }

  return Buffer.from(bytes).toString()
}

export interface Interface {
  readonly summarize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
  readonly diff: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Snapshot.FileDiff[]>
  readonly computeDiff: (
    input: { messages: MessageV2.WithParts[] },
  ) => Effect.Effect<Snapshot.FileDiff[], Snapshot.DiffError>
}

export class Service extends Context.Service<Service, Interface>()("@redcode/SessionSummary") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snapshot = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const bus = yield* Bus.Service

    const computeDiff = Effect.fn("SessionSummary.computeDiff")(function* (input: { messages: MessageV2.WithParts[] }) {
      const span = endpoints(input.messages)
      if (!span) return []
      return yield* snapshot.diffFull(span.from, span.to)
    })

    const summarize = Effect.fn("SessionSummary.summarize")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      if (!all.length) return

      const sessionSpan = endpoints(all)
      const sessionHit = sessionSpan ? sessionSpans.hit(input.sessionID, sessionSpan) : undefined
      if (sessionHit) {
        // 指纹命中：不重算、不写 session 摘要（跨进程别用陈值覆盖新值）、不重写 session_diff 文件。
        // 但**照发**事件——TUI 的 session_diff store 只靠这条事件填充（tui/context/sync.tsx 的
        // "session.diff" 分支，没有 fetch 兜底），后接入的客户端等的就是它。
        yield* bus.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: sessionHit.diffs })
      } else {
        // 260904 cc 快照 tree 被 gc 掉时 diffFull 现在会显式失败（见 snapshot/index.ts 的 DiffError）。
        // 这里的正确动作是**什么都不写**：session 上的 additions/deletions/files 保持上一次的真值，
        // 而不是像以前那样拿一个空数组把它们抹成 0。
        const diffs = yield* computeDiff({ messages: all }).pipe(
          Effect.catchTag("SnapshotDiffError", (e) => {
            log.warn("session diff skipped: snapshot missing", { sessionID: input.sessionID, from: e.from, to: e.to })
            return Effect.succeed(undefined)
          }),
        )
        if (!diffs) return
        yield* sessions.setSummary({
          sessionID: input.sessionID,
          summary: {
            additions: diffs.reduce((sum, x) => sum + x.additions, 0),
            deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
            files: diffs.length,
          },
        })
        yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
        yield* bus.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
        if (sessionSpan) sessionSpans.set(input.sessionID, { ...sessionSpan, diffs })
      }

      const messages = all.filter(
        (m) => m.info.id === input.messageID || (m.info.role === "assistant" && m.info.parentID === input.messageID),
      )
      const target = messages.find((m) => m.info.id === input.messageID)
      if (!target || target.info.role !== "user") return
      // 本轮 (from,to) 没变 ⇒ 消息行里的 summary.diffs 不会变：跳过整行重写（病态行 32MB 一次 129ms）
      // 与随之而来的 message.updated 大 payload。后接入的客户端从库里读消息，不依赖这条事件。
      const turnSpan = endpoints(messages)
      if (turnSpan && turnSpans.hit(input.messageID, turnSpan)) return
      const msgDiffs = yield* computeDiff({ messages }).pipe(
        Effect.catchTag("SnapshotDiffError", (e) => {
          log.warn("turn diff skipped: snapshot missing", { messageID: input.messageID, from: e.from, to: e.to })
          return Effect.succeed(undefined)
        }),
      )
      if (!msgDiffs) return
      target.info.summary = { ...target.info.summary, diffs: msgDiffs }
      yield* sessions.updateMessage(target.info)
      if (turnSpan) turnSpans.set(input.messageID, turnSpan)
    })

    const diff = Effect.fn("SessionSummary.diff")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      const diffs = yield* storage
        .read<Snapshot.FileDiff[]>(["session_diff", input.sessionID])
        .pipe(Effect.catch(() => Effect.succeed([] as Snapshot.FileDiff[])))
      const next = diffs.map((item) => {
        if (item.file === undefined) return item
        const file = unquoteGitPath(item.file)
        if (file === item.file) return item
        return { ...item, file }
      })
      const changed = next.some((item, i) => item.file !== diffs[i]?.file)
      if (changed) yield* storage.write(["session_diff", input.sessionID], next).pipe(Effect.ignore)
      return next
    })

    return Service.of({ summarize, diff, computeDiff })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(Bus.layer),
  ),
)

export const DiffInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
})
export type DiffInput = Schema.Schema.Type<typeof DiffInput>

export * as SessionSummary from "./summary"
