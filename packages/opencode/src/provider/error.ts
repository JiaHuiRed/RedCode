import { APICallError } from "ai"
import { STATUS_CODES } from "http"
import { iife } from "@/util/iife"
import type { ProviderID } from "./schema"

// Adapted from overflow detection patterns in:
// https://github.com/badlogic/pi-mono/blob/main/packages/ai/src/utils/overflow.ts
const OVERFLOW_PATTERNS = [
  /prompt is too long/i, // Anthropic
  /request_too_large/i, // Anthropic error code
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions + Responses API message text)
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible variants
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /tokens in request more than max tokens allowed/i, // z.ai
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter, DeepSeek, vLLM
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding, Moonshot
  /context[_ ]length[_ ]exceeded/i, // Generic fallback
  /request entity too large/i, // HTTP 413
  /context length is only \d+ tokens/i, // vLLM
  /input length.*exceeds.*context length/i, // vLLM
  /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
  /too large for model with \d+ maximum context length/i, // Mistral
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // llama.cpp/Ollama configured ctx
  /model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
  /too many tokens/i, // 宽泛兜底，靠下方 OVERFLOW_EXCLUSIONS 挡住限流类误判
  /token limit exceeded/i, // 同上
]

// 限流/服务不可用类报错常带 token 字样（如 "rate limit: too many tokens per minute"），
// 不是上下文溢出，误判会触发无意义的自动压缩。排除优先于一切匹配。
const OVERFLOW_EXCLUSIONS = [/^(throttling error|service unavailable):/i, /rate limit/i, /too many requests/i]

// 260822 cc 网关的**请求体积**上限，不是上下文溢出。
//
// 两者都可能以 413 回来，但补救方式相反：上下文溢出该触发压缩，体积超限压缩帮不上忙
// （图片载荷占大头时尤其如此），而且原样重发同一个超限请求体不可能成功——每次重试都
// 白烧一次。官方 deepseek-harness 记录的线上措辞是
// "Failed to buffer the request body: length limit exceeded"，两张截图即触发。
//
// 只按措辞判，不按状态码：裸 413（无 body，Cerebras/Mistral 常见）仍走原来的
// context_overflow 启发式——那种情况下没有信息可判，而"上下文太大"是更常见的成因。
const REQUEST_BODY_LIMIT_PATTERNS = [
  /failed to buffer the request body/i,
  /request body.{0,20}length limit exceeded/i,
  /body.{0,10}(size|length) (limit )?exceeded/i,
  /request (body|payload) too large/i,
]

function isRequestBodyLimit(message: string) {
  if (OVERFLOW_PATTERNS.some((p) => p.test(message))) return false // 明说了上下文的，按上下文处理
  return REQUEST_BODY_LIMIT_PATTERNS.some((p) => p.test(message))
}

function isOpenAiErrorRetryable(e: APICallError) {
  const status = e.statusCode
  if (!status) return e.isRetryable
  // openai sometimes returns 404 for models that are actually available
  return status === 404 || e.isRetryable
}

// Providers not reliably handled in this function:
// - z.ai: can accept overflow silently (needs token-count/context-window checks)
function isOverflow(message: string) {
  if (OVERFLOW_EXCLUSIONS.some((p) => p.test(message))) return false
  if (OVERFLOW_PATTERNS.some((p) => p.test(message))) return true

  // Providers/status patterns handled outside of regex list:
  // - Cerebras: often returns "400 (no body)" / "413 (no body)"
  // - Mistral: often returns "400 (no body)" / "413 (no body)"
  return /^4(00|13)\s*(status code)?\s*\(no body\)/i.test(message)
}

