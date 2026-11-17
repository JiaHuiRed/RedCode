// 261114 Red 消息树分支 Phase 3 切换器（决策：docs/notes/implemented/feature/2026-11-14-message-tree-branching.md）。
// versions：列举某个分叉点的兄弟版本（含弃岛）；select：切到指定版本——父指针改写
// （selectVersion 纯函数定语义），弃岛对称开合（目标岛 undetach、当前后缀 detach）。
//
// 分岛不变量是本服务的地基（2d 建立）：任一时刻每个分叉点恰有一条未 detach 链。
// 切换全程维持它——平面读（MessageV2.page 的 detached WHERE）因此天然等于可见路径，
// 分页/流/压缩扫描零改动继续正确。写序以「崩溃后视图退化不腐化」为准：先 detach
// 后 undetach，中途崩溃最多看到分叉点截断的短链，不出现双链并现。
//
// 文件恢复（note「只恢复消息对应的 patch，不做 git 级工作区回滚」）：切走前
// snap.track() 当前盘面写进即将弃岛的后缀首行（islandSnapshot，内部簿记同 detached）；
// 切回时先 snap.revert(当前后缀 patches) 退回分叉点，再把目标岛 patch 涉及的文件
// checkout 到岛末态 tree（Snapshot.checkoutFiles，补丁级）。存量岛（2d 时代，无
// islandSnapshot）只切消息不动文件。

import { Effect, Layer, Context, Schema } from "effect"
import { inArray, and, eq, sql } from "drizzle-orm"
import { Database } from "@/storage/db"
import { NotFoundError } from "@/storage/storage"
import { MessageTable, PartTable } from "./session.sql"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { hasExplicitBranches, selectVersion } from "./message-tree"
import * as ContextCompaction from "./context-compaction"
import { Snapshot } from "../snapshot"
import { SessionRunState } from "./run-state"
import { Bus } from "../bus"
import { SyncEvent } from "../sync"
import { applyUsage, usage as partUsage } from "./projectors"
import * as Log from "@redcode-ai/core/util/log"
import { SessionID, MessageID } from "./schema"

const log = Log.create({ service: "session.branch" })

// 目标不是 user 消息 / 会话未物化 / 父分叉点不在可见路径上——切换语义不成立
export class InvalidBranch extends Schema.TaggedError<InvalidBranch>()("InvalidBranch", {
  message: Schema.String,
}) {}

// 存在未 cleanup 的 revert 标记（待截断语义与切换冲突，先 unrevert 或发下一条消息）
export class RevertPending extends Schema.TaggedError<RevertPending>()("RevertPending", {
  sessionID: SessionID,
}) {}

export const VersionEntry = Schema.Struct({
  messageID: MessageID,
  timeCreated: Schema.Finite,
}).annotate({ identifier: "MessageVersionEntry" })

export const VersionGroup = Schema.Struct({
  // 分叉点的树父（该组所有 user 消息共享的 parentID）；根版本组缺省（编辑会话
  // 首条消息产生的重根兄弟，切换走 newRootID 路径）
  parentID: Schema.optional(MessageID),
  versions: Schema.Array(VersionEntry),
  current: MessageID,
}).annotate({ identifier: "MessageVersionGroup" })
export type VersionGroup = typeof VersionGroup.Type

type RowRef = { info: { id: MessageID } }

// ── 岛行标记（revert.cleanup 与本服务共用；裸 json_set/json_remove，不进 Info schema，
//    API/SDK 不可见的内部簿记，与 detached 同款）────────────────────────────────

/** 标记弃岛：detached = 1；islandSnapshot（岛分支末态 tree hash）有则一并写。 */
export const markIslandRows = (rows: readonly RowRef[], islandSnapshot?: string) =>
  Database.use((db) => {
    for (const row of rows) {
      db.run(
        islandSnapshot !== undefined
          ? sql`UPDATE ${MessageTable} SET data = json_set(${MessageTable.data}, '$.detached', 1, '$.islandSnapshot', ${islandSnapshot}) WHERE ${MessageTable.id} = ${row.info.id}`
          : sql`UPDATE ${MessageTable} SET data = json_set(${MessageTable.data}, '$.detached', 1) WHERE ${MessageTable.id} = ${row.info.id}`,
      )
    }
  })

