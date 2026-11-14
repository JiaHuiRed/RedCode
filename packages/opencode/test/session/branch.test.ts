import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Fiber, Layer } from "effect"
import { Session } from "@/session/session"
import { SessionBranch, markIslandRows } from "../../src/session/branch"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageV2 } from "../../src/session/message-v2"
import { Snapshot } from "../../src/snapshot"
import * as Log from "@redcode-ai/core/util/log"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

void Log.init({ print: false })

const env = Layer.mergeAll(
  Session.defaultLayer,
  SessionBranch.defaultLayer,
  SessionRevert.defaultLayer,
  SessionRunState.defaultLayer,
  Snapshot.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
)

const it = testEffect(env)

const model = { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-4") }
const tokens = { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0, miss: 0 } }

// seeding 一律走 appendMessage（写入契约：新建消息必经 appendMessage，裸行的半物化
// 状态会让树模式 walk 断链——见 2b' 实现记录）。
const user = Effect.fn("test.user")(function* (sessionID: SessionID, text?: string) {
  const ssn = yield* Session.Service
  const msg = yield* ssn.appendMessage({
    id: MessageID.ascending(),
    role: "user" as const,
    sessionID,
    agent: "default",
    model,
    time: { created: Date.now() },
  })
  if (text)
    yield* ssn.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "text" as const,
      text,
    })
  return msg
})

const assistant = Effect.fn("test.assistant")(function* (sessionID: SessionID, parentID: MessageID, dir: string) {
  const ssn = yield* Session.Service
  return yield* ssn.appendMessage({
    id: MessageID.ascending(),
    role: "assistant" as const,
    sessionID,
    mode: "default",
    agent: "default",
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens,
    modelID: ModelID.make("gpt-4"),
    providerID: ProviderID.make("openai"),
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  })
})

// 人工「编辑文件」：写入内容 + 在消息上记 patch 部件（hash = 改动前的 tree）。
const edit = Effect.fn("test.edit")(function* (
  sessionID: SessionID,
  messageID: MessageID,
  file: string,
  content: string,
  preHash: string,
) {
  yield* Effect.promise(() => fs.writeFile(file, content))
  const ssn = yield* Session.Service
  return yield* ssn.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "patch" as const,
    hash: preHash,
    files: [file],
  })
})

const stepFinish = Effect.fn("test.stepFinish")(function* (sessionID: SessionID, messageID: MessageID, cost: number) {
  const ssn = yield* Session.Service
  return yield* ssn.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "step-finish" as const,
    reason: "end_turn",
    cost,
    tokens: {
      input: 1,
      output: 1,
      reasoning: 0,
      cache: { read: 0, write: 0, miss: 0 },
    },
  })
})

/** revert + cleanup：落 revert 标记并立即分岛（真实入口是下一次 prompt，测试里直呼）。 */
const revertAndIsland = Effect.fn("test.revertAndIsland")(function* (
  revert: SessionRevert.Interface,
  sessionID: SessionID,
  messageID: MessageID,
) {
  yield* revert.revert({ sessionID, messageID })
  const info = yield* Session.Service.use((ssn) => ssn.get(sessionID))
  yield* revert.cleanup(info)
})

const detachMap = Effect.fn("test.detachMap")(function* (sessionID: SessionID) {
  const rows = yield* MessageV2.allIncludingDetached({ sessionID })
  return new Map(rows.map((row) => [row.info.id as string, row.detached]))
})

const ids = (messages: MessageV2.WithParts[]) => messages.map((m) => m.info.id as string)

