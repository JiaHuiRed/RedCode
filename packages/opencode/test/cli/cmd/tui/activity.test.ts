import { describe, expect, test } from "bun:test"
import {
  deriveActivity,
  formatElapsed,
  targetText,
} from "../../../../src/cli/cmd/tui/routes/session/activity"

describe("TUI activity derivation", () => {
  test("counts completed tools and keeps failures separate", () => {
    const activity = deriveActivity([
      { type: "tool", tool: "read", state: { status: "completed" } },
      { type: "tool", tool: "write", state: { status: "completed" } },
      { type: "tool", tool: "bash", state: { status: "completed" } },
      { type: "tool", tool: "bash", state: { status: "error", input: { command: "bun test" } } },
    ])
    expect(activity.counts).toEqual({ read: 1, edit: 1, command: 1, failed: 1 })
  })

  test("reports the running tool with its file target", () => {
    const activity = deriveActivity([
      { type: "tool", tool: "read", state: { status: "completed" } },
      { type: "tool", tool: "edit", state: { status: "running", input: { filePath: "/a/session.ts" } } },
    ])
    expect(activity.running).toEqual({
      tool: "edit",
      target: { kind: "file", value: "/a/session.ts" },
      started: undefined,
    })
  })

  test("carries the running tool's own start time when present", () => {
    const activity = deriveActivity([
      { type: "tool", tool: "bash", state: { status: "running", input: { command: "bun test" }, time: { start: 42 } } },
    ])
    expect(activity.running?.started).toBe(42)
  })

  test("pending and non-tool parts never fake activity", () => {
    const activity = deriveActivity([
      { type: "text" },
      { type: "tool", tool: "read", state: { status: "pending" } },
    ])
    expect(activity.running).toBeUndefined()
    expect(activity.counts).toEqual({ read: 0, edit: 0, command: 0, failed: 0 })
  })

  test("elapsed stays mm:ss and never goes negative", () => {
    expect(formatElapsed(0)).toBe("00:00")
    expect(formatElapsed(38_000)).toBe("00:38")
    expect(formatElapsed(125_000)).toBe("02:05")
    expect(formatElapsed(-5)).toBe("00:00")
  })
})

// 261110 Red 展示层定长截断：TUI 无 CSS truncate，超长必须显式加省略号；
// 命令保留命令头，绝不路径化。
describe("targetText", () => {
  test("file targets show basename", () => {
    expect(targetText({ kind: "file", value: "packages/app/src/session.tsx" })).toBe("session.tsx")
    expect(targetText({ kind: "file", value: "D:\\AI\\RedCode\\package.json" })).toBe("package.json")
  })

  test("command targets keep the head, never basename", () => {
    expect(targetText({ kind: "command", value: "bun test ./src/session.test.ts" })).toBe(
      "bun test ./src/session.test.ts",
    )
  })

  test("overlong commands truncate with an explicit ellipsis", () => {
    const text = targetText({ kind: "command", value: `bun install --force 2>&1 | Select-Object -Last ${"9".repeat(80)}` })
    expect(text.length).toBe(49)
    expect(text.endsWith("…")).toBe(true)
  })

  test("multiline commands collapse to one line before truncation", () => {
    expect(targetText({ kind: "command", value: "bun run\n  build" })).toBe("bun run build")
  })

  test("pattern targets truncate the same way", () => {
    expect(targetText({ kind: "pattern", value: "x".repeat(60) })).toBe(`${"x".repeat(48)}…`)
  })

  test("long basenames also truncate", () => {
    expect(targetText({ kind: "file", value: `/a/${"y".repeat(60)}` })).toBe(`${"y".repeat(48)}…`)
  })
})
