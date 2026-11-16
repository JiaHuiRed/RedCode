import { describe, expect, test } from "bun:test"
import { appendReference, buildReference, REFERENCE_TEXT_LIMIT, referenceLabel } from "./reference"
import type { Prompt } from "@/context/prompt"

describe("buildReference", () => {
  test("keeps a traceable source header with message and part ids", () => {
    const reference = buildReference({
      anchor: { kind: "message", sessionID: "ses_1", messageID: "msg_2", partID: "prt_3", role: "assistant" },
      text: "the failing line\nsecond line",
      at: 0,
    })

    expect(reference.block.startsWith("[引用 · 助手 · ")).toBe(true)
    expect(reference.block).toContain("会话 ses_1")
    expect(reference.block).toContain("消息 msg_2")
    expect(reference.block).toContain("片段 prt_3")
    expect(reference.block).toContain("> the failing line\n> second line")
    expect(reference.truncated).toBe(false)
  })

  test("does not claim a precise source when the anchor has no ids", () => {
    const reference = buildReference({
      anchor: { kind: "message", role: "assistant" },
      text: "orphan selection",
      at: 0,
      labels: { unknown: "来源不可定位" },
    })

    expect(reference.block.startsWith("[引用 · 来源不可定位 · ")).toBe(true)
    expect(reference.block).not.toContain("消息 ")
  })

  test("whole-message quotes state their range explicitly", () => {
    const reference = buildReference({
      anchor: { kind: "message", messageID: "msg_9", role: "assistant" },
      text: "whole answer",
      at: 0,
    })

    expect(reference.block).toContain("消息 msg_9")
    expect(reference.block).toContain("整条消息")
    expect(reference.block).not.toContain("片段 ")
  })

  test("bounds externally supplied header fields", () => {
    const reference = buildReference({
      anchor: { kind: "terminal", title: "t".repeat(400), terminalID: "pty_1" },
      text: "x",
      at: 0,
    })

    expect(reference.block.split("\n")[0]!.length).toBeLessThan(400)
    expect(reference.block).toContain("…")
  })

  test("clips long text to the limit and says how much was dropped", () => {
    const text = "x".repeat(REFERENCE_TEXT_LIMIT + 25)
    const reference = buildReference({ anchor: { kind: "unknown" }, text, at: 0 })

    expect(reference.text).toHaveLength(REFERENCE_TEXT_LIMIT)
    expect(reference.total).toBe(REFERENCE_TEXT_LIMIT + 25)
    expect(reference.truncated).toBe(true)
    expect(reference.block).toContain("原长")
  })

  test("terminal quotes can keep the newest tail and name the terminal", () => {
    const reference = buildReference({
      anchor: { kind: "terminal", terminalID: "pty_1", title: "dev server" },
      text: `head\n${"e".repeat(30)}`,
      at: 0,
      keep: "tail",
      limit: 10,
    })

    expect(reference.text).toBe("eeeeeeeeee")
    expect(reference.block).toContain("终端「dev server」")
    expect(reference.block).toContain("终端 pty_1")
    expect(reference.block).toContain("末尾 10 字符")
  })

  test("labels stay readable for each anchor kind", () => {
    expect(referenceLabel({ kind: "tool", tool: "bash" })).toBe("工具 bash")
    expect(referenceLabel({ kind: "file", path: "a.ts" })).toBe("文件 a.ts")
    expect(referenceLabel({ kind: "message", role: "user" })).toBe("用户")
  })
})

describe("appendReference", () => {
  const text = (content: string, start: number) => ({ type: "text" as const, content, start, end: start + content.length })

  test("appends after existing text without touching existing parts", () => {
    const prompt: Prompt = [
      text("hello", 0),
      { type: "file", path: "a.ts", content: "@a.ts", start: 5, end: 10 },
    ]
    const reference = buildReference({
      anchor: { kind: "message", messageID: "msg_1", partID: "prt_1", role: "assistant" },
      text: "quoted",
      at: 0,
    })
    const next = appendReference(prompt, reference)

    expect(next.prompt).toHaveLength(3)
    expect(next.prompt[0]).toEqual(prompt[0])
    expect(next.prompt[1]).toEqual(prompt[1])
    const appended = next.prompt[2]
    if (appended.type !== "text") throw new Error("expected trailing text part")
    expect(appended.start).toBe(10)
    expect(appended.content.startsWith("\n\n[引用 · 助手")).toBe(true)
    expect(appended.content.endsWith("\n")).toBe(true)
    expect(next.cursor).toBe(appended.end)
  })

  test("does not add leading blank lines to an empty draft", () => {
    const next = appendReference([text("", 0)], "> block")
    const appended = next.prompt.at(-1)
    if (!appended || appended.type !== "text") throw new Error("expected trailing text part")
    expect(appended.content.startsWith("> block")).toBe(true)
  })
})
