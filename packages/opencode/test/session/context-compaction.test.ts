import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Session } from "../../src/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import * as ContextCompaction from "../../src/session/context-compaction"
import { Token } from "../../src/util/token"
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

  // 261012 Red 预算必须覆盖完整渲染正文；过大的一条不能挡住后面能装下的证据。
  it.instance("skips oversized inherited records and charges provenance to the shared budget", () => Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.session.updatePart({
      id: PartID.ascending(), messageID: f.assistant.id, sessionID: f.chat.id,
      type: "tool", tool: "task", callID: "small",
      state: { status: "completed", input: {}, output: "SMALL EVIDENCE", title: "task", metadata: {}, time: { start: 1, end: 2 } },
    })
    const big = yield* f.session.updateMessage({
      ...f.assistant, id: MessageID.ascending(), parentID: f.last.id, time: { created: 4 },
    } as MessageV2.Assistant)
    yield* f.session.updatePart({
      id: PartID.ascending(), messageID: big.id, sessionID: f.chat.id,
      type: "tool", tool: "task", callID: "big",
      state: { status: "completed", input: {}, output: "OVERSIZED ".repeat(1000), title: "task", metadata: {}, time: { start: 3, end: 4 } },
    })
    const latest = yield* f.session.updateMessage({ ...f.user, id: MessageID.ascending(), time: { created: 5 } })
    yield* f.session.updatePart({ id: PartID.ascending(), messageID: latest.id, sessionID: f.chat.id, type: "text", text: "Continue." })
    const messages = yield* f.session.messages({ sessionID: f.chat.id })
    const first = ContextCompaction.commit({
      sessionID: f.chat.id, messages, limits, mode: "auto", requestID: "skip-first",
      ranges: [{ startId: f.user.id, endId: big.id, summary: "Initial evidence." }],
    })[0]!
    const view = ContextCompaction.project(messages, ContextCompaction.list(f.chat.id))
    const tight = { ...limits, retainedMaxTokens: 160 }
    const second = ContextCompaction.commit({
      sessionID: f.chat.id, messages: view, limits: tight, mode: "auto", requestID: "skip-second",
      ranges: [{ startId: f.user.id, endId: f.user.id, summary: "Updated evidence." }],
    })[0]!
    expect(second.protectedRecords.map((record) => record.text)).toContain("SMALL EVIDENCE")
    const empty = { ...second, protectedRecords: [] }
    expect(Token.estimate(ContextCompaction.render(second)) - Token.estimate(ContextCompaction.render(empty)))
      .toBeLessThanOrEqual(tight.retainedMaxTokens)
    expect(ContextCompaction.retainedTokens(view[0]!, [first], tight))
      .toBeLessThanOrEqual(tight.retainedMaxTokens)
    expect(ContextCompaction.read(f.chat.id, `block:${first.id}`, 0, limits).text).toContain("OVERSIZED")
  }))

  for (const boundary of ["tokens", "bytes"] as const) {
    it.instance(`fits fresh protected output to ${boundary} limits without changing raw evidence`, () => Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.session.updatePart({
        id: PartID.ascending(), messageID: f.assistant.id, sessionID: f.chat.id,
        type: "tool", tool: "task", callID: "fresh-large",
        state: { status: "completed", input: {}, output: "大段工具证据".repeat(1000), title: "task", metadata: {}, time: { start: 1, end: 2 } },
      })
      const messages = yield* f.session.messages({ sessionID: f.chat.id })
      const tight = {
        ...limits,
        activeMaxTokens: boundary === "tokens" ? 512 : 4096,
        activeMaxBytes: boundary === "bytes" ? 1200 : 65536,
      }
      const block = ContextCompaction.commit({
        sessionID: f.chat.id, messages, limits: tight, mode: "auto", requestID: "fresh-budget",
        ranges: [{ startId: f.user.id, endId: f.assistant.id, summary: "Completed investigation; original evidence is available by source reference." }],
      })[0]!
      expect(Token.estimate(ContextCompaction.render(block))).toBeLessThanOrEqual(tight.activeMaxTokens)
      expect(Buffer.byteLength(ContextCompaction.render(block))).toBeLessThanOrEqual(tight.activeMaxBytes)
      expect(block.protectedRecords.map((record) => record.text)).toContain("Never push.")
      expect(block.protectedRecords.some((record) => record.tool === "task")).toBe(false)
      const offset = ContextCompaction.content(ContextCompaction.getRaw(f.chat.id, f.assistant.id)).indexOf("大段工具证据")
      expect(ContextCompaction.read(f.chat.id, f.assistant.id, offset, limits).text).toContain("大段工具证据")
      expect(ContextCompaction.search(f.chat.id, "大段工具证据", limits).results.length).toBeGreaterThan(0)
      expect(yield* f.session.messages({ sessionID: f.chat.id })).toEqual(messages)
      ContextCompaction.deactivate(f.chat.id, block.id)
      expect(ContextCompaction.project(messages, ContextCompaction.list(f.chat.id))).toEqual(messages)
    }))
  }

  it.instance("shares inherited budget across consumed blocks", () => Effect.gen(function* () {
    const f = yield* fixture()
    const next = yield* f.session.updateMessage({
      ...f.assistant, id: MessageID.ascending(), parentID: f.last.id, time: { created: 4 },
    } as MessageV2.Assistant)
    yield* f.session.updatePart({ id: PartID.ascending(), messageID: next.id, sessionID: f.chat.id, type: "text", text: "Evidence. ".repeat(1000) })
    for (const owner of [f.assistant, next]) {
      yield* f.session.updatePart({
        id: PartID.ascending(), messageID: owner.id, sessionID: f.chat.id,
        type: "tool", tool: "task", callID: `task-${owner.id}`,
        state: { status: "completed", input: {}, output: "VERBATIM TASK PROOF", title: "task", metadata: {}, time: { start: 1, end: 2 } },
      })
    }
    const latest = yield* f.session.updateMessage({ ...f.user, id: MessageID.ascending(), time: { created: 5 } })
    yield* f.session.updatePart({ id: PartID.ascending(), messageID: latest.id, sessionID: f.chat.id, type: "text", text: "Continue." })
    const messages = yield* f.session.messages({ sessionID: f.chat.id })
    ContextCompaction.commit({
      sessionID: f.chat.id, messages, limits, mode: "auto", requestID: "two-old",
      ranges: [
        { startId: f.user.id, endId: f.assistant.id, summary: "First investigation." },
        { startId: f.last.id, endId: next.id, summary: "Second investigation." },
      ],
    })
    const view = ContextCompaction.project(messages, ContextCompaction.list(f.chat.id))
    const tight = { ...limits, retainedMaxTokens: 100 }
    const block = ContextCompaction.commit({
      sessionID: f.chat.id, messages: view, limits: tight, mode: "auto", requestID: "merge-old",
      ranges: [{ startId: f.user.id, endId: f.last.id, summary: "Merged investigations." }],
    })[0]!
    expect(block.consumedBlockIDs).toHaveLength(2)
    expect(Token.estimate(ContextCompaction.render(block)) - Token.estimate(ContextCompaction.render({ ...block, protectedRecords: [] })))
      .toBeLessThanOrEqual(tight.retainedMaxTokens)
    expect(block.protectedRecords.filter((record) => record.kind === "user")).toHaveLength(2)
  }))

  // 261012 Red 单项/多项/多轮场景走真实账本，预算超限不吞原文或撤掉安全守卫。
  it.instance("runs eight task windows with bounded projections and reversible history", () => Effect.gen(function* () {
    const f = yield* fixture()
    const tight = { ...limits, retainedMaxTokens: 160, activeMaxTokens: 512, activeMaxBytes: 1600 }
    const totals: number[] = []
    for (let round = 0; round < 8; round++) {
      const task = yield* f.session.updateMessage({
        ...f.assistant, id: MessageID.ascending(), parentID: f.last.id, time: { created: 4 + round * 2 },
      } as MessageV2.Assistant)
      yield* f.session.updatePart({
        id: PartID.ascending(), messageID: task.id, sessionID: f.chat.id,
        type: "tool", tool: "task", callID: `round-${round}`,
        state: { status: "completed", input: {}, output: `PROOF_${round} `.repeat(1000), title: "task", metadata: {}, time: { start: 1, end: 2 } },
      })
      yield* f.session.updatePart({
        id: PartID.ascending(), messageID: task.id, sessionID: f.chat.id,
        type: "text", text: "Unprotected investigation logs. ".repeat(1000),
      })
      const latest = yield* f.session.updateMessage({ ...f.user, id: MessageID.ascending(), time: { created: 5 + round * 2 } })
      yield* f.session.updatePart({ id: PartID.ascending(), messageID: latest.id, sessionID: f.chat.id, type: "text", text: `Next task ${round}.` })
      const messages = yield* f.session.messages({ sessionID: f.chat.id })
      const view = ContextCompaction.project(messages, ContextCompaction.list(f.chat.id))
      const input = {
        sessionID: f.chat.id, messages: view, limits: tight, mode: "auto" as const, requestID: `window-${round}`,
        ranges: [{ startId: f.user.id, endId: task.id, summary: `Task ${round} finished with verified evidence.` }],
      }
      const blocks = ContextCompaction.commit(input)
      expect(ContextCompaction.commit(input)).toEqual(blocks)
      const active = ContextCompaction.list(f.chat.id)
      expect(active).toHaveLength(1)
      const text = active.map(ContextCompaction.render).join("\n")
      totals.push(Token.estimate(text))
      expect(totals.at(-1)!).toBeLessThanOrEqual(tight.activeMaxTokens)
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(tight.activeMaxBytes)
      expect(ContextCompaction.project(messages, active).at(-1)!.info.id).toBe(latest.id)
      expect(ContextCompaction.search(f.chat.id, `PROOF_${round}`, limits).results.length).toBeGreaterThan(0)
      expect(yield* f.session.messages({ sessionID: f.chat.id })).toEqual(messages)
    }
    const raw = yield* f.session.messages({ sessionID: f.chat.id })
    for (let round = 0; round < 8; round++) {
      const block = ContextCompaction.list(f.chat.id)[0]!
      ContextCompaction.deactivate(f.chat.id, block.id)
    }
    expect(ContextCompaction.project(raw, ContextCompaction.list(f.chat.id))).toEqual(raw)
    expect(totals).toHaveLength(8)
  }))

  it.instance("still rejects summaries that cannot fit even without protection", () => Effect.gen(function* () {
    const f = yield* fixture()
    expect(() => ContextCompaction.commit({
      sessionID: f.chat.id, messages: f.messages,
      limits: { ...limits, activeMaxBytes: 1 }, mode: "auto", requestID: "no-summary-room",
      ranges: [{ startId: f.user.id, endId: f.assistant.id, summary: "Required summary." }],
    })).toThrow("compression budget")
    expect(ContextCompaction.list(f.chat.id)).toEqual([])
    expect(ContextCompaction.project(f.messages, [])).toEqual(f.messages)
  }))

  it.instance("fits a new range without rewriting untouched active blocks", () => Effect.gen(function* () {
    const f = yield* fixture()
    const first = ContextCompaction.commit({
      sessionID: f.chat.id, messages: f.messages, limits, mode: "auto", requestID: "untouched-first",
      ranges: [{ startId: f.user.id, endId: f.assistant.id, summary: "Earlier work completed." }],
    })[0]!
    const task = yield* f.session.updateMessage({
      ...f.assistant, id: MessageID.ascending(), parentID: f.last.id, time: { created: 4 },
    } as MessageV2.Assistant)
    yield* f.session.updatePart({
      id: PartID.ascending(), messageID: task.id, sessionID: f.chat.id,
      type: "tool", tool: "task", callID: "untouched-task",
      state: { status: "completed", input: {}, output: "BIG PROOF ".repeat(10000), title: "task", metadata: {}, time: { start: 1, end: 2 } },
    })
    const latest = yield* f.session.updateMessage({ ...f.user, id: MessageID.ascending(), time: { created: 5 } })
    yield* f.session.updatePart({ id: PartID.ascending(), messageID: latest.id, sessionID: f.chat.id, type: "text", text: "Continue." })
    const messages = yield* f.session.messages({ sessionID: f.chat.id })
    const view = ContextCompaction.project(messages, ContextCompaction.list(f.chat.id))
    const tight = { ...limits, activeMaxTokens: 512, activeMaxBytes: 2000 }
    const range = [{ startId: f.last.id, endId: task.id, summary: "New task completed." }]
    // 导入器的预算仍严格拒绝，不把不完整导入悄悄包装成成功。
    expect(() => ContextCompaction.commit({
      sessionID: f.chat.id, messages: view, limits: tight, mode: "import", requestID: "strict-import", ranges: range,
    })).toThrow()
    expect(ContextCompaction.list(f.chat.id)).toEqual([first])
    ContextCompaction.commit({
      sessionID: f.chat.id, messages: view, limits: tight, mode: "auto", requestID: "untouched-second", ranges: range,
    })
    const active = ContextCompaction.list(f.chat.id)
    expect(active.find((block) => block.id === first.id)).toEqual(first)
    expect(Buffer.byteLength(active.map(ContextCompaction.render).join("\n"))).toBeLessThanOrEqual(tight.activeMaxBytes)
    expect(Token.estimate(active.map(ContextCompaction.render).join("\n"))).toBeLessThanOrEqual(tight.activeMaxTokens)
    expect(ContextCompaction.search(f.chat.id, "BIG PROOF", limits).results.length).toBeGreaterThan(0)
  }))

  // 261012 Red 故意反置 ID 字典序，携带优先级必须跟实际来源顺序走。
  it.instance("retains the recent user source rather than the lexicographically larger ID", () => Effect.gen(function* () {
    const f = yield* fixture()
    const older = yield* f.session.updateMessage({ ...f.user, id: MessageID.make("msg_z_older"), time: { created: 4 } })
    const olderText = "OLDER_USER".repeat(20)
    yield* f.session.updatePart({ id: PartID.ascending(), messageID: older.id, sessionID: f.chat.id, type: "text", text: olderText })
    const middle = yield* f.session.updateMessage({
      ...f.assistant, id: MessageID.ascending(), parentID: older.id, time: { created: 5 },
    } as MessageV2.Assistant)
    yield* f.session.updatePart({ id: PartID.ascending(), messageID: middle.id, sessionID: f.chat.id, type: "text", text: "Investigation. ".repeat(1000) })
    const newer = yield* f.session.updateMessage({ ...f.user, id: MessageID.make("msg_a_newer"), time: { created: 6 } })
    const newerText = "NEWER_USER".repeat(20)
    yield* f.session.updatePart({ id: PartID.ascending(), messageID: newer.id, sessionID: f.chat.id, type: "text", text: newerText })
    const latest = yield* f.session.updateMessage({ ...f.user, id: MessageID.ascending(), time: { created: 7 } })
    yield* f.session.updatePart({ id: PartID.ascending(), messageID: latest.id, sessionID: f.chat.id, type: "text", text: "Current request." })
    const messages = yield* f.session.messages({ sessionID: f.chat.id })
    expect(older.id > newer.id).toBe(true)
    const first = ContextCompaction.commit({
      sessionID: f.chat.id, messages, limits, mode: "auto", requestID: "reverse-first",
      ranges: [{ startId: older.id, endId: newer.id, summary: "Both decisions remain available." }],
    })[0]!
    expect(first.protectedRecords.filter((record) => record.kind === "user")).toHaveLength(2)
    const view = ContextCompaction.project(messages, ContextCompaction.list(f.chat.id))
    const second = ContextCompaction.commit({
      sessionID: f.chat.id, messages: view, limits: { ...limits, retainedMaxTokens: 96 },
      mode: "auto", requestID: "reverse-second",
      ranges: [{ startId: older.id, endId: older.id, summary: "Latest decision." }],
    })[0]!
    expect(second.protectedRecords.map((record) => record.messageID)).toEqual([newer.id])
    expect(second.protectedRecords[0]!.text).toBe(newerText)
    expect(ContextCompaction.read(f.chat.id, older.id, 0, limits).text).toContain(olderText)
    expect(ContextCompaction.project(messages, ContextCompaction.list(f.chat.id)).at(-1)!.info.id).toBe(latest.id)
    expect(yield* f.session.messages({ sessionID: f.chat.id })).toEqual(messages)
  }))

  it.instance("fits two fresh ranges to one global budget and preserves raw evidence", () => Effect.gen(function* () {
    const f = yield* fixture()
    const next = yield* f.session.updateMessage({
      ...f.assistant, id: MessageID.ascending(), parentID: f.last.id, time: { created: 4 },
    } as MessageV2.Assistant)
    yield* f.session.updatePart({ id: PartID.ascending(), messageID: next.id, sessionID: f.chat.id, type: "text", text: "Investigation. ".repeat(1000) })
    for (const [index, owner] of [f.assistant, next].entries()) {
      yield* f.session.updatePart({
        id: PartID.ascending(), messageID: owner.id, sessionID: f.chat.id,
        type: "tool", tool: "task", callID: `global-${index}`,
        state: { status: "completed", input: {}, output: `PROOF_${index}:` + "证".repeat(200), title: "task", metadata: {}, time: { start: 1, end: 2 } },
      })
    }
    const latest = yield* f.session.updateMessage({ ...f.user, id: MessageID.ascending(), time: { created: 5 } })
    yield* f.session.updatePart({ id: PartID.ascending(), messageID: latest.id, sessionID: f.chat.id, type: "text", text: "Current request." })
    const messages = yield* f.session.messages({ sessionID: f.chat.id })
    const tight = { ...limits, activeMaxTokens: 300, activeMaxBytes: 1600 }
    const input = {
      sessionID: f.chat.id, messages, limits: tight, mode: "auto" as const, requestID: "global-fresh",
      ranges: [
        { startId: f.user.id, endId: f.assistant.id, summary: "First task." },
        { startId: f.last.id, endId: next.id, summary: "Second task." },
      ],
    }
    const blocks = ContextCompaction.commit(input)
    expect(blocks).toHaveLength(2)
    expect(ContextCompaction.commit(input)).toEqual(blocks)
    const records = blocks.flatMap((block) => block.protectedRecords)
    expect(records.filter((record) => record.kind === "user").map((record) => record.text).sort())
      .toEqual(["Continue implementation.", "Never push."])
    expect(records.filter((record) => record.kind === "tool").map((record) => record.messageID)).toEqual([next.id])
    const text = ContextCompaction.list(f.chat.id).map(ContextCompaction.render).join("\n")
    expect(Token.estimate(text)).toBeLessThanOrEqual(tight.activeMaxTokens)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(tight.activeMaxBytes)
    for (const [index, owner] of [f.assistant, next].entries()) {
      const raw = ContextCompaction.content(ContextCompaction.getRaw(f.chat.id, owner.id))
      expect(ContextCompaction.read(f.chat.id, owner.id, raw.indexOf(`PROOF_${index}`), limits).text).toContain(`PROOF_${index}`)
    }
    expect(ContextCompaction.project(messages, ContextCompaction.list(f.chat.id)).at(-1)!.info.id).toBe(latest.id)
    expect(yield* f.session.messages({ sessionID: f.chat.id })).toEqual(messages)
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

  // 261022 Red 窗口边界（拟修 B）：投影视图里最后一个活跃锚点之后才是下一段可压历史。
  // 决策：docs/notes/proposed/architecture/2026-10-22-anchored-window-compaction.md
  it.instance("marks the first message after the last active anchor as the window boundary", () => Effect.gen(function* () {
    const f = yield* fixture()
    expect(ContextCompaction.windowBoundary(f.messages, [])).toBe(0)
    const block = ContextCompaction.commit({
      sessionID: f.chat.id, messages: f.messages, limits, mode: "auto", requestID: "boundary-first",
      ranges: [{ startId: f.user.id, endId: f.assistant.id, summary: "Earlier work." }],
    })[0]!
    const view = ContextCompaction.project(f.messages, ContextCompaction.list(f.chat.id))
    // 投影视图 = [锚点渲染, last]：边界落在渲染之后，原始消息序不参与计算
    expect(ContextCompaction.windowBoundary(view, [block])).toBe(1)
    expect(ContextCompaction.windowBoundary(view, [])).toBe(0)
  }))
})
