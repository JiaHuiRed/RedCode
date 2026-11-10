import { describe, expect, test } from "bun:test"
import { deriveActivity, targetLabel, targetTitle } from "./activity"

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
    expect(activity.running).toEqual({ tool: "edit", target: { kind: "file", value: "/a/b.ts" }, started: undefined })
  })

  test("carries the running tool's own start time when present", () => {
    const activity = deriveActivity([
      { type: "tool", tool: "bash", state: { status: "running", input: { command: "bun test" }, time: { start: 1000 } } },
    ])
    expect(activity.running?.started).toBe(1000)
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

  // 261110 Red 数据层不再截断：命令保留完整内容，截断是展示层的决定。
  test("commands keep full content and are not treated as paths", () => {
    const command = `bun test ./src/session.test.ts --filter ${"x".repeat(200)}`
    const activity = deriveActivity([
      { type: "tool", tool: "bash", state: { status: "running", input: { command } } },
    ])
    expect(activity.running?.target).toEqual({ kind: "command", value: command })
  })
})

describe("targetLabel / targetTitle", () => {
  test("file targets show basename in label and full path in title", () => {
    const target = { kind: "file" as const, value: "D:\\AI\\RedCode\\package.json" }
    expect(targetLabel(target)).toBe("package.json")
    expect(targetTitle(target)).toBe("D:\\AI\\RedCode\\package.json")
  })

  // 261110 Red 回归：命令此前被截 48 再当路径取 basename，
  // `bun test ./src/session.test.ts` 会显示成 `session.test.ts`。
  test("command targets keep the command head, never basename", () => {
    const target = { kind: "command" as const, value: "bun test ./src/session.test.ts" }
    expect(targetLabel(target)).toBe("bun test ./src/session.test.ts")
  })

  test("multiline commands collapse to one line", () => {
    const target = { kind: "command" as const, value: "bun install --force 2>&1 |\n  Select-Object -Last 25" }
    expect(targetLabel(target)).toBe("bun install --force 2>&1 | Select-Object -Last 25")
  })

  test("pattern targets stay verbatim", () => {
    const target = { kind: "pattern" as const, value: "derive**/Activity" }
    expect(targetLabel(target)).toBe("derive**/Activity")
    expect(targetTitle(target)).toBe("derive**/Activity")
  })
})
