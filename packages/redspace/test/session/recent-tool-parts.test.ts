import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import * as Log from "@redcode-ai/core/util/log"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const it = testEffect(SessionNs.defaultLayer)

const withSession = <A, E, R>(fn: (sessionID: SessionID) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({})
      return { session, sessionID: created.id }
    }),
    ({ sessionID }) => fn(sessionID),
    ({ session, sessionID }) => session.remove(sessionID).pipe(Effect.ignore),
  )

const addUser = Effect.fn("Test.addUser")(function* (sessionID: SessionID, id: MessageID, created: number) {
  const session = yield* SessionNs.Service
  yield* session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "test",
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
    tools: {},
  })
  return id
})

const addAssistant = Effect.fn("Test.addAssistant")(function* (
  sessionID: SessionID,
  id: MessageID,
  parentID: MessageID,
  created: number,
) {
  const session = yield* SessionNs.Service
  yield* session.updateMessage({
    id,
    sessionID,
    parentID,
    role: "assistant",
    time: { created },
    modelID: ModelID.make("test"),
    providerID: ProviderID.make("test"),
    mode: "",
    agent: "test",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  return id
})

const addTool = Effect.fn("Test.addTool")(function* (
  sessionID: SessionID,
  messageID: MessageID,
  id: PartID,
  name: string,
) {
  const session = yield* SessionNs.Service
  yield* session.updatePart({
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: `call-${name}`,
    tool: name,
    state: {
      status: "completed",
      input: {},
      output: "ok",
      title: name,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  })
})

const addText = Effect.fn("Test.addText")(function* (sessionID: SessionID, messageID: MessageID, id: PartID) {
  const session = yield* SessionNs.Service
  yield* session.updatePart({ id, sessionID, messageID, type: "text", text: "noise" })
})

describe("MessageV2.recentToolParts", () => {
  it.instance("finds tools beyond limit*8 newer non-tool parts", () =>
    withSession((sessionID) =>
      Effect.gen(function* () {
        const parentID = yield* addUser(sessionID, MessageID.make("msg_dense-user"), 1)
        const assistantID = yield* addAssistant(sessionID, MessageID.make("msg_dense-assistant"), parentID, 2)
        const ids = Array.from({ length: 6 }, (_, i) => PartID.make(`prt_dense-a-tool-${i}`))
        for (let i = 0; i < ids.length; i++) {
          yield* addTool(sessionID, assistantID, ids[i], `tool-${i}`)
        }
        for (let i = 0; i < 49; i++) {
          yield* addText(sessionID, assistantID, PartID.make(`prt_dense-z-noise-${String(i).padStart(2, "0")}`))
        }

        expect(MessageV2.recentToolParts(sessionID, 6, parentID).map((part) => part.id)).toEqual(ids)
      }),
    ),
  )

  it.instance("stays within the selected user turn across assistant messages", () =>
    withSession((sessionID) =>
      Effect.gen(function* () {
        const firstTurn = yield* addUser(sessionID, MessageID.make("msg_turn-first"), 10)
        const firstAssistant = yield* addAssistant(sessionID, MessageID.make("msg_turn-first-assistant"), firstTurn, 11)
        yield* addTool(sessionID, firstAssistant, PartID.make("prt_turn-old"), "old")

        const currentTurn = yield* addUser(sessionID, MessageID.make("msg_turn-current"), 20)
        const assistantA = yield* addAssistant(sessionID, MessageID.make("msg_turn-current-a"), currentTurn, 21)
        const assistantB = yield* addAssistant(sessionID, MessageID.make("msg_turn-current-b"), currentTurn, 22)
        yield* addTool(sessionID, assistantA, PartID.make("prt_turn-a"), "current-a")
        yield* addTool(sessionID, assistantB, PartID.make("prt_turn-b"), "current-b")

        expect(MessageV2.recentToolParts(sessionID, 6, currentTurn).map((part) => part.tool)).toEqual([
          "current-a",
          "current-b",
        ])
        expect(MessageV2.recentToolParts(sessionID, 1, currentTurn).map((part) => part.tool)).toEqual(["current-b"])
      }),
    ),
  )

  it.instance("returns no parts for a zero limit", () =>
    withSession((sessionID) =>
      Effect.gen(function* () {
        const parentID = yield* addUser(sessionID, MessageID.make("msg_zero-user"), 1)
        const assistantID = yield* addAssistant(sessionID, MessageID.make("msg_zero-assistant"), parentID, 2)
        yield* addTool(sessionID, assistantID, PartID.make("prt_zero"), "tool")

        expect(MessageV2.recentToolParts(sessionID, 0, parentID)).toEqual([])
      }),
    ),
  )

  it.instance("orders by message time before message ID and returns chronological results", () =>
    withSession((sessionID) =>
      Effect.gen(function* () {
        const parentID = yield* addUser(sessionID, MessageID.make("msg_order-user"), 1)
        const laterID = yield* addAssistant(sessionID, MessageID.make("msg_a-later"), parentID, 20)
        const earlierID = yield* addAssistant(sessionID, MessageID.make("msg_z-earlier"), parentID, 10)
        yield* addTool(sessionID, laterID, PartID.make("prt_order-a"), "later")
        yield* addTool(sessionID, earlierID, PartID.make("prt_order-z"), "earlier")

        expect(MessageV2.recentToolParts(sessionID, 2, parentID).map((part) => part.tool)).toEqual(["earlier", "later"])
      }),
    ),
  )
})
