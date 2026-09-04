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
//   · 有界：两级都只存两个 hash（会话级命中不再照发事件，见 summarize），LRU 各 256
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

const sessionSpans = createSpanMemo<SessionID, { from: string; to: string }>(256)
const turnSpans = createSpanMemo<MessageID, { from: string; to: string }>(256)

// 260904 cc A1 第 3 步：一份 diffs 里 patch 正文的总字节上限。只对新写入生效，存量不动。
// 副本实测（1,920 条带 diffs 的 user 行）：本轮 patch 总量 p50 14KB / p90 158KB / p99 1.0MB / 最大 30.7MB；
// 最大那条是 6,526 个文件、单文件最大 377KB —— snapshot 里那道 256KB 的单文件上限管不住「文件多」，
// 所以这里按总量管。1MB 只碰 1.1% 的轮次、却拿掉 28% 的字节；会话级累计更大，给 4 倍。
// 超限时**不丢文件**：file/additions/deletions/status 全留，只把最大的几个 patch 清成 ""——
// "" 是 snapshot 对二进制 / 超大文件早就在用的「没有正文」记号，UI 两侧都认（app/utils/diffs.ts 要求
// patch 是 string；ui/session-diff.ts 对 "" 给空 fileDiff）。
export const MAX_TURN_PATCH_BYTES = 1024 * 1024
export const MAX_SESSION_PATCH_BYTES = 4 * 1024 * 1024

export function capPatches(diffs: Snapshot.FileDiff[], limit: number): Snapshot.FileDiff[] {
  const sizes = diffs.map((item) => (item.patch ? Buffer.byteLength(item.patch) : 0))
  let total = sizes.reduce((sum, n) => sum + n, 0)
  if (total <= limit) return diffs
  const order = sizes
    .map((n, i) => i)
    .filter((i) => sizes[i]! > 0)
    .sort((a, b) => sizes[b]! - sizes[a]!)
  const drop = new Set<number>()
  for (const i of order) {
    if (total <= limit) break
    drop.add(i)
    total -= sizes[i]!
  }
  log.info("patch budget exceeded, blanking largest patches", { files: diffs.length, blanked: drop.size, limit })
  return diffs.map((item, i) => (drop.has(i) ? { ...item, patch: "" } : item))
}

/**
 * revert 之后 session_diff 文件已被改写成「revert 点起的范围 diff」（revert.ts），会话级 memo 必须失效：
 * 否则下一步若 (from,to) 恰好命中旧条目，会跳过文件重写，留下文件与总线事件不一致。
 * turn 级不用失效——它守的是消息行内容，与 revert 写的文件无关。
 */
export function invalidate(sessionID: SessionID) {
  sessionSpans.delete(sessionID)
}

/** 同 endpoints()，但吃 MessageV2.snapshotParts 的行（已按消息序、分片序排好）。两者语义必须一致。 */
function spanOf(rows: MessageV2.SnapshotPartRow[]) {
  let from: string | undefined
  let to: string | undefined
  for (const row of rows) {
    if (!from && row.type === "step-start") from = row.snapshot
    if (row.type === "step-finish") to = row.snapshot
  }
  return from && to ? { from, to } : undefined
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
  /** `patch: false` 只回 file/additions/deletions/status（TUI 进会话填侧栏用，病态会话那份 33MB 的正文一个字节不传） */
  readonly diff: (input: {
    sessionID: SessionID
    messageID?: MessageID
    patch?: boolean
  }) => Effect.Effect<Snapshot.FileDiff[]>
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

    // 260904 cc 快照 tree 被 gc 掉时 diffFull 显式失败（见 snapshot/index.ts 的 DiffError）：
    // 正确动作是什么都不写，别拿空数组把统计抹成 0。两处 catch 共用这一个。
    // from === to 是空 diff 的恒等式（同一棵 tree），不值得起 2 个 git 进程去证明。
    const diffSpan = (span: { from: string; to: string } | undefined, what: string, id: string) =>
      span && span.from !== span.to
        ? snapshot.diffFull(span.from, span.to).pipe(
            Effect.catchTag("SnapshotDiffError", (e) => {
              log.warn(`${what} diff skipped: snapshot missing`, { id, from: e.from, to: e.to })
              return Effect.succeed(undefined)
            }),
          )
        : Effect.succeed([] as Snapshot.FileDiff[])

    const summarize = Effect.fn("SessionSummary.summarize")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      // 260904 cc A1-2b：不再 Session.messages() 全量加载。端点只要 step 分片里的两个哈希，
      // 由 snapshotParts 一条查询给出（user 行的 diffs blob 一个字节不碰）；目标 user 消息的整行
      // 只在真要重写它时才加载（见下）。
      const rows = yield* MessageV2.snapshotParts(input.sessionID)
      const sessionSpan = spanOf(rows)
      // 指纹命中：不重算、不写 session 摘要（跨进程别用陈值覆盖新值）、不重写 session_diff 文件，
      // 也**不再照发** Session.Event.Diff——A1 第 2 步时照发是因为 TUI 的 session_diff store 只靠事件
      // 填充；现在 TUI 进会话自己 fetch（patch=false），GUI 一直有 fetch 兜底，后接入的客户端不等它了。
      // 事件只在 diff 真变了才发，SSE 上那份 30MB 级 stringify ×2/订阅者 随之消失。
      if (!(sessionSpan && sessionSpans.hit(input.sessionID, sessionSpan))) {
        const full = yield* diffSpan(sessionSpan, "session", input.sessionID)
        if (!full) return
        // 统计从完整结果算；上限只清 patch 正文，不动文件条目与增删数
        const diffs = capPatches(full, MAX_SESSION_PATCH_BYTES)
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
        if (sessionSpan) sessionSpans.set(input.sessionID, sessionSpan)
      }

      // 本轮 = 目标 user 消息 + parentID 指向它的 assistant 消息（每 step 一条，prompt.ts 的循环里建）。
      // user 消息本身没有 step 分片，所以本轮端点全部来自那些 assistant 行。
      const turnSpan = spanOf(rows.filter((row) => row.parentID === input.messageID))
      // 本轮 (from,to) 没变 ⇒ 消息行里的 summary.diffs 不会变：跳过整行重写（病态行 32MB 一次 129ms）
      // 与随之而来的 message.updated 大 payload。后接入的客户端从库里读消息，不依赖这条事件。
      // 命中时连目标行都不用加载。
      if (turnSpan && turnSpans.hit(input.messageID, turnSpan)) return
      const target = yield* MessageV2.get({ sessionID: input.sessionID, messageID: input.messageID }).pipe(
        Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
      )
      if (!target || target.info.role !== "user") return
      const msgDiffs = yield* diffSpan(turnSpan, "turn", input.messageID)
      if (!msgDiffs) return
      target.info.summary = { ...target.info.summary, diffs: capPatches(msgDiffs, MAX_TURN_PATCH_BYTES) }
      yield* sessions.updateMessage(target.info)
      if (turnSpan) turnSpans.set(input.messageID, turnSpan)
    })

    const diff = Effect.fn("SessionSummary.diff")(function* (input: {
      sessionID: SessionID
      messageID?: MessageID
      patch?: boolean
    }) {
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
      if (input.patch === false) return next.map(({ patch: _, ...rest }) => rest)
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
