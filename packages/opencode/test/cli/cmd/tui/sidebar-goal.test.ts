import { describe, expect, test } from "bun:test"
import { budgetBar } from "../../../../src/cli/cmd/tui/feature-plugins/sidebar/goal"

// 260820 cc Goal 侧边栏的显示件。预算条比上下文条窄（20 列）——它下面还要压一行
// 「x / y · 第 n/20 轮」，24 列会把那行挤到折行。
describe("sidebar goal 预算条", () => {
  test("两段加起来恒为固定宽度", () => {
    for (const used of [0, 1, 50_000, 199_999, 200_000]) {
      const { filled, rest } = budgetBar(used, 200_000)
      expect([...filled].length + [...rest].length).toBe(20)
    }
  })

  test("端点不越界", () => {
    expect(budgetBar(0, 200_000).filled).toBe("")
    expect(budgetBar(200_000, 200_000).rest).toBe("")
  })

  // budget_limited 是「用超了」才置的状态，此时 used > budget 必然发生，条子不能画穿
  test("超出预算时钳制而不是画穿", () => {
    const over = budgetBar(500_000, 200_000)
    expect([...over.filled].length).toBe(20)
    expect(over.rest).toBe("")
  })

  // 配置里把 goal_token_budget 写成 0 时不能除出 NaN 再让 repeat 抛 RangeError
  test("预算为 0 或负数时退化成空条而不是抛错", () => {
    expect(budgetBar(100, 0)).toEqual({ filled: "", rest: "░".repeat(20) })
    expect(budgetBar(100, -1)).toEqual({ filled: "", rest: "░".repeat(20) })
  })

  test("负的用量当作 0", () => {
    expect(budgetBar(-100, 200_000).filled).toBe("")
  })
})
