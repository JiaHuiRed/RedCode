import { describe, expect, it } from "bun:test"
import { RunCodeSdk } from "../../src/tool/run-code-sdk"
import { runProgram } from "../../src/tool/run-code"
import { dispatchNestedTool } from "../../src/session/tools"

// 261017 Red 测试直调真实现（不复制一份 prelude）：SDK 生成是纯函数，
// 执行器走真实子进程 + 真实协议帧，只有工具调度用替身——那正是宿主要注入的东西。

const schema = (value: Record<string, unknown>) => value as never

describe("run_code SDK declaration", () => {
  const tools = [
    {
      id: "grep",
      description: "Search file contents. Second sentence is dropped.",
      schema: schema({
        type: "object",
        required: ["pattern"],
        properties: {
          pattern: { type: "string", description: "regex" },
          include: { type: "string" },
          limit: { type: "integer" },
        },
      }),
    },
    {
      id: "task_status",
      description: "Inspect a background task.",
      schema: schema({
        type: "object",
        required: ["task_id"],
        properties: {
          task_id: { type: "string" },
          wait: { type: "boolean" },
          mode: { enum: ["a", "b"] },
          tags: { type: "array", items: { type: "string" } },
          meta: { type: "object", additionalProperties: true },
        },
      }),
    },
    {
      id: "weird-name",
      description: "",
      schema: schema({ type: "object", properties: { value: { anyOf: [{ type: "string" }, { type: "null" }] } } }),
    },
  ]

  it("declares only the visible tools, sorted and quoted when needed", () => {
    const text = RunCodeSdk.declaration(tools)
    expect(text).toContain("declare const tools: {")
    expect(text).toContain("grep(input: { pattern: string; include?: string; limit?: number }): Promise<string>")
    expect(text).toContain('"weird-name"(input: { value?: string | null }): Promise<string>')
    expect(text).toContain("task_id: string")
    expect(text).toContain('mode?: "a" | "b"')
    expect(text).toContain("tags?: string[]")
    expect(text).toContain("meta?: Record<string, unknown>")
    expect(text).toContain("Search file contents.")
    expect(text).not.toContain("Second sentence")
    expect(text.indexOf("grep(input")).toBeLessThan(text.indexOf('"weird-name"(input'))
  })

  it("is byte-identical for the same visible set regardless of input order", () => {
    expect(RunCodeSdk.declaration(tools)).toBe(RunCodeSdk.declaration([...tools].reverse()))
  })

  it("falls back to unknown instead of guessing recursive or unknown shapes", () => {
    const text = RunCodeSdk.declaration([
      {
        id: "x",
        description: "x",
        schema: schema({
          type: "object",
          properties: { loop: { $ref: "#/$defs/loop" }, anything: {}, untyped: { type: "array" } },
        }),
      },
    ])
    expect(text).toContain("loop?: unknown")
    expect(text).toContain("anything?: unknown")
    expect(text).toContain("untyped?: unknown[]")
  })

  it("keeps a hard byte budget with many tools and lists what it omitted", () => {
    const many = Array.from({ length: 400 }, (_, index) => ({
      id: `tool_${String(index).padStart(3, "0")}`,
      description: "x",
      schema: schema({ type: "object", properties: { value: { type: "string" } } }),
    }))
    const text = RunCodeSdk.declaration(many)
    expect(text.length).toBeLessThan(25_000)
    expect(text).toContain("more visible tool(s) omitted from this declaration")
    // 预算内仍必须能完整声明靠前的工具。
    expect(text).toContain("tool_000(input:")
  })
})