/** 解除弃岛：只摘 detached；islandSnapshot 保留（只在弃岛时读，留着无害，下次弃岛刷新）。 */
export const unmarkIslandRows = (rows: readonly RowRef[]) =>
  Database.use((db) => {
    for (const row of rows) {
      db.run(
        sql`UPDATE ${MessageTable} SET data = json_remove(${MessageTable.data}, '$.detached') WHERE ${MessageTable.id} = ${row.info.id}`,
      )
    }
  })

/**
 * 岛内链：从岛首沿 selectedChildID 收集整条弃岛链。岛内部是线性链（分岛时它是
 * 当时的可见尾段，后来的分支都挂在可见链上），链尾 selectedChildID 缺省；
 * 守卫在 detached 上——万一指针逸出岛（数据损伤），宁可少收不越界。
 */
const islandChain = (rows: MessageV2.BranchRow[], headID: MessageID): MessageV2.BranchRow[] => {
  const byId = new Map(rows.map((row) => [row.info.id, row]))
  const chain: MessageV2.BranchRow[] = []
  let node = byId.get(headID)
  for (let i = 0; node && node.detached && i < rows.length; i++) {
    chain.push(node)
    node = node.info.selectedChildID ? byId.get(node.info.selectedChildID) : undefined
  }
  return chain
}

export interface Interface {
  readonly versions: (input: { sessionID: SessionID }) => Effect.Effect<VersionGroup[]>
  readonly select: (input: {
    sessionID: SessionID
    messageID: MessageID
  }) => Effect.Effect<Session.Info, Session.BusyError | RevertPending | InvalidBranch | NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@redcode/SessionBranch") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snap = yield* Snapshot.Service
    const state = yield* SessionRunState.Service
    const sync = yield* SyncEvent.Service
    const bus = yield* Bus.Service

    /**
     * 版本组：同 parentID 的 user 消息为一组（含弃岛），根组 = 无树父的 user 消息。
     * 只列 ≥2 个版本的组；assistant 不分组——它的 parentID 语义是「触发的 user」，
     * 同轮多步 assistant 共享同一 user，不是版本兄弟。岛链中间的 user 行属于其
     * 所在岛分支的分叉点，天然不与可见链的对应消息跨岛聚合。
     */
    const versions = Effect.fn("SessionBranch.versions")(function* (input: { sessionID: SessionID }) {
      const rows = yield* MessageV2.allIncludingDetached({ sessionID: input.sessionID })
      const groups = new Map<string, MessageV2.BranchRow[]>()
      for (const row of rows) {
        if (row.info.role !== "user") continue
        const key = row.info.parentID ?? ""
        const list = groups.get(key)
        if (list) list.push(row)
        else groups.set(key, [row])
      }
      const out: VersionGroup[] = []
      for (const [key, members] of groups) {
        if (members.length < 2) continue
        const parentID = key === "" ? undefined : (key as MessageID)
        // current：父指针所指（分叉组），根组取唯一未弃岛成员；指针缺失（旧损伤）
        // 时按不变量兜底到未弃岛成员。列举是读路径，兜底不响。
        let current: MessageID | undefined
        if (parentID !== undefined) {
          const parent = rows.find((row) => row.info.id === parentID)
          const selected = parent?.info.selectedChildID
          if (selected && members.some((row) => row.info.id === selected)) current = selected
        }
        current ??= members.find((row) => !row.detached)?.info.id ?? members.at(-1)!.info.id
        out.push({
          parentID,
          versions: members.map((row) => ({ messageID: row.info.id, timeCreated: row.info.time.created })),
          current,
        })
      }
      return out
    })

    const select = Effect.fn("SessionBranch.select")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (session.revert) return yield* new RevertPending({ sessionID: input.sessionID })
      const rows = yield* MessageV2.allIncludingDetached({ sessionID: input.sessionID })
      const target = rows.find((row) => row.info.id === input.messageID)
      if (!target) return yield* new NotFoundError({ message: `Message not found: ${input.messageID}` })
      if (target.info.role !== "user")
        return yield* new InvalidBranch({ message: "only user messages have switchable versions" })
      const visible = rows.filter((row) => !row.detached)
      if (!hasExplicitBranches(visible))
        return yield* new InvalidBranch({ message: "session has no message branches" })
      // 可见根：首个无树父的 user。不变量保证唯一（旧根随整链弃岛）；反例 = 数据
      // 损伤，取时序首行兜底让 selectVersion 的路径校验去做拒绝。
      const visibleRoot =
        visible.find((row) => row.info.role === "user" && row.info.parentID === undefined) ?? visible[0]!

