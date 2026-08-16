// 260816 Yuqi：mock @redcode-ai/ui/message-part（tsx → solid-js），只测行生成逻辑。
// 真实实现的纯函数部分等价：renderable 判空逻辑、groupParts 单 group 映射。
import { describe, expect, mock, test } from "bun:test"

mock.module("@redcode-ai/ui/message-part", () => {
  const renderable = (part: { type: string; text?: string }) => {
    if (part.type === "tool") return true
    if (part.type === "text") return !!part.text?.trim()
    if (part.type === "reasoning") return !!part.text?.trim()
    return false
  }
  const groupParts = (parts: { messageID: string; part: { id: string } }[]) =>
    parts.map((item) => ({
      key: `part:${item.messageID}:${item.part.id}`,
      type: "part" as const,
      ref: { messageID: item.messageID, partID: item.part.id },
    }))
  return { groupParts, renderable }
})

const { Timeline, TimelineRow } = await import("./message-timeline.data")

import type { AssistantMessage, Part, UserMessage } from "@redcode-ai/sdk/v2"

const userMessage = (id: string, created: number): UserMessage =>
  ({ id, sessionID: "s1", role: "user", time: { created } }) as UserMessage

const assistantMessage = (id: string, created: number, parentID: string): AssistantMessage =>
  ({ id, sessionID: "s1", role: "assistant", parentID, time: { created } }) as AssistantMessage

const textPart = (id: string, messageID: string): Part =>
  ({ id, sessionID: "s1", messageID, type: "text", text: "hello" }) as unknown as Part

type TimelineRow = ReturnType<typeof Timeline.constructMessageRows>[number]

const tags = (rows: TimelineRow[]) => rows.map((row) => row._tag)

describe("Timeline.constructMessageRows — AssistantPending 兜底", () => {
  const noParts = () => []

  test("assistant 骨架在但无可渲染 parts 且非 busy → 推 AssistantPending 而非消失", () => {
    const rows = Timeline.constructMessageRows(
      userMessage("u1", 1),
      noParts,
      [assistantMessage("a1", 2, "u1")],
      0,
      false,
      "idle",
      false,
    )
    expect(tags(rows)).toContain("AssistantPending")
    expect(tags(rows)).not.toContain("AssistantPart")
  })

  test("busy 时骨架无 parts → 推 Thinking 不推 AssistantPending（避免重复占位）", () => {
    const rows = Timeline.constructMessageRows(
      userMessage("u1", 1),
      noParts,
      [assistantMessage("a1", 2, "u1")],
      0,
      false,
      "busy",
      true,
    )
    expect(tags(rows)).toContain("Thinking")
    expect(tags(rows)).not.toContain("AssistantPending")
  })

  test("parts 完整 → 正常 AssistantPart，不推 AssistantPending", () => {
    const rows = Timeline.constructMessageRows(
      userMessage("u1", 1),
      () => [textPart("p1", "a1")],
      [assistantMessage("a1", 2, "u1")],
      0,
      false,
      "idle",
      false,
    )
    expect(tags(rows)).toContain("AssistantPart")
    expect(tags(rows)).not.toContain("AssistantPending")
  })

  test("有 error → 推 Error 不推 AssistantPending", () => {
    const failed = {
      ...assistantMessage("a1", 2, "u1"),
      error: { name: "APIError", message: "boom" },
    } as unknown as AssistantMessage
    const rows = Timeline.constructMessageRows(userMessage("u1", 1), noParts, [failed], 0, false, "idle", false)
    expect(tags(rows)).toContain("Error")
    expect(tags(rows)).not.toContain("AssistantPending")
  })

  test("无 assistant 消息 → 不推 AssistantPending", () => {
    const rows = Timeline.constructMessageRows(userMessage("u1", 1), noParts, [], 0, false, "idle", false)
    expect(tags(rows)).not.toContain("AssistantPending")
  })
})
