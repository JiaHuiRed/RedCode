import { describe, expect, test } from "bun:test"
import { ImageTokens } from "@/session/image-tokens"

// 261015 Red 审计 A02：附件在**进入解析之前**的两道闸门。它们都建在既有常量的同一条线上
// （MAX_ATTACHMENT_BASE64_BYTES / MAX_ATTACHMENTS），不新增第二套限额，避免「双重限制互相矛盾」。
// 这里只测纯函数：真实读盘 + base64 的峰值内存属该分支，需要集成夹具，见 note 的未覆盖项。
describe("attachment inline budget", () => {
  test("读盘前的字节闸门按 base64 反算，边界内不误伤", () => {
    const cap = Math.floor((ImageTokens.MAX_ATTACHMENT_BASE64_BYTES * 3) / 4)
    expect(ImageTokens.attachmentInlineBytesExceeded(cap)).toBe(false)
    expect(ImageTokens.attachmentInlineBytesExceeded(cap + 1)).toBe(true)
    expect(ImageTokens.attachmentInlineBytesExceeded(5 * 1024 * 1024)).toBe(true)
  })

  test("折算出的原始上限编成 base64 后仍在模型侧那条线之内（两道闸门不矛盾）", () => {
    const cap = Math.floor((ImageTokens.MAX_ATTACHMENT_BASE64_BYTES * 3) / 4)
    const encoded = Buffer.alloc(cap).toString("base64").length
    expect(encoded).toBeLessThanOrEqual(ImageTokens.MAX_ATTACHMENT_BASE64_BYTES)
  })
})

describe("splitByAttachmentBudget", () => {
  const isFile = (part: { type: string }) => part.type === "file"

  test("按 MAX_ATTACHMENTS 切分：保持顺序，非附件不计数", () => {
    // 40 个 part，其中 0/10/20/30 是文本 → 36 个附件，前 32 个内联
    const parts = Array.from({ length: 40 }, (_, i) => ({ type: i % 10 === 0 ? "text" : "file", i }))
    const { inline, overflow } = ImageTokens.splitByAttachmentBudget(parts, isFile)
    expect(inline.filter(isFile)).toHaveLength(ImageTokens.MAX_ATTACHMENTS)
    expect(overflow.map((part) => part.i)).toEqual([36, 37, 38, 39])
    // inline 是 parts 去掉 overflow 后的原序子序列
    expect(inline).toEqual(parts.filter((part) => !overflow.includes(part)))
  })

  test("限额内不产生超量，顺序原样", () => {
    const parts = Array.from({ length: 5 }, (_, i) => ({ type: "file", i }))
    const { inline, overflow } = ImageTokens.splitByAttachmentBudget(parts, isFile)
    expect(overflow).toHaveLength(0)
    expect(inline).toEqual(parts)
  })

  test("非附件不占限额（32 个文本 + 32 个文件仍全部内联）", () => {
    const parts = [...Array.from({ length: 32 }, () => ({ type: "text" })), ...Array.from({ length: 32 }, (_, i) => ({ type: "file", i }))]
    const { inline, overflow } = ImageTokens.splitByAttachmentBudget(parts, isFile)
    expect(overflow).toHaveLength(0)
    expect(inline).toHaveLength(64)
  })
})
