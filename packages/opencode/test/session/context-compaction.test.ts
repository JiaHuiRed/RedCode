import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Session } from "../../src/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import * as ContextCompaction from "../../src/session/context-compaction"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, CrossSpawnSpawner.defaultLayer))
const limits: ContextCompaction.Limits = {
  summaryMaxTokens: 16000, summaryMaxBytes: 98304, activeMaxTokens: 80000, activeMaxBytes: 524288,
  maxRanges: 8, maxBlocks: 128, maxMessages: 4096, readMaxTokens: 2048, readMaxBytes: 8192,
  searchScanBytes: 4194304, searchMaxResults: 10, protectUserMessages: true,
  protectedTools: ["skill", "task", "todowrite"],
}

function fixture() {
  return Effect.gen(function* () {
    const session = yield* Session.Service
    const dir = yield* TestInstance
    const chat = yield* session.create({})
    const user = yield* session.updateMessage({
      id: MessageID.ascending(), sessionID: chat.id, role: "user", agent: "build",
      model: { providerID: "test", modelID: "test" } as MessageV2.User["model"], time: { created: 1 },
    })
    yield* session.updatePart({ id: PartID.ascending(), messageID: user.id, sessionID: chat.id, type: "text", text: "Never push." })
    const assistant = yield* session.updateMessage({
      id: MessageID.ascending(), sessionID: chat.id, parentID: user.id, role: "assistant",
      agent: "build", mode: "build", modelID: "test", providerID: "test",
      path: { cwd: dir.directory, root: dir.directory }, time: { created: 2 }, finish: "end_turn", cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as MessageV2.Assistant)
    yield* session.updatePart({ id: PartID.ascending(), messageID: assistant.id, sessionID: chat.id, type: "text", text: "Investigation evidence. ".repeat(500) })
    const last = yield* session.updateMessage({
      ...user, id: MessageID.ascending(), time: { created: 3 },
    })
    yield* session.updatePart({ id: PartID.ascending(), messageID: last.id, sessionID: chat.id, type: "text", text: "Continue implementation." })
    const messages = yield* session.messages({ sessionID: chat.id })
    return { session, chat, user, assistant, last, messages }
  })
}

describe("native compression ledger", () => {
  it.instance("protects exact user text, preserves raw history and idempotently commits", () => Effect.gen(function* () {
    const f = yield* fixture()
    const input = {
      sessionID: f.chat.id, messages: f.messages, limits, mode: "model" as const, requestID: "request-1",
      ranges: [{ startId: f.user.id, endId: f.assistant.id, summary: "Investigation finished." }],
    }
    const blocks = ContextCompaction.commit(input)
    expect(ContextCompaction.commit(input)).toEqual(blocks)
    const projected = ContextCompaction.project(f.messages, ContextCompaction.list(f.chat.id))
    expect(projected).toHaveLength(2)
    expect(projected[0]?.parts[0]).toMatchObject({ synthetic: true })
    expect(JSON.stringify(projected)).toContain("Never push.")
    expect(projected[1]).toEqual(f.messages[2])
    expect(yield* f.session.messages({ sessionID: f.chat.id })).toEqual(f.messages)
    ContextCompaction.deactivate(f.chat.id, blocks[0]!.id)
    expect(ContextCompaction.project(f.messages, ContextCompaction.list(f.chat.id))).toEqual(f.messages)
  }))

  it.instance("rejects an invalid batch before changing any projection", () => Effect.gen(function* () {
    const f = yield* fixture()
    expect(() => ContextCompaction.commit({
      sessionID: f.chat.id, messages: f.messages, limits, mode: "model", requestID: "invalid",
      ranges: [
        { startId: f.user.id, endId: f.assistant.id, summary: "Finished." },
        { startId: f.assistant.id, endId: f.last.id, summary: "Overlapping and current." },
      ],
    })).toThrow()
    expect(ContextCompaction.list(f.chat.id)).toEqual([])
  }))

  it.instance("reads original evidence within bounds and cannot cross sessions", () => Effect.gen(function* () {
    const f = yield* fixture()
    const read = ContextCompaction.read(f.chat.id, f.assistant.id, 0, { ...limits, readMaxBytes: 512, readMaxTokens: 128 })
    expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThanOrEqual(512)
    expect(read.nextOffset).toBeGreaterThan(0)
    expect(ContextCompaction.search(f.chat.id, "Investigation", limits).results.length).toBeGreaterThan(0)
    const foreign = yield* f.session.create({})
    expect(() => ContextCompaction.read(foreign.id, f.assistant.id, 0, limits)).toThrow()
  }))

  it.instance("rejects stale source content and protected-content overflow", () => Effect.gen(function* () {
    const f = yield* fixture()
    const snapshot = structuredClone(f.messages)
    const part = f.messages[1]!.parts[0]!
    if (part.type !== "text") throw new Error("fixture requires text")
    yield* f.session.updatePart({ ...part, text: "Changed evidence." })
    expect(() => ContextCompaction.commit({
      sessionID: f.chat.id, messages: snapshot, ranges: [{ startId: f.user.id, endId: f.assistant.id, summary: "Done." }],
      limits, mode: "model", requestID: "stale",
    })).toThrow("stale")
    expect(ContextCompaction.list(f.chat.id)).toEqual([])
  }))
})
