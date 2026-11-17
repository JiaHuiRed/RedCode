import { describe, expect, test } from "bun:test"
import { paginate } from "@/mcp"

// 261006 Red paginate 是 MCP 全部分页列表的唯一实现（listTools / listPrompts /
// listResources / listResourceTemplates 都走它）。三层保护——重复 cursor、页数
// 上限、整次 deadline——直接打真实现：时钟可注入，不 shadow 复刻逻辑。

type Page = { items: string[]; nextCursor?: string }

describe("mcp paginate", () => {
  test("returns every page when under the deadline", async () => {
    const pages: Page[] = [
      { items: ["a"], nextCursor: "c1" },
      { items: ["b", "c"], nextCursor: "c2" },
      { items: ["d"] },
    ]
    let i = 0
    const all = await paginate(
      async () => pages[i++],
      (r: Page) => r.items,
      () => 0,
    )
    expect(all).toEqual(["a", "b", "c", "d"])
  })

  test("throws once the whole-operation deadline passes", async () => {
    // 每次读钟前进 30s：第一页放行，第二页前的检查越过 60s deadline
    let ticks = 0
    const pages: Page[] = Array.from({ length: 10 }, (_, i) => ({ items: [`p${i}`], nextCursor: `c${i}` }))
    let i = 0
    const error = await paginate(
      async () => pages[i++],
      (r: Page) => r.items,
      () => (ticks += 30_000),
    ).catch((e) => e)
    expect(String(error)).toContain("deadline")
  })

  test("rejects a duplicate cursor instead of looping forever", async () => {
    const pages: Page[] = [
      { items: ["a"], nextCursor: "loop" },
      { items: ["b"], nextCursor: "loop" },
    ]
    let i = 0
    const error = await paginate(
      async () => pages[i++],
      (r: Page) => r.items,
      () => 0,
    ).catch((e) => e)
    expect(String(error)).toContain("duplicate cursor")
  })
})
