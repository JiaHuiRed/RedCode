import { describe, expect, test } from "bun:test"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import type { MessageV2 } from "../../src/session/message-v2"
import { annotate, assertExclusive, summaryPrompt, selectAutomatic } from "../../src/session/native-context"

const sessionID = SessionID.make("ses_native_context")
const messageID = MessageID.make("msg_native_context")
const message: MessageV2.WithParts = {
  info: {
    id: messageID,
    sessionID,
    role: "user",
    agent: "build",
    model: { providerID: "test", modelID: "test" } as MessageV2.User["model"],
    time: { created: 1 },
  },
  parts: [{ id: PartID.make("prt_native_context"), sessionID, messageID, type: "text", text: "Keep this exact." }],
}

describe("native context boundary", () => {
  test("references are deterministic, bounded and do not change stored messages", () => {
    const before = structuredClone(message)
    const first = annotate([message], 2)
    expect(first[0]?.parts.at(-1)).toMatchObject({ synthetic: true, text: `[History reference: ${messageID}]` })
    expect(annotate(first, 2)).toEqual(first)
    expect(message).toEqual(before)
    expect(() => annotate([message, message], 1)).toThrow("message budget")
  })

  test("queued user input remains untouched", () => {
    const queued: MessageV2.WithParts = {
      ...message,
      info: { ...message.info, role: "user", delivery: "queued" } as MessageV2.User,
    }
    expect(annotate([queued], 2)).toEqual([queued])
  })

  test("two compaction owners cannot be enabled together", () => {
    expect(() => assertExclusive(["read", "dcp_read"])).toThrow("DCP")
    expect(() => assertExclusive(["compress"])).toThrow("DCP")
    expect(() => assertExclusive(["read", "task"])).not.toThrow()
  })

  test("automatic summaries preserve provenance rather than granting new authority", () => {
    const prompt = summaryPrompt(16000)
    expect(prompt).toContain("16000")
    expect(prompt).toContain("not new authorization")
    expect(prompt).toContain("unfinished")
  })

  test("automatic selection never consumes the latest actual user request", () => {
    const messages = [message, {
      ...message, info: { ...message.info, id: MessageID.make("msg_new_user"), time: { created: 2 } },
    }]
    expect(selectAutomatic(messages, 160000, 16000, () => 150000)).toEqual([message])
  })

  // 261010 Red queued 输入不是「当前请求」：作为边界会让 selected 罩住 commit 保护的
  // 已交付 latestUser（commit 按 delivery 过滤），整批被拒。口径必须一致。
  test("automatic selection ignores queued input as the compaction boundary", () => {
    const delivered: MessageV2.WithParts = {
      ...message, info: { ...message.info, id: MessageID.make("msg_delivered"), time: { created: 2 } },
    }
    const queued: MessageV2.WithParts = {
      ...message,
      info: { ...message.info, id: MessageID.make("msg_queued"), time: { created: 3 }, delivery: "queued" } as MessageV2.User,
    }
    expect(selectAutomatic([message, delivered, queued], 160000, 16000, () => 150000)).toEqual([message])
  })
})
