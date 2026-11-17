import { describe, expect, test } from "bun:test"
import { MCP } from "../../src/mcp"

// 261007 Red guides 聚合上限：单条 cap 之外追加总量预算，超出的服务器整段移出、
// 名字收进 marker。稳定排序 + 常态逐字节不变的约束在这里钉住。
describe("MCP.fmtGuides aggregate budget", () => {
  test("returns undefined for an empty list", () => {
    expect(MCP.fmtGuides([])).toBeUndefined()
  })

  test("renders servers in stable name order without markers under budget", () => {
    const out = MCP.fmtGuides([
      { server: "zeta", text: "z" },
      { server: "alpha", text: "a" },
    ])!
    expect(out.indexOf("## alpha")).toBeLessThan(out.indexOf("## zeta"))
    expect(out).not.toContain("omitted")
  })

  test("omits overflow entries, keeping their names in the marker", () => {
    // 每条 = 预算的 1/4：恰好装 4 条，第 5 条起被移出。
    const many = Array.from({ length: 5 }, (_, i) => ({
      server: `srv-${String(i).padStart(2, "0")}`,
      text: "x".repeat(MCP.MAX_TOTAL_INSTRUCTION_CHARS / 4),
    }))
    const out = MCP.fmtGuides(many)!
    expect(out).toContain("## srv-00")
    expect(out).toContain("## srv-03")
    expect(out).not.toContain("## srv-04")
    expect(out).toContain("omitted by instruction budget: srv-04")
  })
})