      // 幂等：目标已是当前版本（根组当前根 / 分叉组父指针已指向）→ 无操作返回。
      const parentID = target.info.parentID
      if (parentID === undefined) {
        if (visibleRoot.info.id === input.messageID) return session
      } else {
        const parent = visible.find((row) => row.info.id === parentID)
        if (!parent)
          return yield* new InvalidBranch({
            message: `fork parent ${parentID} is not on the visible path`,
          })
        if (parent.info.selectedChildID === input.messageID) return session
      }

      // selectVersion 定语义：父必须在可见路径上（rootID 显式传入——含岛的全集里
      // 时序探测会落到旧根岛，探测失效），根组返回 newRootID。
      const result = selectVersion(rows, input.messageID, visibleRoot.info.id)
      const parentRow = result.changed[0]
      if (!result.newRootID && !parentRow)
        return yield* new InvalidBranch({ message: `message ${input.messageID} has no switchable position` })

      // 要弃岛的当前后缀：可见链上分叉点之后的全部行（不变量：它们全属当前分支）。
      const suffix = parentRow
        ? visible.slice(visible.findIndex((row) => row.info.id === parentRow.info.id) + 1)
        : visible

      // 岛内链（目标版本 + 它身后随岛保留的行）
      const island = islandChain(rows, input.messageID)

      // 文件恢复：先记当前盘面（即将弃岛后缀的末态），再退 suffix patches 回分叉点，
      // 最后把岛 patch 涉及的文件 checkout 到岛末态。存量岛无 islandSnapshot → 只切
      // 消息不动文件，log 说明（note 的保守语义）。
      const snapHash = yield* snap.track()
      const suffixPatches = suffix.flatMap((row) => row.parts.filter((part) => part.type === "patch"))
      if (suffixPatches.length) yield* snap.revert(suffixPatches)
      const islandFiles = [
        ...new Set(
          island.flatMap((row) =>
            row.parts.flatMap((part) => (part.type === "patch" ? part.files : [])),
          ),
        ),
      ]
      if (target.islandSnapshot !== undefined && islandFiles.length > 0) {
        yield* snap.checkoutFiles(target.islandSnapshot, islandFiles)
      } else if (islandFiles.length > 0) {
        log.info("island has no snapshot, switching messages only", {
          sessionID: input.sessionID,
          messageID: input.messageID,
          files: islandFiles.length,
        })
      }

      // 写序：失效压缩账本 → 弃岛后缀（先写岛快照再标记）→ Removed（用量 -1，
      // 投影器读到 detached 跳过删行）→ 改写父指针 → 开岛 → 用量 +1 → 广播。
      if (suffix.length) ContextCompaction.invalidate(input.sessionID, suffix.map((row) => row.info.id))
      if (suffix.length) yield* Effect.sync(() => markIslandRows(suffix, snapHash))
      for (const row of suffix) {
        yield* sync.run(MessageV2.Event.Removed, {
          sessionID: input.sessionID,
          messageID: row.info.id,
        })
      }
      if (parentRow) {
        Database.use((db) => {
          db.run(
            sql`UPDATE ${MessageTable} SET data = json_set(${MessageTable.data}, '$.selectedChildID', ${input.messageID}) WHERE ${MessageTable.id} = ${parentRow.info.id}`,
          )
        })
      }
      yield* Effect.sync(() => unmarkIslandRows(island))
      // 切回补记（projectors.ts Removed 投影 2d 预留的反向）：岛内 step-finish
      // 部件的用量按 +1 回账面；detach 侧的 -1 由 Removed 投影器完成。
      if (island.length) {
        const partRows = Database.use((db) =>
          db
            .select()
            .from(PartTable)
            .where(
              and(
                eq(PartTable.session_id, input.sessionID),
                inArray(PartTable.message_id, island.map((row) => row.info.id)),
              ),
            )
            .all(),
        )
        Database.use((db) => {
          for (const partRow of partRows) {
            const value = partUsage(partRow.data)
            if (value) applyUsage(db, input.sessionID, value, 1)
          }
        })
      }
      yield* bus.publish(MessageV2.Event.BranchesSwitched, { sessionID: input.sessionID })
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    return Service.of({ versions, select })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(SyncEvent.defaultLayer),
    Layer.provide(Bus.layer),
  ),
)

export * as SessionBranch from "./branch"
