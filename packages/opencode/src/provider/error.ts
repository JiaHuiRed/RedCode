import { APICallError } from "ai"
import { STATUS_CODES } from "http"
import { iife } from "@/util/iife"
import { isRecord } from "@/util/record"
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

// 261103 Red 订阅额度耗尽必须终止，不能自动重试。
//
// GLM Coding Plan（5 小时/7 天窗口）与 ChatGPT 订阅（5 小时窗口）耗尽后都回 429，
// 但 body 里的业务错误码明确表示「本窗口不会自己恢复」；AI SDK 对所有 429 都标
// isRetryable=true，旧逻辑因此重试到 RETRY_MAX_ATTEMPTS（10 次 × 最长 10 分钟等待）。
// 真机记录（2026-10-30/31 两条 gpt-6.1-terra 消息）里一条消息空转 27 分钟后才落错误，
// 期间用户看到的是「还在请求」，实际每次都撞同一个已耗尽的窗口。这里把这类错误归成
// non-retryable，并把重置时间写进 message，让会话立刻停下、用户能及时切模型。
// z.ai 错误码：https://docs.z.ai/api-reference/api-code
// 决策见 docs/notes/implemented/bug-fix/2026-11-03-subscription-usage-limit-terminal.md
const USAGE_LIMIT_CODES = new Set([
  "1113", // 余额不足/无资源包
  "1308", // {number}{unit} 窗口用量上限（含 5 小时）
  "1310", // 每周/每月上限
  "1316", // 5 小时上限且无额外余额
  "1317", // 7 天上限且无额外余额
  "1318", // 5 小时上限 + 月消费上限
  "1319", // 7 天上限 + 月消费上限
  "1320", // 5 小时上限 + 月消费上限（企业档）
  "1321", // 7 天上限 + 月消费上限（企业档）
])

// 261106 Red This transient refusal is upstream capacity, not plan quota; keep it retryable.
// Decision: docs/notes/implemented/bug-fix/2026-11-03-subscription-usage-limit-terminal.md.
const PREFILL_CAPACITY_MESSAGE = "Upstream model prefill capacity is temporarily full."

