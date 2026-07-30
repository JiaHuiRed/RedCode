import { describe, expect, test } from "bun:test"
import { decode, detectCrBloat, detectEncodingChange, detectGarbled, sniff, SNIFF_BYTES } from "@/util/bom"

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

// 260730 Karina 回归测试：行尾回车膨胀护栏。edit 的 hashline 路径对 CRLF 文件二次做
// LF→CRLF 转换，写出 `\r\r\n`，编辑一次物理行数就翻一倍（6905 行 → 27707 行）。
// 根因已修，这层护栏兜住同类回归 —— 这种损坏对 read/fileTag 完全隐形，只能在写入口拦。
describe("detectCrBloat (行尾回车膨胀护栏)", () => {
  test("正常 CRLF 放行", () => {
    expect(detectCrBloat("a\r\nb\r\n", "a\r\nb\r\n")).toBeUndefined()
  })

  test("正常 LF 放行", () => {
    expect(detectCrBloat("a\nb\n", "a\nb\n")).toBeUndefined()
  })

  test("新出现的 \\r\\r\\n 拦截", () => {
    expect(detectCrBloat("a\r\r\nb\r\r\n", "a\r\nb\r\n")).toContain("多余回车符")
  })

  test("更多层的 \\r\\r\\r\\n 也拦", () => {
    expect(detectCrBloat("a\r\r\r\n", "a\r\n")).toContain("多余回车符")
  })

  test("原文已损坏、新内容没变多 —— 放行，否则连用 edit 修都修不了", () => {
    expect(detectCrBloat("a\r\r\nB\r\r\n", "a\r\r\nb\r\r\n")).toBeUndefined()
  })

  test("原文已损坏、新内容在修复它 —— 放行", () => {
    expect(detectCrBloat("a\r\nb\r\n", "a\r\r\nb\r\r\n")).toBeUndefined()
  })

  test("不传原文时任何 \\r\\r\\n 都拦", () => {
    expect(detectCrBloat("a\r\r\n")).toContain("多余回车符")
  })

  test("孤立的裸 \\r（老 Mac 行尾）不误伤", () => {
    expect(detectCrBloat("a\rb\rc")).toBeUndefined()
  })
})

// 260730 Karina 读取侧编码检测。此前无条件按 UTF-8 非 fatal 解，真 GBK 文件读进来
// 满屏 U+FFFD。检测只能单向做：「严格 UTF-8 解得通 → 就是 UTF-8」可靠（20000 样本
// 里 5 个汉字往上、GBK 凑成合法 UTF-8 的次数为 0），反过来「GBK 解得通 → 是 GBK」
// 毫无价值（8 个汉字的 UTF-8 字节流有 31% 能被 GBK 照单全收）。
const utf8 = (s: string) => new TextEncoder().encode(s)
// "中文测试内容\n第二行：项目报表\n" 的 GBK 字节
const GBK = new Uint8Array([
  0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0xc4, 0xda, 0xc8, 0xdd, 0x0a, 0xb5, 0xda,
  0xb6, 0xfe, 0xd0, 0xd0, 0xa3, 0xba, 0xcf, 0xee, 0xc4, 0xbf, 0xb1, 0xa8, 0xb1, 0xed, 0x0a,
])

describe("sniff / decode (读取侧编码检测)", () => {
  test("无 BOM 的 UTF-8 中文认成 utf-8", () => {
    expect(sniff(utf8("中文测试内容"))).toBe("utf-8")
    expect(decode(utf8("中文测试内容")).text).toBe("中文测试内容")
  })

  test("带 BOM 的 UTF-8 认成 utf-8，BOM 仍由 split() 摘出来", () => {
    const bytes = utf8("﻿中文测试")
    expect(sniff(bytes)).toBe("utf-8")
    const out = decode(bytes)
    expect(out.bom).toBe(true)
    expect(out.text).toBe("中文测试")
  })

  test("纯 ASCII 认成 utf-8（两种编码解出来一样，无所谓）", () => {
    expect(sniff(utf8("hello world\n"))).toBe("utf-8")
    expect(decode(utf8("hello world\n")).text).toBe("hello world\n")
  })

  test("空文件认成 utf-8", () => {
    expect(sniff(new Uint8Array())).toBe("utf-8")
    expect(decode(new Uint8Array()).text).toBe("")
  })

  test("真 GBK 不认成 utf-8，且能解出正确中文", () => {
    expect(sniff(GBK)).not.toBe("utf-8")
    expect(decode(GBK).text).toBe("中文测试内容\n第二行：项目报表\n")
    expect(decode(GBK).text).not.toContain("�")
  })

  test("UTF-16LE BOM 认得出来，BOM 被 TextDecoder 吃掉", () => {
    const body = new Uint8Array(new Uint16Array([0x4e2d, 0x6587]).buffer) // "中文" LE
    const bytes = new Uint8Array([0xff, 0xfe, ...body])
    expect(sniff(bytes)).toBe("utf-16le")
    expect(decode(bytes).text).toBe("中文")
  })

  test("UTF-16BE BOM 认得出来", () => {
    const bytes = new Uint8Array([0xfe, 0xff, 0x4e, 0x2d, 0x65, 0x87]) // "中文" BE
    expect(sniff(bytes)).toBe("utf-16be")
    expect(decode(bytes).text).toBe("中文")
  })

  test("采样边界切在多字节字符中间不会误判成 GBK", () => {
    // stream:true 若漏掉，被截断的尾巴会被当成非法序列，好文件被判成 GBK
    const full = utf8("中文测试内容".repeat(3))
    for (let cut = 1; cut < full.length; cut++) {
      expect(sniff(full.subarray(0, cut))).toBe("utf-8")
    }
  })

  test("只嗅头部：超长 UTF-8 文件末尾混进坏字节，整体仍按 utf-8 解", () => {
    // 全文校验会把这种文件判成 GBK 然后整个解花，只嗅头部则只有那个坏字节退化成 FFFD
    const head = utf8("x".repeat(SNIFF_BYTES + 100))
    const bytes = new Uint8Array([...head, 0xff])
    expect(sniff(bytes.subarray(0, SNIFF_BYTES))).toBe("utf-8")
    const out = decode(bytes)
    expect(out.encoding).toBe("utf-8")
    expect(out.text.startsWith("x".repeat(100))).toBe(true)
  })
})

// 检测出非 UTF-8 之后必须配写回护栏：检测之前这件事由 detectGarbled 顺带挡着
// （GBK 读成 UTF-8 满屏 FFFD，占比 83% 远超阈值直接拒写），检测之后文本干净了，
// 那道墙就自动失效了 —— 不补上就成了「悄悄把用户的 GBK 文件转成 UTF-8」。
describe("detectEncodingChange (转编码护栏)", () => {
  test("utf-8 放行", () => {
    expect(detectEncodingChange("utf-8")).toBeUndefined()
  })

  test("gb18030 拦截", () => {
    expect(detectEncodingChange("gb18030")).toContain("gb18030")
  })

  test("utf-16le 拦截", () => {
    expect(detectEncodingChange("utf-16le")).toContain("utf-16le")
  })

  test("真 GBK 文件解出来是干净文本，detectGarbled 已经拦不住，只能靠这道", () => {
    const text = decode(GBK).text
    expect(detectGarbled(text)).toBeUndefined()
    expect(detectEncodingChange(decode(GBK).encoding)).toBeDefined()
  })
})
