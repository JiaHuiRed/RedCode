import { describe, expect, test } from "bun:test"
import { bar, barColor, compact } from "../../../../src/cli/cmd/tui/feature-plugins/sidebar/context"

// 260819 cc: 侧边栏上下文窗口的显示件。侧边栏宽 42 列，紧凑记法和进度条宽度都按这个定的。
describe("sidebar context window 显示", () => {
  test("compact 按量级切换单位", () => {
    expect(compact(0)).toBe("0")
    expect(compact(999)).toBe("999")
    expect(compact(1_000)).toBe("1k")
    expect(compact(185_925)).toBe("186k") // >=100k 取整，避免 185.9k 多占一列
    expect(compact(12_500)).toBe("12.5k")
    expect(compact(1_000_000)).toBe("1M")
    expect(compact(15_416_562)).toBe("15M")
    expect(compact(1_250_000)).toBe("1.3M")
  })

  test("bar 两段加起来恒为固定宽度，端点不越界", () => {
    for (const p of [0, 1, 19, 50, 99, 100]) {
      const { filled, rest } = bar(p)
      expect([...filled].length + [...rest].length).toBe(24)
    }
    expect(bar(0).filled).toBe("")
    expect(bar(100).rest).toBe("")
  })

  // 口径修好之前 percent 会飙到几百，条子不能因此画出格
  test("bar 对越界百分比钳制而不是画穿", () => {
    expect([...bar(300).filled].length).toBe(24)
    expect(bar(300).rest).toBe("")
    expect([...bar(-5).filled].length).toBe(0)
  })

  test("barColor 在 60 / 85 两个门槛换色", () => {
    expect(barColor(0)).toBe(barColor(59))
    expect(barColor(60)).not.toBe(barColor(59))
    expect(barColor(84)).toBe(barColor(60))
    expect(barColor(85)).not.toBe(barColor(84))
    expect(barColor(200)).toBe(barColor(85))
  })
})
