import { describe, expect, test } from "bun:test"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
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

  // 261010 Red 现场：负的回收需求只选第一条 user；遗留 running 工具又让整批提交失败。
  const assistant: MessageV2.WithParts = {
    info: {
      id: MessageID.make("msg_native_assistant"), sessionID, role: "assistant", parentID: messageID,
      agent: "build", mode: "build", modelID: ModelID.make("test"), providerID: ProviderID.make("test"),
      path: { cwd: ".", root: "." }, time: { created: 2 }, finish: "stop", cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{
      id: PartID.make("prt_native_assistant"), sessionID, messageID: MessageID.make("msg_native_assistant"),
      type: "text", text: "Read logs, found the failure, and restored the configuration.",
    }],
  }
  const latest: MessageV2.WithParts = {
    ...message, info: { ...message.info, id: MessageID.make("msg_latest"), time: { created: 4 } },
  }

  test("a small history is not reduced to its first user message", () => {
    expect(selectAutomatic([message, assistant, latest], 40000, 16000, () => 1000))
      .toEqual([message, assistant])
  })

  // 261010 Red 触发按完整请求（含固定前缀），选段回收需求也按完整请求算；缺省退回粗估。
  test("current anchor scales the recovery requirement beyond the history estimate", () => {
    const history = [message, ...Array.from({ length: 28 }, () => assistant), latest]
    // 粗估总量 30000 < target：required 只剩 summaryMax 垫底，压 16 条就够
    expect(selectAutomatic(history, 40000, 16000, () => 1000)).toHaveLength(16)
    // 完整请求 100000：required=76000，按 100000/30000 归一后每条释放 3333，需 23 条
    expect(selectAutomatic(history, 40000, 16000, () => 1000, undefined, 100000)).toHaveLength(23)
  })

  test.each(["pending", "running"] as const)("automatic selection skips %s tools", (status) => {
    const blocked: MessageV2.WithParts = {
      ...assistant,
      info: { ...assistant.info, id: MessageID.make("msg_blocked") },
      parts: [{
        id: PartID.make("prt_blocked"), sessionID, messageID: MessageID.make("msg_blocked"),
        type: "tool", tool: "bash", callID: "call_blocked",
        state: status === "pending"
          ? { status, input: {}, raw: "" }
          : { status, input: {}, time: { start: 1 } },
      }],
    }
    expect(selectAutomatic([message, blocked, assistant, latest], 40000, 16000, () => 20000))
      .toEqual([assistant])
  })

  test("image-only input is the latest actual user request", () => {
    const image: MessageV2.WithParts = {
      ...latest,
      parts: [{
        id: PartID.make("prt_image"), sessionID, messageID: latest.info.id,
        type: "file", mime: "image/png", url: "data:image/png;base64,AA==",
      }],
    }
    expect(selectAutomatic([message, assistant, image], 40000, 16000, () => 1000))
      .toEqual([message, assistant])
  })

  test("fully protected history is rejected before asking for a summary", () => {
    expect(() => selectAutomatic([message, latest], 40000, 16000, () => 1000, () => 1000))
      .toThrow("No compressible closed history")
  })
})