describe("session.branch.versions", () => {
  it.live(
    "lists sibling versions incl. islands with current selection; mid-island users do not aggregate across islands",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const ssn = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const branch = yield* SessionBranch.Service

          const info = yield* ssn.create({})
          const sessionID = info.id

          const u1 = yield* user(sessionID, "q1")
          const a1 = yield* assistant(sessionID, u1.id, dir)
          const u2 = yield* user(sessionID, "q2")
          const a2 = yield* assistant(sessionID, u2.id, dir)
          const u3 = yield* user(sessionID, "q3")
          const a3 = yield* assistant(sessionID, u3.id, dir)

          // revert 到 u2：岛 = [u2, a2, u3, a3]（u3 在岛链中间），新分支 u2' 落在 a1 下
          yield* revertAndIsland(revert, sessionID, u2.id)
          const u2b = yield* user(sessionID, "q2'")
          const a2b = yield* assistant(sessionID, u2b.id, dir)
          const u3b = yield* user(sessionID, "q3'")
          const a3b = yield* assistant(sessionID, u3b.id, dir)

          const groups = yield* branch.versions({ sessionID })
          expect(groups.length).toBe(1)
          expect(groups[0]!.parentID).toBe(a1.id)
          expect(groups[0]!.versions.map((v) => v.messageID)).toEqual([u2.id, u2b.id])
          expect(groups[0]!.current).toBe(u2b.id)
          // 岛链中间的 u3(parentID=a2) 与可见链的 u3b(parentID=a2b) 不同分叉点，
          // 不跨岛聚合：两组都只有单成员，不出现
          expect(groups.some((g) => g.versions.some((v) => v.messageID === u3.id))).toBe(false)
          expect(groups.some((g) => g.versions.some((v) => v.messageID === u3b.id))).toBe(false)

          // 无关消息不可切换
          const err = yield* branch.select({ sessionID, messageID: a1.id }).pipe(Effect.flip)
          expect(err._tag).toBe("InvalidBranch")
          void a2
          void a3
          void a2b
          void a3b
        }),
      { git: true },
    ),
  )

  it.live(
    "groups root versions (re-rooted first message) and reports the undetached one as current",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const ssn = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const branch = yield* SessionBranch.Service

          const info = yield* ssn.create({})
          const sessionID = info.id

          const u1 = yield* user(sessionID, "q1")
          yield* assistant(sessionID, u1.id, dir)

          // revert 到首条消息：旧根整链弃岛，新分支成为新根（parentID 缺省）
          yield* revertAndIsland(revert, sessionID, u1.id)
          const u1b = yield* user(sessionID, "q1'")
          yield* assistant(sessionID, u1b.id, dir)

          const groups = yield* branch.versions({ sessionID })
          expect(groups.length).toBe(1)
          expect(groups[0]!.parentID).toBeUndefined()
          expect(groups[0]!.versions.map((v) => v.messageID)).toEqual([u1.id, u1b.id])
          expect(groups[0]!.current).toBe(u1b.id)
        }),
      { git: true },
    ),
  )
})

