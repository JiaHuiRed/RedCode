import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import * as Log from "@redcode-ai/core/util/log"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const it = testEffect(SessionNs.defaultLayer)

// 260904 cc A1-2b：summarize 的端点改由 MessageV2.snapshotParts 一条查询给出，不再全量加载消息。
// 这里守它的三条契约：只出带 snapshot 的 step 分片、按消息时间序 + 分片序、parentID 能把本轮切出来。
// 夹具写法照 messages-pagination.test.ts（user 行故意塞一段 summary.diffs，模拟真实数据形状）。

const withSession = <A, E, R>(
  fn: (input: { session: SessionNs.Interface; sessionID: SessionID }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({})
      return { session, sessionID: created.id }
    }),
    fn,
    (input) => input.session.remove(input.sessionID).pipe(Effect.ignore),
  )

const user = Effect.fn("Test.user")(function* (sessionID: SessionID, created: number) {
  const session = yield* SessionNs.Service
  const id = MessageID.ascending()
  yield* session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
    summary: { diffs: [{ file: "x.ts", patch: "+".repeat(4096), additions: 1, deletions: 0 }] },
  } as unknown as MessageV2.Info)
  return id
})

const assistant = Effect.fn("Test.assistant")(function* (sessionID: SessionID, parentID: MessageID, created: number) {
  const session = yield* SessionNs.Service
  const id = MessageID.ascending()
  yield* session.updateMessage({
    id,
    sessionID,
    parentID,
    role: "assistant",
    time: { created },
    agent: "test",
    mode: "",
    modelID: "test",
    providerID: "test",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0, miss: 0 } },
  } as unknown as MessageV2.Info)
  return id
})

const step = Effect.fn("Test.step")(function* (
  sessionID: SessionID,
  messageID: MessageID,
  type: "step-start" | "step-finish",
  snapshot?: string,
) {
  const session = yield* SessionNs.Service
  yield* session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID,
    type,
    ...(snapshot ? { snapshot } : {}),
    ...(type === "step-finish"
      ? { reason: "stop", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0, miss: 0 } } }
      : {}),
  } as unknown as MessageV2.Part)
})

describe("MessageV2.snapshotParts", () => {
  it.instance("returns only snapshot-bearing step parts, in message then part order, with parentID", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const u1 = yield* user(sessionID, 1_000)
        const a1 = yield* assistant(sessionID, u1, 1_001)
        yield* step(sessionID, a1, "step-start", "s1")
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a1,
          type: "text",
          text: "noise",
        } as unknown as MessageV2.Part)
        yield* step(sessionID, a1, "step-finish", "s2")
        const a2 = yield* assistant(sessionID, u1, 1_002)
        yield* step(sessionID, a2, "step-start") // 没有 snapshot：非 git 项目那种，必须被过滤掉
        yield* step(sessionID, a2, "step-start", "s2")
        yield* step(sessionID, a2, "step-finish", "s3")
        const u2 = yield* user(sessionID, 2_000)
        const a3 = yield* assistant(sessionID, u2, 2_001)
        yield* step(sessionID, a3, "step-start", "s3")
        yield* step(sessionID, a3, "step-finish", "s4")

        const rows = yield* MessageV2.snapshotParts(sessionID)

        expect(rows.map((r) => `${r.type}:${r.snapshot}`)).toEqual([
          "step-start:s1",
          "step-finish:s2",
          "step-start:s2",
          "step-finish:s3",
          "step-start:s3",
          "step-finish:s4",
        ])
        expect(rows.map((r) => r.messageID)).toEqual([a1, a1, a2, a2, a3, a3])
        expect(rows.map((r) => r.parentID)).toEqual([u1, u1, u1, u1, u2, u2])

        // 本轮切片：parentID === u1 的四行，首个 step-start 是 s1、末个 step-finish 是 s3
        const turn = rows.filter((r) => r.parentID === u1)
        expect(turn.find((r) => r.type === "step-start")?.snapshot).toBe("s1")
        expect(turn.filter((r) => r.type === "step-finish").at(-1)?.snapshot).toBe("s3")
      }),
    ),
  )

  it.instance("returns an empty list for a session with no step parts", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        yield* user(sessionID, 1_000)
        expect(yield* MessageV2.snapshotParts(sessionID)).toEqual([])
      }),
    ),
  )
})
