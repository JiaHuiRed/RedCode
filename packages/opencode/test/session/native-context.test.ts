import { describe, expect, test } from "bun:test"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import type { MessageV2 } from "../../src/session/message-v2"
import { annotate, assertExclusive, summaryPrompt, selectAutomatic, planAutomatic, cleanReferenceEchoes } from "../../src/session/native-context"

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
  const history: MessageV2.WithParts = {
    ...message,
    info: { ...message.info, id: MessageID.make("msg_history"), time: { created: 0 } },
  }

  test("references are deterministic, bounded and do not change stored messages", () => {
    const before = structuredClone(message)
    const first = annotate([history, message], 3)
    // 历史消息带引用；当前 user 轮（末条）原样返回，连对象引用都不换
    expect(first[0]?.parts.at(-1)).toMatchObject({ synthetic: true, text: "[History reference: " + history.info.id + "]" })
    expect(first[1]).toBe(message)
    expect(annotate(first, 3)).toEqual(first)
    expect(message).toEqual(before)
    expect(() => annotate([message, message], 1)).toThrow("message budget")
  })

  // 261014 Red 当前 user 轮的引用没有消费方（压缩边界本就保护它），却是模型按格式
  // 续写的靶子——GUI 实测整楼复述 `[History reference: msg_…]`，请求最后一段内容正是它。
  // 诊断：docs/notes/implemented/bug-fix/2026-10-14-native-history-reference-echo.md
  test("the current user turn carries no reference; history still does", () => {
    const out = annotate([history, message], 3)
    expect(out[0]?.parts.some((part) => part.type === "text" && part.synthetic)).toBe(true)
    expect(out[1]?.parts.some((part) => part.type === "text" && part.synthetic)).toBe(false)
    expect(out[1]).toBe(message)
  })

  test("a trailing assistant turn is still annotated", () => {
    const assistant: MessageV2.WithParts = {
      info: {
        id: MessageID.make("msg_assistant"),
        sessionID,
        role: "assistant",
        mode: "build",
        agent: "build",
        parentID: messageID,
        modelID: ModelID.make("test"),
        providerID: ProviderID.make("test"),
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0, miss: 0 } },
        time: { created: 2 },
      },
      parts: [{ id: PartID.make("prt_assistant"), sessionID, messageID: MessageID.make("msg_assistant"), type: "text", text: "Keep this exact." }],
    }
    const out = annotate([message, assistant], 3)
    expect(out.at(-1)?.parts.at(-1)).toMatchObject({ synthetic: true, text: "[History reference: " + assistant.info.id + "]" })
  })

  test("historical reference echoes are removed only from the outgoing assistant copy", () => {
    const marker = "[Historical reference: msg_001a180ffe3ca0015QYWW2GTomXHTT]"
    const assistant = {
      ...message,
      info: { ...message.info, role: "assistant" } as MessageV2.Assistant,
      parts: [{ id: PartID.make("prt_echo"), sessionID, messageID, type: "text" as const, text: `正文${marker}${marker}后续 \`${marker}\`` }],
    } satisfies MessageV2.WithParts
    const user: MessageV2.WithParts = { ...message, parts: [{ id: PartID.make("prt_user"), sessionID, messageID, type: "text", text: marker }] }
    const before = structuredClone([assistant, user])
    const out = cleanReferenceEchoes([assistant, user])
    expect(out[0]?.parts[0]).toMatchObject({ text: `正文后续 \`${marker}\`` })
    expect(out[1]).toBe(user)
    expect([assistant, user]).toEqual(before)
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

  // 261012 Red 现场形态（369,561→325,040 只放出 44k）：required 物理够不到时旧实现
  // 静默返回弱选段、commit 照样「成功」。planAutomatic 必须把差多少带出来。
  test("planAutomatic exposes shortfall when required is physically unreachable", () => {
    const plan = planAutomatic([message, assistant, latest], 40000, 16000, () => 1000, undefined, 100000)
    expect(plan.segment).toEqual([message, assistant])
    expect(plan.required).toBe(76_000)
    expect(plan.released).toBeLessThan(plan.required)
    expect(selectAutomatic([message, assistant, latest], 40000, 16000, () => 1000, undefined, 100000))
      .toEqual(plan.segment)
  })

  // 261012 Red 保护记录计入 total 却永不进入 released（回归笔记根因链第 2 条：锚点
  // retained 逐轮变大，required 越吃越够到）。口径扣除后需求只对能让步的内容提：
  // 30 条 × 400 = 12,000 估值的保留量按 100,000/30,000 归一为 40,000，required 从
  // 76,000 降到 36,000，选段随之从 23 条（上一测试）收缩到 18 条。
  test("required excludes retained content that can never be released", () => {
    const history = [message, ...Array.from({ length: 28 }, () => assistant), latest]
    const plan = planAutomatic(history, 40000, 16000, () => 1000, () => 400, 100000)
    expect(plan.required).toBe(36_000)
    expect(plan.segment).toHaveLength(18)
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

  // 261022 Red 窗口边界（拟修 B）：选段起点下移到最后活跃块之后，锚点不再恒为会话
  // 首条消息——每次压缩不再从头重写历史（摘要冷输入与压后缓存全灭的结构性根源）。
  // 决策：docs/notes/proposed/architecture/2026-10-22-anchored-window-compaction.md
  describe("windowed selection", () => {
    const second: MessageV2.WithParts = {
      ...message, info: { ...message.info, id: MessageID.make("msg_second"), time: { created: 2 } },
    }

    test("selection starts after the window floor instead of the first message", () => {
      expect(selectAutomatic([message, second, assistant, latest], 40000, 16000, () => 1000, undefined, 0, 2))
        .toEqual([assistant])
    })

    test("an unusable floor falls back to the full-history selection", () => {
      expect(selectAutomatic([message, assistant, latest], 40000, 16000, () => 1000, undefined, 0, 99))
        .toEqual([message, assistant])
    })

    test("the requirement stays on the full request while only the window is released", () => {
      const plan = planAutomatic(
        [message, assistant, { ...assistant, info: { ...assistant.info, id: MessageID.make("msg_assistant_2") } }, latest],
        40000, 16000, () => 1000, undefined, 100000, 1,
      )
      expect(plan.required).toBe(76_000)
      expect(plan.segment).toHaveLength(2)
      expect(plan.released).toBeLessThan(plan.required)
    })

    test("floor=0 preserves the legacy full-history selection", () => {
      expect(selectAutomatic([message, assistant, latest], 40000, 16000, () => 1000, undefined, 0, 0))
        .toEqual(selectAutomatic([message, assistant, latest], 40000, 16000, () => 1000))
    })
  })
})
