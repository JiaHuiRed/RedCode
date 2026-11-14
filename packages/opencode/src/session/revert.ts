import { Effect, Layer, Context, Schema } from "effect"
import { Bus } from "../bus"
import { Snapshot } from "../snapshot"
import { Storage } from "@/storage/storage"
import { Database } from "@/storage/db"
import { sql } from "drizzle-orm"
import { MessageTable } from "./session.sql"
import { SyncEvent } from "../sync"
import * as Log from "@redcode-ai/core/util/log"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import * as ContextCompaction from "./context-compaction"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionRunState } from "./run-state"
import { SessionSummary } from "./summary"

const log = Log.create({ service: "session.revert" })

export const RevertInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: Schema.optional(PartID),
})
export type RevertInput = Schema.Schema.Type<typeof RevertInput>

export interface Interface {
  readonly revert: (input: RevertInput) => Effect.Effect<Session.Info, Session.BusyError>
  readonly unrevert: (input: { sessionID: SessionID }) => Effect.Effect<Session.Info, Session.BusyError>
  readonly cleanup: (session: Session.Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@redcode/SessionRevert") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snap = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const bus = yield* Bus.Service
    const summary = yield* SessionSummary.Service
    const state = yield* SessionRunState.Service
    const sync = yield* SyncEvent.Service

    const revert = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
      yield* state.assertNotBusy(input.sessionID)
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
      let lastUser: MessageV2.User | undefined
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)

