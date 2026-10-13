import { describe, expect, test } from "bun:test"

import { resolveCompactionState } from "./compaction-state"
import type { AssistantMessage, Part } from "@redcode-ai/sdk/v2"

// 261013 Red GUI 压缩状态判据单测：与 TUI
// packages/opencode/src/cli/cmd/tui/routes/session/index.tsx 的
// compactionMessage / compactionError / compacting 三个 memo 逐条对齐。

const compactionPart = (tokens?: { before?: number; after?: number }): Part =>
  ({
    id: "p1",
    sessionID: "s1",
    messageID: "u1",
    type: "compaction",
    auto: true,
    tokens_before: tokens?.before,
    tokens_after: tokens?.after,
  }) as unknown as Part

const textPart = (id: string): Part => ({ id, sessionID: "s1", messageID: "u1", type: "text", text: "hi" }) as Part

const summaryMessage = (id: string, over?: Partial<AssistantMessage>): AssistantMessage =>
  ({
    id,
    sessionID: "s1",
    role: "assistant",
    parentID: "u1",
    mode: "compaction",
    time: { created: 10 },
    ...over,
  }) as unknown as AssistantMessage

const base = {
  userMessageID: "u1",
  userParts: [compactionPart({ before: 120000, after: 30000 })],
  assistantMessages: [] as AssistantMessage[],
  sessionCompacting: undefined,
  isLatestMarker: true,
}

describe("resolveCompactionState — 存在性", () => {
  test("无 compaction marker → incomplete（不猜状态）", () => {
    const result = resolveCompactionState({ ...base, userParts: [textPart("t1")] })
    expect(result.state).toBe("incomplete")
    expect(result.attemptStarted).toBe(false)
    expect(result.tokensBefore).toBeUndefined()
  })

  test("marker 已创建但 process 尚未开始 → 不误报为已开始", () => {
    const result = resolveCompactionState({
      ...base,
      userParts: [compactionPart()],
      assistantMessages: [],
      sessionCompacting: undefined,
    })
    expect(result.state).toBe("incomplete")
    expect(result.attemptStarted).toBe(false)
  })
})

describe("resolveCompactionState — 终态", () => {
  test("tokens_after 已回填 → success，带 tokens_before/after", () => {
    const result = resolveCompactionState(base)
    expect(result).toEqual({ state: "success", attemptStarted: true, tokensBefore: 120000, tokensAfter: 30000 })
  })

  test("摘要带 UnknownError → failed，reason 取 error.data.message", () => {
    const result = resolveCompactionState({
      ...base,
      userParts: [compactionPart({ before: 120000 })],
      assistantMessages: [
        summaryMessage("a1", {
          error: { name: "UnknownError", data: { message: "provider exploded" } },
        } as unknown as Partial<AssistantMessage>),
      ],
    })
    expect(result.state).toBe("failed")
    expect(result.reason).toBe("provider exploded")
    expect(result.tokensBefore).toBe(120000)
    expect(result.tokensAfter).toBeUndefined()
  })

  test("摘要带 MessageAbortedError → canceled", () => {
    const result = resolveCompactionState({
      ...base,
      userParts: [compactionPart()],
      assistantMessages: [
        summaryMessage("a1", {
          error: { name: "MessageAbortedError", data: { message: "用户取消" } },
        } as unknown as Partial<AssistantMessage>),
      ],
    })
    expect(result.state).toBe("canceled")
    expect(result.reason).toBe("用户取消")
  })

  test("error.data.message 不是字符串 → reason 回退 error.name", () => {
    const result = resolveCompactionState({
      ...base,
      userParts: [compactionPart()],
      assistantMessages: [
        summaryMessage("a1", {
          error: { name: "MessageOutputLengthError", data: { attempts: 3 } },
        } as unknown as Partial<AssistantMessage>),
      ],
    })
    expect(result.state).toBe("failed")
    expect(result.reason).toBe("MessageOutputLengthError")
  })

  test("error 优先于 tokens_after（终态不被已回填数字覆盖）", () => {
    const result = resolveCompactionState({
      ...base,
      assistantMessages: [
        summaryMessage("a1", {
          error: { name: "UnknownError", data: { message: "late failure" } },
        } as unknown as Partial<AssistantMessage>),
      ],
    })
    expect(result.state).toBe("failed")
    expect(result.tokensAfter).toBe(30000)
  })

  test("多个 compaction 摘要取 findLast：最后的 error 定终态", () => {
    const result = resolveCompactionState({
      ...base,
      userParts: [compactionPart()],
      assistantMessages: [
        summaryMessage("a1"),
        summaryMessage("a2", {
          error: { name: "MessageAbortedError", data: { message: "aborted" } },
        } as unknown as Partial<AssistantMessage>),
      ],
    })
    expect(result.state).toBe("canceled")
    expect(result.reason).toBe("aborted")
  })
})

describe("resolveCompactionState — 摘要识别", () => {
  test("parentID 不匹配 / mode 非 compaction 的 assistant 不算摘要", () => {
    const result = resolveCompactionState({
      ...base,
      userParts: [compactionPart()],
      assistantMessages: [
        summaryMessage("a1", { parentID: "other", mode: "compaction" }),
        summaryMessage("a2", { parentID: "u1", mode: "normal" }),
      ],
      sessionCompacting: 100,
    })
    // 没有可识别摘要，但 session 仍显示当前 marker 正在处理。
    expect(result.state).toBe("pending")
  })

  test("正常 parent + mode 的摘要 completed 未定义 + compating → pending", () => {
    const result = resolveCompactionState({
      ...base,
      userParts: [compactionPart({ before: 120000 })],
      assistantMessages: [summaryMessage("a1")],
      sessionCompacting: 100,
    })
    expect(result.state).toBe("pending")
    expect(result.tokensBefore).toBe(120000)
  })
})

describe("resolveCompactionState — pending 判据", () => {
  test("非最新 marker → incomplete（即使 session.time.compacting 存在）", () => {
    const result = resolveCompactionState({
      ...base,
      userParts: [compactionPart()],
      assistantMessages: [summaryMessage("a1")],
      sessionCompacting: 100,
      isLatestMarker: false,
    })
    expect(result.state).toBe("incomplete")
  })

  test("session.time.compacting 不存在 → incomplete", () => {
    const result = resolveCompactionState({
      ...base,
      userParts: [compactionPart()],
      assistantMessages: [summaryMessage("a1")],
    })
    expect(result.state).toBe("incomplete")
  })

  test("摘要已 completed 且无 tokens_after → incomplete（未完成）", () => {
    const result = resolveCompactionState({
      ...base,
      userParts: [compactionPart()],
      assistantMessages: [summaryMessage("a1", { time: { created: 10, completed: 20 } })],
      sessionCompacting: 100,
    })
    expect(result.state).toBe("incomplete")
  })

  test("摘要创建晚于 compacting start 时仍按 TUI 判据 pending", () => {
    const result = resolveCompactionState({
      ...base,
      userParts: [compactionPart({ before: 120000 })],
      assistantMessages: [summaryMessage("a1", { time: { created: 101, completed: 102 } })],
      sessionCompacting: 100,
    })
    expect(result.state).toBe("pending")
  })
})