describe("run_code nested dispatch bridge", () => {
  const parent = {
    toolCallId: "call_parent",
    messages: [],
    abortSignal: new AbortController().signal,
    context: {},
  } as never

  it("calls the target tool with a child call id and returns only its output", async () => {
    const seen: string[] = []
    const tools = {
      read: {
        execute: async (_args: Record<string, unknown>, options: { toolCallId: string }) => {
          seen.push(options.toolCallId)
          return { title: "read", metadata: {}, output: "file body" }
        },
      },
    } as never
    const result = await dispatchNestedTool(tools, "read", { filePath: "x" }, parent, "call_parent:rc1")
    expect(result).toEqual({ output: "file body", blocked: false })
    expect(seen).toEqual(["call_parent:rc1"])
  })

  it("reports a blocked tool and refuses self-calls and unknown names", async () => {
    const tools = {
      edit: { execute: async () => ({ title: "Blocked", metadata: { blocked: true }, output: "denied" }) },
    } as never
    expect(await dispatchNestedTool(tools, "edit", {}, parent, "call_parent:rc2")).toEqual({
      output: "denied",
      blocked: true,
    })
    await expect(dispatchNestedTool(tools, "run_code", {}, parent, "call_parent:rc3")).rejects.toThrow(
      "cannot call itself",
    )
    await expect(dispatchNestedTool(tools, "missing", {}, parent, "call_parent:rc4")).rejects.toThrow("Unknown tool")
  })
})

describe("run_code program execution", () => {
  const options = (
    code: string,
    dispatch: Parameters<typeof runProgram>[0]["dispatch"],
    abort = new AbortController(),
  ) => ({
    code,
    dispatch,
    abort: abort.signal,
    directory: process.cwd(),
    timeoutMs: 30_000,
  })

  it("returns only curated output and dispatches tools through the bridge", async () => {
    const calls: Array<[string, Record<string, unknown>]> = []
    const outcome = await runProgram(
      options(
        [
          'const a = await tools.grep({ pattern: "alpha" })',
          'const b = await tools.grep({ pattern: "beta" })',
          'console.log("collected")',
          "return `a=${a} b=${b}`",
        ].join("\n"),
        async (name, args) => {
          calls.push([name, args])
          return { output: `result for ${args.pattern}` }
        },
      ),
    )
    expect(outcome.unavailable).toBeUndefined()
    expect(outcome.timedOut).toBe(false)
    expect(outcome.calls).toBe(2)
    expect(outcome.output).toContain("collected")
    expect(outcome.output).toContain("a=result for alpha b=result for beta")
    expect(calls).toEqual([
      ["grep", { pattern: "alpha" }],
      ["grep", { pattern: "beta" }],
    ])
  }, 30_000)

  it("keeps intermediate tool output out of the result", async () => {
    const huge = "X".repeat(20_000)
    const outcome = await runProgram(options('console.log("ok")', async () => ({ output: huge })))
    expect(outcome.output.trim()).toBe("ok")
    expect(outcome.output).not.toContain("X")
  }, 30_000)

  it("surfaces a failed tool call to the program as ToolCallError", async () => {
    const outcome = await runProgram(
      options(
        [
          "try {",
          '  await tools.grep({ pattern: "x" })',
          "} catch (error) {",
          "  console.log(`${error.name}:${error.toolName}:${error.message}`)",
          "}",
        ].join("\n"),
        async () => {
          throw new Error("permission denied")
        },
      ),
    )
    expect(outcome.output).toContain("ToolCallError:grep:permission denied")
  }, 30_000)

  it("reports program errors without pretending success", async () => {
    const outcome = await runProgram(options("throw new Error('boom')", async () => ({ output: "" })))
    expect(outcome.output.startsWith("Error:")).toBe(true)
    expect(outcome.output).toContain("boom")
  }, 30_000)

  it("reports a syntax error from the generated program", async () => {
    const outcome = await runProgram(options("const = 1", async () => ({ output: "" })))
    expect(outcome.output.startsWith("Error:")).toBe(true)
  }, 30_000)

  it("stops a hanging program when the caller aborts", async () => {
    const controller = new AbortController()
    const input = options("await new Promise(() => {})", async () => ({ output: "" }), controller)
    setTimeout(() => controller.abort(), 150)
    const started = Date.now()
    const outcome = await runProgram(input)
    expect(Date.now() - started).toBeLessThan(15_000)
    expect(outcome.output.trim()).toBe("")
  }, 30_000)
})