describe("session.branch.select", () => {
  it.live(
    "switches between root versions and keeps the single-visible-chain invariant",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const ssn = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const branch = yield* SessionBranch.Service

          const info = yield* ssn.create({})
          const sessionID = info.id

          const u1 = yield* user(sessionID, "q1")
          const a1 = yield* assistant(sessionID, u1.id, dir)
          yield* revertAndIsland(revert, sessionID, u1.id)
          const u1b = yield* user(sessionID, "q1'")
          const a1b = yield* assistant(sessionID, u1b.id, dir)

          // 切回旧根：可见路径翻转
          yield* branch.select({ sessionID, messageID: u1.id })
          expect(ids(yield* ssn.messages({ sessionID }))).toEqual([u1.id, a1.id].map(String))
          let detached = yield* detachMap(sessionID)
          expect(detached.get(u1.id)).toBe(false)
          expect(detached.get(a1.id)).toBe(false)
          expect(detached.get(u1b.id)).toBe(true)
          expect(detached.get(a1b.id)).toBe(true)
          expect((yield* branch.versions({ sessionID }))[0]!.current).toBe(u1.id)

          // 切回新根：往返
          yield* branch.select({ sessionID, messageID: u1b.id })
          expect(ids(yield* ssn.messages({ sessionID }))).toEqual([u1b.id, a1b.id].map(String))
          detached = yield* detachMap(sessionID)
          expect(detached.get(u1b.id)).toBe(false)
          expect(detached.get(u1.id)).toBe(true)

          // 幂等：目标已是当前版本 → 原样返回
          yield* branch.select({ sessionID, messageID: u1b.id })
          expect(ids(yield* ssn.messages({ sessionID }))).toEqual([u1b.id, a1b.id].map(String))
        }),
      { git: true },
    ),
  )

  it.live(
    "switches a mid-chain fork by rewriting the parent pointer; pointer survives reads",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const ssn = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const branch = yield* SessionBranch.Service

          const info = yield* ssn.create({})
          const sessionID = info.id

          const u1 = yield* user(sessionID, "q1")
          const a1 = yield* assistant(sessionID, u1.id, dir)
          const u2 = yield* user(sessionID, "q2")
          const a2 = yield* assistant(sessionID, u2.id, dir)

          yield* revertAndIsland(revert, sessionID, u2.id)
          const u2b = yield* user(sessionID, "q2'")
          const a2b = yield* assistant(sessionID, u2b.id, dir)

          // 分叉点父指针 a1.selectedChildID 现指 u2b
          const rows = yield* MessageV2.allIncludingDetached({ sessionID })
          const a1Row = rows.find((row) => row.info.id === a1.id)!
          expect(a1Row.info.role === "assistant" ? a1Row.info.selectedChildID : undefined).toBe(u2b.id)

          yield* branch.select({ sessionID, messageID: u2.id })
          expect(ids(yield* ssn.messages({ sessionID }))).toEqual([u1.id, a1.id, u2.id, a2.id].map(String))
          // 指针已改写，且改写经平面读仍正确（page 层排除岛行）
          const rows2 = yield* MessageV2.allIncludingDetached({ sessionID })
          const a1Row2 = rows2.find((row) => row.info.id === a1.id)!
          expect(a1Row2.info.role === "assistant" ? a1Row2.info.selectedChildID : undefined).toBe(u2.id)

          yield* branch.select({ sessionID, messageID: u2b.id })
          expect(ids(yield* ssn.messages({ sessionID }))).toEqual([u1.id, a1.id, u2b.id, a2b.id].map(String))
        }),
      { git: true },
    ),
  )

  it.live(
    "restores files: undo current suffix patches to fork point, checkout island end state",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const ssn = yield* Session.Service
          const snap = yield* Snapshot.Service
          const revert = yield* SessionRevert.Service
          const branch = yield* SessionBranch.Service

          const info = yield* ssn.create({})
          const sessionID = info.id
          const file = path.join(dir, "f.txt")

          yield* Effect.promise(() => fs.writeFile(file, "v0"))
          const h0 = yield* snap.track()
          expect(h0).toBeDefined()

          const u1 = yield* user(sessionID, "q1")
          const a1 = yield* assistant(sessionID, u1.id, dir)
          // 旧分支的「编辑」：f.txt v0 → v1，patch 记改动前 tree h0
          yield* edit(sessionID, a1.id, file, "v1", h0!)

          // revert + 分岛：岛快照 = revert 时刻盘面（f=v1）
          yield* revertAndIsland(revert, sessionID, u1.id)
          expect(yield* Effect.promise(() => fs.readFile(file, "utf-8"))).toBe("v0")

          // 新分支的「编辑」：f.txt v0 → v2，patch 记改动前 tree h0（分叉点盘面）
          const u1b = yield* user(sessionID, "q1'")
          const a1b = yield* assistant(sessionID, u1b.id, dir)
          yield* edit(sessionID, a1b.id, file, "v2", h0!)
          expect(yield* Effect.promise(() => fs.readFile(file, "utf-8"))).toBe("v2")

          // 切回旧分支：先退新分支 patch（v2 → v0），再取岛末态（v0 → v1）
          yield* branch.select({ sessionID, messageID: u1.id })
          expect(yield* Effect.promise(() => fs.readFile(file, "utf-8"))).toBe("v1")
          expect(ids(yield* ssn.messages({ sessionID }))).toEqual([u1.id, a1.id].map(String))

          // 切回新分支：退旧分支 patch（v1 → v0），取新分支岛末态（v0 → v2）
          yield* branch.select({ sessionID, messageID: u1b.id })
          expect(yield* Effect.promise(() => fs.readFile(file, "utf-8"))).toBe("v2")
          expect(ids(yield* ssn.messages({ sessionID }))).toEqual([u1b.id, a1b.id].map(String))
        }),
      { git: true },
    ),
  )

  it.live(
    "legacy island without snapshot switches messages only, files untouched",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const ssn = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const branch = yield* SessionBranch.Service

          const sessionID = (yield* ssn.create({})).id
          const file = path.join(dir, "f.txt")
          yield* Effect.promise(() => fs.writeFile(file, "v9"))

          const u1 = yield* user(sessionID, "q1")
          const a1 = yield* assistant(sessionID, u1.id, dir)

          // 模拟 2d 时代存量岛：只打 detached，无 islandSnapshot
          yield* revert.revert({ sessionID, messageID: u1.id })
          yield* Effect.sync(() => markIslandRows([{ info: u1 }, { info: a1 }]))
          yield* Session.Service.use((ssn) => ssn.clearRevert(sessionID))

          const u1b = yield* user(sessionID, "q1'")
          const a1b = yield* assistant(sessionID, u1b.id, dir)
          void a1b

          yield* branch.select({ sessionID, messageID: u1.id })
          expect(ids(yield* ssn.messages({ sessionID }))).toEqual([u1.id, a1.id].map(String))
          // 无岛快照 → 不做文件恢复
          expect(yield* Effect.promise(() => fs.readFile(file, "utf-8"))).toBe("v9")
        }),
      { git: true },
    ),
  )

  it.live(
    "usage rolls back on switch-away (Removed projector) and is re-credited on switch-back",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const ssn = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const branch = yield* SessionBranch.Service

          const info = yield* ssn.create({})
          const sessionID = info.id

          const u1 = yield* user(sessionID, "q1")
          const a1 = yield* assistant(sessionID, u1.id, dir)
          yield* stepFinish(sessionID, a1.id, 1)
          expect((yield* ssn.get(sessionID)).cost).toBe(1)

          yield* revertAndIsland(revert, sessionID, u1.id)
          // 弃岛：Removed 投影器按 -1 回冲
          expect((yield* ssn.get(sessionID)).cost).toBe(0)

          const u1b = yield* user(sessionID, "q1'")
          const a1b = yield* assistant(sessionID, u1b.id, dir)
          void a1b

          yield* branch.select({ sessionID, messageID: u1.id })
          // 切回补记：+1
          expect((yield* ssn.get(sessionID)).cost).toBe(1)

          yield* branch.select({ sessionID, messageID: u1b.id })
          expect((yield* ssn.get(sessionID)).cost).toBe(0)
        }),
      { git: true },
    ),
  )

  it.live(
    "rejects while a run is busy and while a revert marker is pending",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const ssn = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const branch = yield* SessionBranch.Service
          const state = yield* SessionRunState.Service

          const info = yield* ssn.create({})
          const sessionID = info.id
          const u1 = yield* user(sessionID, "q1")
          const a1 = yield* assistant(sessionID, u1.id, dir)
          void a1

          // busy：runner 占用中 → SessionBusyError
          const fiber = yield* state
            .ensureRunning(
              sessionID,
              Effect.succeed(undefined as unknown as MessageV2.WithParts),
              Effect.never,
            )
            .pipe(Effect.forkChild)
          yield* pollWithTimeout(
            Effect.map(state.isBusy(sessionID), (busy) => (busy ? true : undefined)),
            "session runner never became busy",
          )
          const busy = yield* branch.select({ sessionID, messageID: u1.id }).pipe(Effect.flip)
          expect(busy._tag).toBe("SessionBusyError")
          yield* state.cancel(sessionID)
          yield* Fiber.interrupt(fiber)

          // 活跃 revert 标记（未 cleanup）→ RevertPending
          yield* revert.revert({ sessionID, messageID: u1.id })
          const pending = yield* branch.select({ sessionID, messageID: u1.id }).pipe(Effect.flip)
          expect(pending._tag).toBe("RevertPending")
          yield* ssn.clearRevert(sessionID)
        }),
      { git: true },
    ),
  )
})
