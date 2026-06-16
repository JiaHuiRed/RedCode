import { describe, expect, test } from "bun:test"
import { detectGarbled } from "@/util/bom"

// 260616 Red 回归测试：乱码护栏。今天 SKILL.md 被 GBK 错解 UTF-8 写成 72 个 PUA，
// 这套测试锁住"正常放行 / 乱码拦截 / 不误伤图标"的阈值行为，防以后阈值漂移。
describe("detectGarbled (写入乱码护栏)", () => {
  test("正常中文文档放行", () => {
    expect(detectGarbled("这是一段正常的中文文档，包含 memory-automation 等内容")).toBeUndefined()
  })

  test("正常代码放行", () => {
    expect(detectGarbled("function foo() { return 42 }\nconst x = 'hello world'")).toBeUndefined()
  })

  test("空字符串放行", () => {
    expect(detectGarbled("")).toBeUndefined()
  })

  test("少量 Nerd Font 图标(PUA)不误伤", () => {
    // 几个图标 + 大量正常文本，PUA 占比极低，不应触发
    expect(detectGarbled("\uE0B0 status: ok " + "x".repeat(300))).toBeUndefined()
  })

  test("拦截 GBK 错解 UTF-8 的密集 PUA 乱码", () => {
    // 复现今天 SKILL.md 被写成 72 个 PUA 的情况
    const garbled = "\uE044".repeat(72) + "x".repeat(50)
    expect(detectGarbled(garbled)).toContain("私用区")
  })

  test("拦截 Unicode 替换符(U+FFFD)乱码", () => {
    expect(detectGarbled("\uFFFD\uFFFD\uFFFD hello")).toContain("替换符")
  })

  test("极个别替换符(占比极低)不误伤", () => {
    // 1 个 FFFD 在 400+ 字符里，占比 < 0.5% 阈值，放行
    expect(detectGarbled("\uFFFD " + "正常内容".repeat(100))).toBeUndefined()
  })
})
