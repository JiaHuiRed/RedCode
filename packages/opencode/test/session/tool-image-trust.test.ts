import { describe, expect, test } from "bun:test"
import { shouldNormalizeToolImage } from "../../src/session/processor"

// 261112 Red 工具结果图片信任分级：内置来源正常缩放，MCP/plugin 等外部来源跳过
// CPU 解码。决策：docs/notes/proposed/feature/2026-11-12-mcp-image-trust-tiering.md
describe("tool result image trust", () => {
  test("normalizes built-in images", () => {
    expect(shouldNormalizeToolImage({ mime: "image/png" })).toBe(true)
  })

  test("skips untrusted external images", () => {
    expect(shouldNormalizeToolImage({ mime: "image/png", metadata: { trust: "untrusted" } })).toBe(false)
  })

  test("ignores non-image attachments", () => {
    expect(shouldNormalizeToolImage({ mime: "application/pdf", metadata: { trust: "untrusted" } })).toBe(false)
  })
})
