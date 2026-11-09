import { describe, expect, test } from "bun:test"
import { deriveActivity, formatElapsed } from "../../../../src/cli/cmd/tui/routes/session/activity"

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
    expect(activity.running).toEqual({ tool: "edit", target: "/a/session.ts" })
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