function message(providerID: ProviderID, e: APICallError) {
  return iife(() => {
    const msg = e.message
    if (msg === "") {
      if (e.responseBody) return e.responseBody
      if (e.statusCode) {
        const err = STATUS_CODES[e.statusCode]
        if (err) return err
      }
      return "Unknown error"
    }

    if (!e.responseBody || (e.statusCode && msg !== STATUS_CODES[e.statusCode])) {
      return msg
    }

    try {
      const body = JSON.parse(e.responseBody)
      // try to extract common error message fields
      const errMsg = body.message || body.error || body.error?.message
      if (errMsg && typeof errMsg === "string") {
        return `${msg}: ${errMsg}`
      }
      // 260529 Red responseBody 非 JSON 或无 message 字段，继续走下方 HTML/原文兜底
    } catch {}

    // If responseBody is HTML (e.g. from a gateway or proxy error page),
    // provide a human-readable message instead of dumping raw markup
    if (/^\s*<!doctype|^\s*<html/i.test(e.responseBody)) {
      if (e.statusCode === 401) {
        return "Unauthorized: request was blocked by a gateway or proxy. Your authentication token may be missing or expired — try running `redcode auth login <your provider URL>` to re-authenticate."
      }
      if (e.statusCode === 403) {
        return "Forbidden: request was blocked by a gateway or proxy. You may not have permission to access this resource — check your account and provider settings."
      }
      return msg
    }

    return `${msg}: ${e.responseBody}`
  }).trim()
}

function json(input: unknown) {
  if (typeof input === "string") {
    try {
      const result = JSON.parse(input)
      if (result && typeof result === "object") return result
      return undefined
      // 260529 Red 非 JSON 字符串直接返回 undefined，由上层处理
    } catch {
      return undefined
    }
  }
  if (typeof input === "object" && input !== null) {
    return input
  }
  return undefined
}

export type ParsedStreamError =
  | {
      type: "context_overflow"
      message: string
      responseBody: string
    }
  | {
      type: "api_error"
      message: string
      isRetryable: boolean
      responseBody: string
    }

export function parseStreamError(input: unknown): ParsedStreamError | undefined {
  const raw = json(input)
  const body = typeof raw?.message === "string" ? (json(raw.message) ?? raw) : raw
  if (!body) return

  const responseBody = JSON.stringify(body)
  if (body.type !== "error") return

  switch (body?.error?.code) {
    case "context_length_exceeded":
      return {
        type: "context_overflow",
        message: "Input exceeds context window of this model",
        responseBody,
      }
    case "insufficient_quota":
      return {
        type: "api_error",
        message: "Quota exceeded. Check your plan and billing details.",
        isRetryable: false,
        responseBody,
      }
    case "usage_not_included":
      return {
        type: "api_error",
        message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
        isRetryable: false,
        responseBody,
      }
    case "invalid_prompt":
      return {
        type: "api_error",
        message: typeof body?.error?.message === "string" ? body?.error?.message : "Invalid prompt.",
        isRetryable: false,
        responseBody,
      }
    case "server_is_overloaded":
    case "server_error":
      return {
        type: "api_error",
        message: typeof body?.error?.message === "string" ? body?.error?.message : "Server error.",
        isRetryable: true,
        responseBody,
      }
  }
}

export type ParsedAPICallError =
  | {
      type: "context_overflow"
      message: string
      responseBody?: string
    }
  | {
      type: "api_error"
      message: string
      statusCode?: number
      isRetryable: boolean
      responseHeaders?: Record<string, string>
      responseBody?: string
      metadata?: Record<string, string>
    }

export function parseAPICallError(input: { providerID: ProviderID; error: APICallError }): ParsedAPICallError {
  const m = message(input.providerID, input.error)
  const body = json(input.error.responseBody)
  // 请求体积超限必须在溢出判断**之前**拦下：它同样以 413 回来，会被下面那个无条件的
  // statusCode === 413 吞进 context_overflow，于是压缩被白触发一次、重试又原样重发同一个
  // 超限请求体。归为不可重试的 api_error，让上层直接把真实原因报给用户。
  if (isRequestBodyLimit(m)) {
    return {
      type: "api_error",
      message: m,
      statusCode: input.error.statusCode,
      isRetryable: false,
      responseHeaders: input.error.responseHeaders,
      responseBody: input.error.responseBody,
      metadata: input.error.url ? { url: input.error.url } : undefined,
    }
  }
  if (isOverflow(m) || input.error.statusCode === 413 || body?.error?.code === "context_length_exceeded") {
    return {
      type: "context_overflow",
      message: m,
      responseBody: input.error.responseBody,
    }
  }

  const metadata = input.error.url ? { url: input.error.url } : undefined
  return {
    type: "api_error",
    message: m,
    statusCode: input.error.statusCode,
    isRetryable: input.providerID.startsWith("openai") ? isOpenAiErrorRetryable(input.error) : input.error.isRetryable,
    responseHeaders: input.error.responseHeaders,
    responseBody: input.error.responseBody,
    metadata,
  }
}

export * as ProviderError from "./error"
