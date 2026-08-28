import { describe, expect, test } from "bun:test"
import { estimateModelMessages, imageRequestTokens } from "@/session/image-tokens"
import { Token } from "@/util/token"

const model = { providerID: "deepseek" }

// 拼一个跟 toModelMessages 同形的 file part：图片是内联 data URL。
const inlineImage = (bytes: number) => ({
  type: "file",
  mediaType: "image/jpeg",
  url: `data:image/jpeg;base64,${"A".repeat(bytes)}`,
})

describe("imageRequestTokens", () => {
  test("prices a DeepSeek image at the published v4 ceiling", () => {
    expect(imageRequestTokens({ providerID: "deepseek" })).toBe(384)
  })

  // 默认值刻意等于 deepseek 那条：providerID 写错也不会静默改变行为。
  test("falls back to the same conservative value for unknown providers", () => {
    expect(imageRequestTokens({ providerID: "some-gateway" })).toBe(384)
    expect(imageRequestTokens({ providerID: "" })).toBe(384)
  })
})

describe("estimateModelMessages", () => {
  test("matches the plain estimator when there are no images", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "hello world" }] },
      { role: "assistant", content: [{ type: "text", text: "hi back" }] },
    ]
    expect(estimateModelMessages(messages, model)).toBe(Token.estimate(JSON.stringify(messages)))
  })

  // 这条是本次修复的核心：一张 400KB 的 JPEG 曾被算成十万量级。
  test("does not price an inline image by its base64 length", () => {
    const messages = [{ role: "user", content: [inlineImage(200 * 1024)] }]
    const naive = Token.estimate(JSON.stringify(messages))
    const priced = estimateModelMessages(messages, model)

    expect(naive).toBeGreaterThan(40_000)
    expect(priced).toBeLessThan(500)
    expect(priced).toBeGreaterThanOrEqual(384)
  })

  test("the estimate no longer grows with the image payload", () => {
    const small = [{ role: "user", content: [inlineImage(10 * 1024)] }]
    const large = [{ role: "user", content: [inlineImage(256 * 1024)] }]
    expect(estimateModelMessages(large, model)).toBe(estimateModelMessages(small, model))
  })

  test("charges each image once and keeps the surrounding text", () => {
    const one = [{ role: "user", content: [{ type: "text", text: "look" }, inlineImage(1024)] }]
    const three = [
      { role: "user", content: [{ type: "text", text: "look" }, inlineImage(1024), inlineImage(1024), inlineImage(1024)] },
    ]
    expect(estimateModelMessages(three, model) - estimateModelMessages(one, model)).toBeGreaterThanOrEqual(768)
    expect(estimateModelMessages(three, model) - estimateModelMessages(one, model)).toBeLessThan(768 + 100)
  })

  // 反方向的失真：远程图片 URL 只占它自己那点长度，不计价就成了上游那个
  // "按结构 JSON 算成约 40 token、压缩迟到溢出" 的病。
  test("prices a remote image URL too, not just inline payloads", () => {
    const messages = [
      { role: "user", content: [{ type: "file", mediaType: "image/png", url: "https://example.com/a.png" }] },
    ]
    const naive = Token.estimate(JSON.stringify(messages))
    expect(naive).toBeLessThan(50)
    expect(estimateModelMessages(messages, model)).toBeGreaterThanOrEqual(384)
  })

  test("leaves non-image files priced by their serialized length", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "file", mediaType: "application/pdf", url: `data:application/pdf;base64,${"A".repeat(4000)}` }],
      },
    ]
    expect(estimateModelMessages(messages, model)).toBe(Token.estimate(JSON.stringify(messages)))
  })

  test("recognises the { mediaType, data } shape as well as { url }", () => {
    const messages = [{ role: "user", content: [{ type: "file", mediaType: "image/webp", data: "A".repeat(60_000) }] }]
    const priced = estimateModelMessages(messages, model)
    expect(priced).toBeLessThan(500)
    expect(priced).toBeGreaterThanOrEqual(384)
  })

  test("survives messages that are not objects", () => {
    expect(estimateModelMessages([], model)).toBe(Token.estimate("[]"))
    expect(estimateModelMessages(undefined, model)).toBe(0)
  })
})
