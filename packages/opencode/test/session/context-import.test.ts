import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Session } from "../../src/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import * as ContextCompaction from "../../src/session/context-compaction"
import { importDcp } from "../../src/session/context-import"
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
    yield* session.updatePart({
      id: PartID.ascending(), messageID: assistant.id, sessionID: chat.id, type: "text",
      text: "Investigation evidence. ".repeat(500),
    })
    const latest = yield* session.updateMessage({
      id: MessageID.ascending(), sessionID: chat.id, role: "user", agent: "build",
      model: { providerID: "test", modelID: "test" } as MessageV2.User["model"], time: { created: 3 },
    })
    yield* session.updatePart({ id: PartID.ascending(), messageID: latest.id, sessionID: chat.id, type: "text", text: "Continue." })
    return { chat, user, assistant, latest }
  })
}

function dcpState(block: { startId: string; endId: string; anchor: string; blockId?: number; active?: boolean }) {
  const blockId = block.blockId ?? 1
  return {
    prune: {
      tools: {},
      messages: {
        byMessageId: {},
        blocksById: {
          [blockId]: {
            blockId, runId: blockId, active: block.active ?? true, deactivatedByUser: false,
            compressedTokens: 1000, summaryTokens: 40, durationMs: 5, mode: "range",
            topic: "DCP import", startId: block.startId, endId: block.endId, anchorMessageId: block.anchor,
            compressMessageId: block.anchor, includedBlockIds: [], consumedBlockIds: [], parentBlockIds: [],
            directMessageIds: [block.startId, block.endId], directToolIds: [],
            effectiveMessageIds: [block.startId, block.endId], effectiveToolIds: [],
            createdAt: 1, summary: "Range covered the user constraint and the verified investigation evidence.",
          },
        },
        activeBlockIds: [blockId],
        activeByAnchorMessageId: { [block.anchor]: blockId },
        nextBlockId: blockId + 1, nextRunId: 1,
      },
    },
    nudges: { recovering: false, contextLimitAnchors: [] },
    stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
    lastUpdated: new Date().toISOString(),
  }
}

describe("DCP state import", () => {
  it.instance("imports active blocks, projects them and stays idempotent", () =>
    Effect.gen(function* () {
      const { chat, user, assistant } = yield* fixture()
      const first = importDcp(chat.id, dcpState({ startId: user.id, endId: assistant.id, anchor: assistant.id }), limits)
      expect(first.blocks).toHaveLength(1)
      expect(first.imported).toBe(1)
      const projected = ContextCompaction.project(
        MessageV2.filterCompactedOrdered(MessageV2.stream(chat.id)), ContextCompaction.list(chat.id),
      )
      expect(projected).toHaveLength(2)
      expect(JSON.stringify(projected[0])).toContain("DCP import")
      const before = ContextCompaction.list(chat.id).map((block) => block.id)
      const repeat = importDcp(chat.id, dcpState({ startId: user.id, endId: assistant.id, anchor: assistant.id }), limits)
      expect(repeat.imported).toBe(0)
      expect(repeat.blocks.map((block) => block.id)).toEqual(before)
    }))

  it.instance("rejects legacy, ambiguous and missing-source state without writing", () =>
    Effect.gen(function* () {
      const { chat, user, assistant } = yield* fixture()
      expect(() => importDcp(chat.id, { prune: { tools: {} }, stats: { pruneTokenCounter: 0, totalPruneTokens: 0 } }, limits))
        .toThrow("legacy")
      const ambiguous = dcpState({ startId: user.id, endId: assistant.id, anchor: assistant.id })
      ;(ambiguous.prune.messages.blocksById["1"] as Record<string, unknown>).active = false
      expect(() => importDcp(chat.id, ambiguous, limits)).toThrow("ambiguous")
      expect(() => importDcp(chat.id, dcpState({ startId: "msg_missing", endId: assistant.id, anchor: assistant.id }), limits))
        .toThrow("missing from this session")
      expect(ContextCompaction.list(chat.id)).toHaveLength(0)
    }))

  it.instance("refuses to merge into a foreign ledger and keeps latest user protected", () =>
    Effect.gen(function* () {
      const { chat, user, assistant, latest } = yield* fixture()
      // 账本为空时 latest user 保护由 commit 兜底；非空时合并拒绝先拦。
      expect(() => importDcp(chat.id, dcpState({ startId: user.id, endId: latest.id, anchor: latest.id }), limits))
        .toThrow("current user request")
      importDcp(chat.id, dcpState({ startId: user.id, endId: assistant.id, anchor: assistant.id }), limits)
      const other = dcpState({ startId: user.id, endId: assistant.id, anchor: assistant.id, blockId: 9 })
      expect(() => importDcp(chat.id, other, limits)).toThrow("refusing to merge")
    }))
})