      let rev: Session.Info["revert"]
      const patches: Snapshot.Patch[] = []
      for (const msg of all) {
        if (msg.info.role === "user") lastUser = msg.info
        const remaining = []
        for (const part of msg.parts) {
          if (rev) {
            if (part.type === "patch") patches.push(part)
            continue
          }

          if (!rev) {
            if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
              const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
              rev = {
                messageID: !partID && lastUser ? lastUser.id : msg.info.id,
                partID,
              }
            }
            remaining.push(part)
          }
        }
      }

      if (!rev) return session

      rev.snapshot = session.revert?.snapshot ?? (yield* snap.track())
      if (session.revert?.snapshot) yield* snap.restore(session.revert.snapshot)
      yield* snap.revert(patches)
      if (rev.snapshot) rev.diff = yield* snap.diff(rev.snapshot)
      // 260814 Red 范围改按 created 截断（ID 回绕后字典序失真）。all 按 created 升序、
      // revert 点消息必在其中，从它（含）截到末尾。
      const revertIndex = all.findIndex((msg) => msg.info.id === rev.messageID)
      const range = revertIndex >= 0 ? all.slice(revertIndex) : []
      // 260904 cc computeDiff 现在会在快照 tree 缺失时显式失败。revert 这里已经把工作树改回去了，
      // 摘要只是附带产物：拿不到就按空处理（与改前行为一致），别让一次 gc 把整个 revert 打回。
      const diffs = yield* summary
        .computeDiff({ messages: range })
        .pipe(Effect.catchTag("SnapshotDiffError", () => Effect.succeed([] as Snapshot.FileDiff[])))
      // 260904 cc 会话级 patch 正文上限与 summarize 同一道（只清正文，不动条目与增删数）
      const capped = SessionSummary.capPatches(diffs, SessionSummary.MAX_SESSION_PATCH_BYTES)
      yield* storage.write(["session_diff", input.sessionID], capped).pipe(Effect.ignore)
      // 260904 cc 文件刚被改写成 revert 点起的范围 diff，会话级指纹 memo 必须失效（见 summary.ts invalidate）
      SessionSummary.invalidate(input.sessionID)
      yield* bus.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: capped })
      yield* sessions.setRevert({
        sessionID: input.sessionID,
        revert: rev,
        summary: {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        },
      })
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const unrevert = Effect.fn("SessionRevert.unrevert")(function* (input: { sessionID: SessionID }) {
      log.info("unreverting", input)
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (!session.revert) return session
      if (session.revert.snapshot) yield* snap.restore(session.revert.snapshot)
      yield* sessions.clearRevert(input.sessionID)
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    // 261114 Red 2d 分离弃岛（决策：docs/notes/proposed/feature/2026-11-14-message-tree-branching.md）：
    // cleanup 从「物理删行」收敛为「分岛」——弃岛（revert 点起的消息链）保留在库里，
    // 这是 Phase 3 版本切换器（‹2/3› 切回旧分支）的数据基础。岛内行打上 detached
    // 内部标记（裸 json_set，**不进 Info schema**：API/SDK 不可见的内部簿记），
    // 对所有标准读侧隐形——MessageV2.page（messages/stream/pagination 的漏斗）、
    // 链尾探测与物化全量读、latestCompactionCursor 统一按 json_extract 排除。
    // 分叉点父消息的 selectedChildID 摘除（仅当仍指向岛首），下一条消息经
    // appendMessage 自然落为新分支——edit-resend/regenerate 由此从截断变为落分支。
    const detachBranch = (island: MessageV2.WithParts[], msgs: MessageV2.WithParts[]) => {
      const root = island[0]!
      // 分叉点 = 岛首的时序前驱（物化会话的 user.parentID 恒等于时序前驱，统一取时序）
      const index = msgs.findIndex((msg) => msg.info.id === root.info.id)
      const parent = index > 0 ? msgs[index - 1] : undefined
      Database.use((db) => {
        for (const msg of island) {
          db.run(
            sql`UPDATE ${MessageTable} SET data = json_set(${MessageTable.data}, '$.detached', 1) WHERE ${MessageTable.id} = ${msg.info.id}`,
          )
        }
        // 父选中指针仍指向岛首才摘——指向别处说明已分离，不动
        if (parent) {
          db.run(
            sql`UPDATE ${MessageTable} SET data = json_remove(${MessageTable.data}, '$.selectedChildID') WHERE ${MessageTable.id} = ${parent.info.id} AND json_extract(${MessageTable.data}, '$.selectedChildID') = ${root.info.id}`,
          )
        }
      })
    }

    const cleanup = Effect.fn("SessionRevert.cleanup")(function* (session: Session.Info) {
      if (!session.revert) return
      const sessionID = session.id
      const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const messageID = session.revert.messageID
      // 260814 Red 边界改 created 比较（ID 回绕后字典序失真）；目标不在列表时保守不删。
      const targetCreated = msgs.find((msg) => msg.info.id === messageID)?.info.time.created
      const remove = [] as MessageV2.WithParts[]
      let target: MessageV2.WithParts | undefined
      for (const msg of msgs) {
        if (targetCreated === undefined) continue
        if (msg.info.time.created < targetCreated) continue
        if (msg.info.time.created === targetCreated && msg.info.id < messageID) continue
        if (msg.info.id === messageID) {
          if (session.revert.partID) {
            target = msg
            continue
          }
          remove.push(msg)
          continue
        }
        remove.push(msg)
      }
      // 261010 Red 原生压缩账本先于分离失效：引用弃岛消息的活跃块直接停用，
      // 避免投影再引用已不在可见路径上的原文。被消费的子块保持停用（父已失效）。
      if (remove.length) ContextCompaction.invalidate(sessionID, remove.map((msg) => msg.info.id))
      // 261114 Red 2d 分岛不删行；Removed 事件语义变为「移出可见路径」，客户端
      //   视图与删除时代一致（重载后由读侧排除兜底）。
      if (remove.length) detachBranch(remove, msgs)
      for (const msg of remove) {
        yield* sync.run(MessageV2.Event.Removed, {
          sessionID,
          messageID: msg.info.id,
        })
      }
      if (session.revert.partID && target) {
        const partID = session.revert.partID
        const idx = target.parts.findIndex((part) => part.id === partID)
        if (idx >= 0) {
          const removeParts = target.parts.slice(idx)
          target.parts = target.parts.slice(0, idx)
          for (const part of removeParts) {
            yield* sync.run(MessageV2.Event.PartRemoved, {
              sessionID,
              messageID: target.info.id,
              partID: part.id,
            })
          }
        }
      }
      yield* sessions.clearRevert(sessionID)
    })

    return Service.of({ revert, unrevert, cleanup })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(SyncEvent.defaultLayer),
  ),
)

export * as SessionRevert from "./revert"
