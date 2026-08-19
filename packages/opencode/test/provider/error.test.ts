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
