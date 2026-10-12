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
  summaryMaxTokens: 16000, summaryMaxBytes: 98304, retainedMaxTokens: 20000, activeMaxTokens: 80000, activeMaxBytes: 524288,
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
      sessionID: f.chat.id, messages: f.messages, limits, mode: "auto" as const, requestID: "request-1",
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

  // 261012 Red 保护记录收敛出口：新块继承旧块记录按预算携带（用户原文优先、最新优先、
  // 整条保留或丢弃），超限记录退到账本可读回——protectedRecords 不再单调膨胀。
  it.instance("bounds inherited protected records and keeps dropped ones readable in the ledger", () => Effect.gen(function* () {
    const f = yield* fixture()
    const tight: ContextCompaction.Limits = { ...limits, retainedMaxTokens: 1 }
    const first = ContextCompaction.commit({
      sessionID: f.chat.id, messages: f.messages, limits: tight, mode: "auto", requestID: "carry-1",
      ranges: [{ startId: f.user.id, endId: f.assistant.id, summary: "First window." }],
    })
    expect(first[0]!.protectedRecords.map((record) => record.text)).toContain("Never push.")
    const taskOut = yield* f.session.updateMessage({
      id: MessageID.ascending(), sessionID: f.chat.id, parentID: f.last.id, role: "assistant",
      agent: "build", mode: "build", modelID: "test", providerID: "test",
      path: { cwd: ".", root: "." }, time: { created: 4 }, finish: "end_turn", cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } as MessageV2.Assistant)
    yield* f.session.updatePart({
      id: PartID.ascending(), messageID: taskOut.id, sessionID: f.chat.id,
      type: "tool", tool: "task", callID: "call_carry",
      state: { status: "completed", input: {}, output: "TASK EVIDENCE OUTPUT", title: "task", metadata: {}, time: { start: 1, end: 2 } },
    })
    // 大块可压正文，保证 block2 的提交过「保护后仍有正收益」守卫（真实历史远大于此）。
    yield* f.session.updatePart({
      id: PartID.ascending(), messageID: taskOut.id, sessionID: f.chat.id,
      type: "text", text: "Filler evidence. ".repeat(2000),
    })
    const user2 = yield* f.session.updateMessage({ ...f.user, id: MessageID.ascending(), time: { created: 5 } })
    yield* f.session.updatePart({
      id: PartID.ascending(), messageID: user2.id, sessionID: f.chat.id,
      type: "text", text: "Second window request.",
    })
    const messages = yield* f.session.messages({ sessionID: f.chat.id })
    // commit 入参必须是投影后视图（生产路径经 NativeRuntime.project）——原始消息里
    // 锚点没有 prt_context_ 渲染件，stale 守卫会正确拒绝。
    const view = ContextCompaction.project(messages, ContextCompaction.list(f.chat.id))
    const second = ContextCompaction.commit({
      sessionID: f.chat.id, messages: view, limits: tight, mode: "auto", requestID: "carry-2",
      ranges: [{ startId: f.user.id, endId: taskOut.id, summary: "Second window." }],
    })
    const texts = second[0]!.protectedRecords.map((record) => record.text)
    expect(texts).not.toContain("Never push.")
    expect(texts).toContain("TASK EVIDENCE OUTPUT")
    const projected = ContextCompaction.project(messages, ContextCompaction.list(f.chat.id))
    expect(JSON.stringify(projected)).not.toContain("Never push.")
    expect(JSON.stringify(projected)).toContain("Second window request.")
    expect(ContextCompaction.search(f.chat.id, "Never push.", tight).results.length).toBeGreaterThan(0)
  }))

  it.instance("rejects an invalid batch before changing any projection", () => Effect.gen(function* () {
    const f = yield* fixture()
    expect(() => ContextCompaction.commit({
      sessionID: f.chat.id, messages: f.messages, limits, mode: "auto", requestID: "invalid",
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
      limits, mode: "auto", requestID: "stale",
    })).toThrow("stale")
    expect(ContextCompaction.list(f.chat.id)).toEqual([])
  }))
})
