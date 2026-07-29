import { describe, expect, test } from "bun:test"
import { capture, diagnose, schemaCosts } from "../../src/session/prefix-shape"
import { SessionID } from "../../src/session/schema"

const sid = (s: string) => SessionID.make(s)

const tools = {
  read: { description: "read a file", parameters: { filePath: "string" } },
  // 故意做成明显更大的一个，模拟某个 MCP server 挂上来吃掉一大块前缀
  huge_mcp_tool: {
    description: "x".repeat(2000),
    parameters: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, "string"])),
  },
}

describe("prefix-shape.schemaCosts", () => {
  test("按成本从贵到便宜排序", () => {
    const costs = schemaCosts(tools)
    expect(costs[0].name).toBe("huge_mcp_tool")
    expect(costs[0].tokens).toBeGreaterThan(costs[1].tokens)
  })

  test("每个工具都有条目", () => {
    expect(schemaCosts(tools).map((c) => c.name).sort()).toEqual(["huge_mcp_tool", "read"])
  })

  test("空工具表返回空数组", () => {
    expect(schemaCosts({})).toEqual([])
  })
})

describe("prefix-shape.capture", () => {
  test("带出工具数与 schema token 总量", () => {
    const shape = capture(["sys"], tools)
    expect(shape.toolCount).toBe(2)
    expect(shape.toolSchemaTokens).toBeGreaterThan(0)
  })

  test("工具顺序不影响 hash（内部排序）", () => {
    const a = capture(["sys"], { read: tools.read, huge_mcp_tool: tools.huge_mcp_tool })
    const b = capture(["sys"], { huge_mcp_tool: tools.huge_mcp_tool, read: tools.read })
    expect(a.toolsHash).toBe(b.toolsHash)
  })
})

describe("prefix-shape.diagnose", () => {
  test("首轮不算变化", () => {
    const d = diagnose(capture(["sys"], tools), sid("ses_first"), tools)
    expect(d.changed).toBe(false)
    expect(d.toolCount).toBe(2)
  })

  test("system 变化被识别，且不计算 topCosts", () => {
    const s = sid("ses_sys")
    diagnose(capture(["sys"], tools), s, tools)
    const d = diagnose(capture(["sys changed"], tools), s, tools)
    expect(d.changed).toBe(true)
    expect(d.reasons).toEqual(["system"])
    expect(d.topCosts).toBeUndefined()
  })

  test("tools 变化时给出最贵的几个，最贵的排第一", () => {
    const s = sid("ses_tools")
    diagnose(capture(["sys"], tools), s, tools)
    const more = { ...tools, extra: { description: "another" } }
    const d = diagnose(capture(["sys"], more), s, more)
    expect(d.reasons).toEqual(["tools"])
    expect(d.topCosts?.[0]?.name).toBe("huge_mcp_tool")
    expect(d.toolCount).toBe(3)
  })

  test("不传 tools 时不算 topCosts，其余诊断照常", () => {
    const s = sid("ses_notools")
    diagnose(capture(["sys"], tools), s)
    const d = diagnose(capture(["sys"], { read: tools.read }), s)
    expect(d.changed).toBe(true)
    expect(d.topCosts).toBeUndefined()
    expect(d.toolCount).toBe(1)
  })

  test("换 session 视为首轮，不误报变化", () => {
    diagnose(capture(["sys"], tools), sid("ses_a"), tools)
    const d = diagnose(capture(["completely different"], tools), sid("ses_b"), tools)
    expect(d.changed).toBe(false)
  })
})
