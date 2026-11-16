import { describe, expect, test } from "bun:test"
import type { Part } from "@redcode-ai/sdk/v2"
import {
  canCollapseProcess,
  collapseProcessRows,
  processSummary,
} from "../../../../src/cli/cmd/tui/util/result-view"

// 261116 Red A06：结果阅读只折叠正常完成的过程；运行中/失败/待处理必须保持可见。
const text = (value: string) => ({ type: "text", text: value }) as unknown as Part
const reasoning = () => ({ type: "reasoning", text: "想一下" }) as unknown as Part
const tool = (status: "pending" | "running" | "completed" | "error") =>
  ({ type: "tool", tool: "bash", callID: `call_${status}`, state: { status } }) as unknown as Part

describe("canCollapseProcess", () => {
  test("collapses only normally completed process", () => {
    expect(canCollapseProcess({ completed: 100 }, [text("结果"), tool("completed"), reasoning()])).toBe(true)
  })

  test("keeps running, failed and pending-permission process visible", () => {
    expect(canCollapseProcess({ completed: undefined }, [tool("running")])).toBe(false)
    expect(canCollapseProcess({ completed: 100, error: { name: "APIError" } }, [tool("completed")])).toBe(false)
    expect(canCollapseProcess({ completed: 100 }, [tool("pending")])).toBe(false)
    expect(canCollapseProcess({ completed: 100 }, [tool("error")])).toBe(false)
  })

  test("does not collapse messages without process", () => {
    expect(canCollapseProcess({ completed: 100 }, [text("只有正文")])).toBe(false)
  })
})

describe("collapseProcessRows", () => {
  test("groups consecutive process parts and keeps text order", () => {
    const rows = collapseProcessRows([text("A"), tool("completed"), reasoning(), text("B"), tool("completed")])
    expect(rows.map((row) => row.kind)).toEqual(["part", "process", "part", "process"])
    const first = rows[1]
    const second = rows[3]
    expect(first.kind === "process" && [first.tools, first.reasoning]).toEqual([1, 1])
    expect(second.kind === "process" && [second.tools, second.reasoning]).toEqual([1, 0])
  })

  test("keeps a leading process row", () => {
    const rows = collapseProcessRows([tool("completed"), text("结果")])
    expect(rows.map((row) => row.kind)).toEqual(["process", "part"])
  })
})

describe("processSummary", () => {
  test("states counts and the expand/collapse affordance", () => {
    expect(processSummary({ tools: 12, reasoning: 3, expanded: false })).toContain("12 个工具")
    expect(processSummary({ tools: 12, reasoning: 3, expanded: false })).toContain("3 段思考")
    expect(processSummary({ tools: 1, reasoning: 0, expanded: false })).toContain("点击展开")
    expect(processSummary({ tools: 1, reasoning: 0, expanded: true })).toContain("收起过程")
  })
})
