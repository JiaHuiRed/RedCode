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

// 261103 Red 订阅额度耗尽是终止信号，不是可重试的限流。
describe("parseAPICallError subscription usage limits", () => {
  const parseBody = (opts: {
    message?: string
    statusCode?: number
    isRetryable?: boolean
    responseBody?: string
    responseHeaders?: Record<string, string>
    providerID?: string
  }) =>
    parseAPICallError({
      providerID: ProviderID.make(opts.providerID ?? "openai"),
      error: new APICallError({
        message: opts.message ?? "The usage limit has been reached",
        url: "https://example.com/v1/responses",
        requestBodyValues: {},
        statusCode: opts.statusCode,
        isRetryable: opts.isRetryable,
        responseBody: opts.responseBody,
        responseHeaders: opts.responseHeaders,
      }),
    })

  test("codex usage_limit_reached is terminal and carries the reset window", () => {
    const result = parseBody({
      statusCode: 429,
      isRetryable: true,
      responseBody: JSON.stringify({
        error: {
          type: "usage_limit_reached",
          message: "The usage limit has been reached",
          plan_type: "plus",
          limit_window_minutes: 300,
          resets_at: 1793423554,
          resets_in_seconds: 12640,
        },
      }),
      responseHeaders: { "x-codex-primary-window-minutes": "300" },
    })

    expect(result.type).toBe("api_error")
    if (result.type !== "api_error") throw new Error("expected api_error")
    expect(result.isRetryable).toBe(false)
    expect(result.message).toContain("5 小时窗口")
    expect(result.message).toContain("重置")
    expect(result.message).toContain("已停止自动重试")
  })

  test("zhipu coding-plan usage-limit codes are terminal", () => {
    for (const code of ["1113", "1308", "1310", "1316", "1317", "1318", "1319", "1320", "1321"]) {
      const result = parseBody({
        providerID: "zhipuai-coding-plan",
        message: "您已达到使用上限",
        statusCode: 429,
        isRetryable: true,
        responseBody: JSON.stringify({ error: { code, message: "您已达到使用上限" } }),
      })
      expect(result.type).toBe("api_error")
      if (result.type !== "api_error") throw new Error("expected api_error")
      expect(result.isRetryable).toBe(false)
      expect(result.message).toContain("已停止自动重试")
    }
  })

  test("zhipu transient rate limit stays retryable", () => {
    const result = parseBody({
      providerID: "zhipuai-coding-plan",
      message: "Rate limit reached for requests",
      statusCode: 429,
      isRetryable: true,
      responseBody: JSON.stringify({ error: { code: "1302", message: "Rate limit reached for requests" } }),
    })

    expect(result.type).toBe("api_error")
    if (result.type !== "api_error") throw new Error("expected api_error")
    expect(result.isRetryable).toBe(true)
  })

  test("plain usage-limit wording on a 429 is terminal even without a code", () => {
    const result = parseBody({
      statusCode: 429,
      isRetryable: true,
      responseBody: JSON.stringify({ error: { message: "Usage limit reached for the past 5 hours" } }),
    })

    expect(result.type).toBe("api_error")
    if (result.type !== "api_error") throw new Error("expected api_error")
    expect(result.isRetryable).toBe(false)
  })
})
