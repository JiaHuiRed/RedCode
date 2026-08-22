import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { parseAPICallError } from "@/provider/error"
import { ProviderID } from "../../src/provider/schema"

const parse = (message: string) =>
  parseAPICallError({
    providerID: ProviderID.make("openai"),
    error: new APICallError({ message, url: "https://example.com/v1/chat", requestBodyValues: {} }),
  })

describe("parseAPICallError overflow detection", () => {
  test("recognizes established overflow messages", () => {
    expect(parse("prompt is too long: 210000 tokens > 200000 maximum").type).toBe("context_overflow")
    expect(parse("This model's maximum context length is 128000 tokens").type).toBe("context_overflow")
  })

  test("recognizes newer provider overflow wordings", () => {
    for (const msg of [
      "request_too_large",
      "Input exceeds the model's maximum context length of 32,768 tokens",
      "tokens in request more than max tokens allowed",
      "exceeds the maximum allowed input length of 65,536 tokens",
      "input (40000 tokens) is longer than the model's context length (32768 tokens)",
      "prompt has 12,345 tokens, but the configured context size is 8,192 tokens",
      "too many tokens",
      "token limit exceeded",
    ]) {
      expect(parse(msg).type).toBe("context_overflow")
    }
  })

  test("rate-limit style errors are not overflow even when they mention tokens", () => {
    for (const msg of [
      "rate limit: too many tokens per minute",
      "Too many requests, token limit exceeded for this minute",
      "throttling error: too many tokens",
      "service unavailable: token limit exceeded",
    ]) {
      expect(parse(msg).type).toBe("api_error")
    }
  })
})

// 260822 cc 网关请求体积超限 vs 上下文溢出
describe("parseAPICallError request-body limit", () => {
  const parse413 = (message: string, responseBody?: string) =>
    parseAPICallError({
      providerID: ProviderID.make("openai"),
      error: new APICallError({
        message,
        url: "https://example.com/v1/chat",
        requestBodyValues: {},
        statusCode: 413,
        responseBody,
      }),
    })

  // 官方 deepseek-harness 记录的线上措辞。压缩帮不上忙（图片载荷占大头），
  // 原样重发同一个超限请求体也不可能成功，所以必须归不可重试而不是 context_overflow。
  test("gateway body-size 413 is a non-retryable api_error, not context overflow", () => {
    const r = parse413("Failed to buffer the request body: length limit exceeded")
    expect(r.type).toBe("api_error")
    if (r.type === "api_error") {
      expect(r.isRetryable).toBe(false)
      expect(r.statusCode).toBe(413)
    }
  })

  test("other body-limit phrasings are recognized too", () => {
    for (const msg of ["Request body too large", "request payload too large", "body size limit exceeded"]) {
      expect(parse413(msg).type).toBe("api_error")
    }
  })

  // 明说了上下文的 413 仍按溢出处理——压缩确实是对的补救
  test("a 413 that names the context length is still context overflow", () => {
    expect(parse413("Request entity too large: context length exceeded").type).toBe("context_overflow")
  })

  // 裸 413（无 body，Cerebras/Mistral 常见）没有信息可判，维持原来的溢出启发式
  test("a bare 413 keeps the existing overflow heuristic", () => {
    expect(parse413("Payload Too Large").type).toBe("context_overflow")
  })
})
