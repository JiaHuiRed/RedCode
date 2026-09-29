import { describe, expect, test } from "bun:test"
import { CHARS_PER_TOKEN, estimate, estimateReporting } from "../../src/util/token"

// 260929 Red estimateReporting 与 estimate 的分工见 token.ts 的注释：前者只进诊断侧，
// 后者被工具结果硬限和压缩触发线依赖、且与 CHARS_PER_TOKEN 的逆换算耦合。这里钉的是
// 两者的边界——ASCII 上必须同口径，否则诊断数字会和预算数字无端分叉。
describe("token.estimateReporting", () => {
  test("空串与纯 ASCII 与 estimate 同口径", () => {
    expect(estimateReporting("")).toBe(0)
    expect(estimateReporting("hello world")).toBe(estimate("hello world"))
    expect(estimateReporting("a".repeat(400))).toBe(100)
  })

  test("CJK 按 2 倍权重计入，正好是 estimate 的两倍", () => {
    const text = "中".repeat(400)
    expect(estimateReporting(text)).toBe(200)
    expect(estimateReporting(text)).toBe(estimate(text) * 2)
  })

  test("中英混排按各类字符数加权", () => {
    // 200 中文（×2）+ 200 ASCII = 600 权重 / 4 = 150
    expect(estimateReporting("中".repeat(200) + "a".repeat(200))).toBe(150)
  })

  test("日文假名与兼容表意也在加权范围内", () => {
    expect(estimateReporting("ア".repeat(100))).toBe(50)
    expect(estimateReporting("ｱ".repeat(100))).toBe(50)
  })

  test("小数四舍五入，与 estimate 同一取舍", () => {
    expect(estimateReporting("中".repeat(3))).toBe(2) // (3×2)/4 = 1.5 → 2
    expect(estimate("aaa")).toBe(1) // 3/4 = 0.75 → 1
  })

  test("加权范围不含常规标点与 emoji", () => {
    // 弯引号、破折号、emoji 都不在加权区——它们不是 CJK，不该被顺手翻倍
    const mixed = "“”—…→🎉"
    expect(estimateReporting(mixed)).toBe(estimate(mixed))
  })

  test("CHARS_PER_TOKEN 仍是两个估算器共同的分母", () => {
    expect(estimateReporting("中".repeat(4 * CHARS_PER_TOKEN))).toBe(8)
  })
})
