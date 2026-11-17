// 260814 Red 重复调用递进提醒——纯函数层测试(链数/透明工具/断链/阈值/预览截断)
import { describe, expect, test } from "bun:test"
import { chainLength, inputKey, reminderFor, THRESHOLDS, EXCLUDED_TOOLS } from "@/session/repeat-tool-reminder"
import type { Part } from "@/session/message-v2"

let seq = 0
function toolPart(
  tool: string,
  input: Record<string, unknown>,
  status: "completed" | "error" | "running" = "completed",
): Part {
  seq++
  const state =
    status === "completed"
      ? { status, input, output: "ok", title: tool, metadata: {}, time: { start: 0, end: 1 } }
      : status === "error"
        ? { status, input, error: "boom", time: { start: 0, end: 1 } }
        : { status, input, time: { start: 0 } }
  return {
    id: `prt_${String(seq).padStart(3, "0")}`,
    sessionID: "ses_test",
    messageID: `msg_${String(seq).padStart(3, "0")}`,
    type: "tool",
    tool,
    callID: `call_${seq}`,
    state,
  } as unknown as Part
}

const grep = (pattern: string) => toolPart("grep", { pattern })

describe("chainLength", () => {
  test("counts consecutive identical calls from the tail", () => {
    const parts = [grep("a"), grep("b"), grep("b"), grep("b")]
    expect(chainLength(parts, "grep", inputKey({ pattern: "b" }))).toBe(3)
  })

  test("breaks on different arguments", () => {
    const parts = [grep("b"), grep("a")]
    expect(chainLength(parts, "grep", inputKey({ pattern: "b" }))).toBe(0)
  })

  test("breaks on different tool", () => {
    const parts = [grep("b"), toolPart("read", { filePath: "x" })]
    expect(chainLength(parts, "grep", inputKey({ pattern: "b" }))).toBe(0)
  })

  test("excluded bookkeeping tools are transparent, not chain breakers", () => {
    const parts = [grep("b"), toolPart("todowrite", { todos: [] }), grep("b")]
    expect(chainLength(parts, "grep", inputKey({ pattern: "b" }))).toBe(2)
  })

  test("running parts are skipped without breaking the chain", () => {
    const parts = [grep("b"), toolPart("grep", { pattern: "b" }, "running"), grep("b")]
    expect(chainLength(parts, "grep", inputKey({ pattern: "b" }))).toBe(2)
  })

  test("errored calls count toward the chain", () => {
    const parts = [toolPart("grep", { pattern: "b" }, "error"), grep("b")]
    expect(chainLength(parts, "grep", inputKey({ pattern: "b" }))).toBe(2)
  })

  test("object-key ordering at any depth does not break the chain", () => {
    const parts = [
      toolPart("grep", { query: { pattern: "b", options: { case: true, path: "src" } }, limit: 20 }),
      toolPart("grep", { limit: 20, query: { options: { path: "src", case: true }, pattern: "b" } }),
    ]
    expect(
      chainLength(
        parts,
        "grep",
        inputKey({ query: { options: { case: true, path: "src" }, pattern: "b" }, limit: 20 }),
      ),
    ).toBe(2)
  })

  test("array order remains significant", () => {
    expect(chainLength([toolPart("grep", { paths: ["a", "b"] })], "grep", inputKey({ paths: ["b", "a"] }))).toBe(0)
  })
})

describe("reminderFor", () => {
  const input = JSON.stringify({ pattern: "b" })

  test("silent below the first threshold", () => {
    expect(reminderFor("grep", input, 1)).toBeNull()
    expect(reminderFor("grep", input, 2)).toBeNull()
  })

  test("first threshold gives the short nudge naming tool and count", () => {
    const text = reminderFor("grep", input, 3)
    expect(text).toContain("[System notice]")
    expect(text).toContain('"grep"')
    expect(text).toContain("3 times")
    expect(text).not.toContain("consecutive_calls")
  })

  test("later thresholds give the detailed form with arguments", () => {
    for (const count of [5, 8]) {
      const text = reminderFor("grep", input, count)
      expect(text).toContain(`consecutive_calls: ${count}`)
      expect(text).toContain(input)
    }
  })

  test("silent between and beyond thresholds", () => {
    for (const count of [4, 6, 7, 9, 20]) {
      expect(reminderFor("grep", input, count)).toBeNull()
    }
  })

  test("long arguments are head-truncated with an omitted-count marker", () => {
    const big = JSON.stringify({ content: "x".repeat(2000) })
    const text = reminderFor("write", big, 5)!
    expect(text).toContain("… (+")
    expect(text).toContain("more chars")
    expect(text.length).toBeLessThan(big.length)
  })

  test("long external tool names and CJK arguments keep every notice below 4KiB", () => {
    for (const count of THRESHOLDS) {
      const text = reminderFor("工具".repeat(10_000), JSON.stringify({ content: "中文".repeat(10_000) }), count)
      expect(text).not.toBeNull()
      expect(Buffer.byteLength(text ?? "", "utf8")).toBeLessThan(4096)
    }
  })
})

describe("contract", () => {
  test("thresholds are ascending and start at 3", () => {
    expect([...THRESHOLDS]).toEqual([...THRESHOLDS].toSorted((a, b) => a - b))
    expect(THRESHOLDS[0]).toBe(3)
  })

  test("todo bookkeeping tools are excluded", () => {
    expect(EXCLUDED_TOOLS.has("todowrite")).toBe(true)
    expect(EXCLUDED_TOOLS.has("todoread")).toBe(true)
  })
})