function isPrefillCapacityRefusal(error: unknown, message: string) {
  const detail = isRecord(error) ? error : undefined
  return (
    detail?.code === "prefill_cap_refused" ||
    detail?.type === "prefill_cap_refused" ||
    /prefill_cap_refused|the cell is at capacity/i.test(message)
  )
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function headerNumber(headers: Record<string, string> | undefined, name: string) {
  const raw = headers?.[name]
  if (raw === undefined) return undefined
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

function durationText(seconds: number) {
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return "不到 1 分钟"
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.ceil((total % 3_600) / 60)
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`
  if (hours > 0) return minutes > 0 ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`
  return `${minutes} 分钟`
}

function clockText(epochSeconds: number) {
  const date = new Date(epochSeconds * 1000)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

function subscriptionUsageLimit(
  error: unknown,
  headers: Record<string, string> | undefined,
  fallback: string,
  status?: number,
): string | undefined {
  const detail = isRecord(error) ? error : undefined
  const code = detail && typeof detail.code === "string" ? detail.code : undefined
  const type = detail && typeof detail.type === "string" ? detail.type : undefined
  const raw = detail && typeof detail.message === "string" ? detail.message : fallback

  if (type === "usage_limit_reached") {
    const windowMinutes =
      number(detail?.limit_window_minutes) ?? headerNumber(headers, "x-codex-primary-window-minutes")
    const window =
      windowMinutes === 300
        ? "5 小时窗口"
        : windowMinutes === 10080
          ? "7 天窗口"
          : windowMinutes
            ? `${windowMinutes} 分钟窗口`
            : "订阅"
    const plan = detail && typeof detail.plan_type === "string" ? `（${detail.plan_type} 套餐）` : ""
    const resetAt = number(detail?.resets_at) ?? headerNumber(headers, "x-codex-primary-reset-at")
    const resetIn = number(detail?.resets_in_seconds) ?? headerNumber(headers, "x-codex-primary-reset-after-seconds")
    const reset =
      resetAt !== undefined
        ? `，将于 ${clockText(resetAt)} 重置${resetIn !== undefined ? `（约 ${durationText(resetIn)} 后）` : ""}`
        : resetIn !== undefined
          ? `，约 ${durationText(resetIn)} 后重置`
          : ""
    return `ChatGPT 订阅${window}额度已用完${plan}${reset}。已停止自动重试，请切换模型或等待重置后继续。`
  }

  if (code && USAGE_LIMIT_CODES.has(code)) {
    return `${raw}（已停止自动重试；${code === "1113" ? "请充值或切换模型。" : "请切换模型，或等待重置后继续。"}）`
  }
  if (type === "insufficient_quota" || code === "insufficient_quota") {
    return `${raw}（额度已耗尽，已停止自动重试；请检查套餐/余额，或切换模型。）`
  }
  // 网关可能吃掉业务错误码，只留一句明说限额的文案；429 上这类措辞同样是终止信号。
  if (
    status === 429 &&
    /usage limit (?:has been )?(?:reached|exceeded)|usage_limit_reached|exceeded your current quota|使用上限|额度已?(?:用尽|耗尽)/i.test(
      raw,
    )
  ) {
    return `${raw}（已停止自动重试；请切换模型，或等待重置后继续。）`
  }
  return undefined
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

  const usage = subscriptionUsageLimit(
    isRecord(body?.error) ? body.error : body,
    undefined,
    typeof body?.error?.message === "string" ? body.error.message : "",
  )
  if (usage) {
    return {
      type: "api_error",
      message: usage,
      isRetryable: false,
      responseBody,
    }
  }

  if (isPrefillCapacityRefusal(body?.error, typeof body?.error?.message === "string" ? body.error.message : "")) {
    return {
      type: "api_error",
      message: PREFILL_CAPACITY_MESSAGE,
      isRetryable: true,
      responseBody,
    }
  }

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
        message: "额度已用尽，请检查套餐与账单信息。",
        isRetryable: false,
        responseBody,
      }
    case "usage_not_included":
      return {
        type: "api_error",
        message: "要在这份 ChatGPT 套餐中使用 Codex，请先升级到 Plus：https://chatgpt.com/explore/plus",
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

// 261111 Red 这三句是 AI SDK 的固定英文，用户看不出「连接断了、要不要重发」。
// 判断仍用原英文（上面的 overflow / 额度识别依赖原文），只在最终展示的 message 上替换。
function humanize(message: string): string | undefined {
  if (message === "Failed to process successful response")
    return "流式响应中断：与服务端的连接在传输中被断开（多为网络或代理抖动），可直接重发这条消息。"
  if (message === "Failed to process error response") return "错误响应解析失败：上游返回了无法识别的内容。"
  const unreachable = /^Cannot connect to API:\s*(.+)$/i.exec(message)
  if (unreachable) return `无法连接 API：${unreachable[1]}（检查网络或代理设置）。`
  return undefined
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
  // 261103 Red 订阅额度耗尽在溢出判断之前拦下：它不该触发压缩，更不该自动重试。
  const usage = subscriptionUsageLimit(
    isRecord(body?.error) ? body.error : body,
    input.error.responseHeaders,
    m,
    input.error.statusCode,
  )
  if (usage) {
    return {
      type: "api_error",
      message: usage,
      statusCode: input.error.statusCode,
      isRetryable: false,
      responseHeaders: input.error.responseHeaders,
      responseBody: input.error.responseBody,
      metadata: input.error.url ? { url: input.error.url } : undefined,
    }
  }
  if (isPrefillCapacityRefusal(isRecord(body?.error) ? body.error : body, m)) {
    return {
      type: "api_error",
      message: PREFILL_CAPACITY_MESSAGE,
      statusCode: input.error.statusCode,
      isRetryable: true,
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
    message: humanize(m) ?? m,
    statusCode: input.error.statusCode,
    isRetryable: input.providerID.startsWith("openai") ? isOpenAiErrorRetryable(input.error) : input.error.isRetryable,
    responseHeaders: input.error.responseHeaders,
    responseBody: input.error.responseBody,
    metadata,
  }
}

export * as ProviderError from "./error"
