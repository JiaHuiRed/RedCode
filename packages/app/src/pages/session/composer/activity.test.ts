import { describe, expect, test } from "bun:test"
import { deriveActivity } from "./activity"

describe("deriveActivity", () => {
  test("empty history has no running tool and zero counts", () => {
    expect(deriveActivity([])).toEqual({
      running: undefined,
      counts: { read: 0, edit: 0, command: 0, failed: 0 },
    })
  })

  test("reports the last running tool with its target", () => {
    const activity = deriveActivity([
      { type: "text" },
      { type: "tool", tool: "read", state: { status: "completed", input: { filePath: "/a/b.ts" } } },
      { type: "tool", tool: "edit", state: { status: "running", input: { filePath: "/a/b.ts" } } },
    ])
    expect(activity.running).toEqual({ tool: "edit", target: "/a/b.ts" })
  })

  test("counts reads, edits and commands from completed parts only", () => {
    const activity = deriveActivity([
      { type: "tool", tool: "read", state: { status: "completed" } },
      { type: "tool", tool: "read", state: { status: "completed" } },
      { type: "tool", tool: "write", state: { status: "completed" } },
      { type: "tool", tool: "apply_patch", state: { status: "completed" } },
      { type: "tool", tool: "bash", state: { status: "completed" } },
    ])
    expect(activity.counts).toEqual({ read: 2, edit: 2, command: 1, failed: 0 })
  })

  test("errors are counted and never hidden as successes", () => {
    const activity = deriveActivity([
      { type: "tool", tool: "bash", state: { status: "error", input: { command: "bun test" } } },
      { type: "tool", tool: "read", state: { status: "error" } },
    ])
    expect(activity.counts.failed).toBe(2)
    expect(activity.counts.command).toBe(0)
    expect(activity.counts.read).toBe(0)
  })

  test("pending parts are not reported as running", () => {
    const activity = deriveActivity([{ type: "tool", tool: "read", state: { status: "pending" } }])
    expect(activity.running).toBeUndefined()
  })

  test("bash commands are truncated to keep the HUD one line", () => {
    const activity = deriveActivity([
      { type: "tool", tool: "bash", state: { status: "running", input: { command: "x".repeat(200) } } },
    ])
    expect(activity.running?.target?.length).toBe(48)
  })
})
