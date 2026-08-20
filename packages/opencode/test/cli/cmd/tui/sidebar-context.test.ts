import { describe, expect, test } from "bun:test"
import { bar, barColor, compact, formatMs } from "../../../../src/cli/cmd/tui/feature-plugins/sidebar/context"

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

  // 260819 cc 颜色改由引擎档位驱动，不再是百分比门槛：档位相对 ceiling()=min(硬顶,usable)
  // 算，而进度条分母是标称 context window，两者不是一个数（step-3.7-flash 上三条线换算成
  // 进度条是 52%/70%/88%，按 60/85 上色会比引擎实际动手慢半拍）。
  test("barColor 四档各不相同", () => {
    const colors = ["ok", "soft", "prune", "compact"].map(barColor)
    expect(new Set(colors).size).toBe(4)
  })

  test("档位缺失（历史消息没有该字段）回落到 ok 的颜色，不报错", () => {
    expect(barColor(undefined)).toBe(barColor("ok"))
    expect(barColor("不认识的档位")).toBe(barColor("ok"))
  })
})

// 260819 cc 解码速率显示。数据来自 message-v2 的 time.firstChunk/completed（埋点
// processor.ts 的 llm.ttft），实测最近 400 条 assistant 消息 400 条有值。
describe("首字延迟格式化", () => {
  test("秒级用 s，毫秒级用 ms", () => {
    expect(formatMs(2423)).toBe("2.4s")
    expect(formatMs(999)).toBe("999ms")
    expect(formatMs(1000)).toBe("1s")
    expect(formatMs(0)).toBe("0ms")
  })

  test("秒级只保留一位小数，不出现 2.42s 这种挤版的写法", () => {
    for (const ms of [1234, 5678, 12345, 98765]) {
      expect(formatMs(ms)).toMatch(/^\d+(\.\d)?s$/)
    }
  })
})
