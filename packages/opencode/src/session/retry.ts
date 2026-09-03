import type { NamedError } from "@redcode-ai/core/util/error"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"
import { isRecord } from "@/util/record"

export type Err = ReturnType<NamedError["toObject"]>

export const GO_UPSELL_MESSAGE = "Free usage exceeded, subscribe to Go"
export const GO_UPSELL_URL = "https://redcode.dev/go"
export type RetryReason = "free_tier_limit" | "account_rate_limit" | (string & {})

export type Retryable = {
  message: string
  action?: {
    reason: RetryReason
    provider: string
    title: string
    message: string
    label: string
    link?: string
  }
}

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
// 260811 cc audit Y1：原值 2^31-1（≈24.8 天）意味着 retry-after: 604800 这类头会让
// 会话静默睡一周。上限收到 10 分钟：更长的 retry-after 说明短期内重试无意义，
// 与 RETRY_MAX_ATTEMPTS 合并后最坏总等待约 100 分钟即放弃。
export const RETRY_MAX_DELAY = 600_000
// 260811 cc audit Y1：重试原先无次数上限——5xx 无条件可重试叠加请求体自身问题导致的
// 稳定 500，就是永不放弃的死循环，用户只能看 attempt 往上爬。
export const RETRY_MAX_ATTEMPTS = 10

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

export function delay(attempt: number, error?: MessageV2.APIError) {
  if (error) {
    const headers = error.data.responseHeaders
    if (headers) {
      const retryAfterMs = headers["retry-after-ms"]
      if (retryAfterMs) {
        const parsedMs = Number.parseFloat(retryAfterMs)
        if (!Number.isNaN(parsedMs)) {
          return cap(parsedMs)
        }
      }

      const retryAfter = headers["retry-after"]
      if (retryAfter) {
        const parsedSeconds = Number.parseFloat(retryAfter)
        if (!Number.isNaN(parsedSeconds)) {
          // convert seconds to milliseconds
          return cap(Math.ceil(parsedSeconds * 1000))
        }
        // Try parsing as HTTP date format
        const parsed = Date.parse(retryAfter) - Date.now()
        if (!Number.isNaN(parsed) && parsed > 0) {
          return cap(Math.ceil(parsed))
        }
      }

      return cap(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1))
    }
  }

  return cap(Math.min(RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1), RETRY_MAX_DELAY_NO_HEADERS))
}

export function retryable(error: Err, provider: string) {
  // context overflow errors should not be retried
  if (MessageV2.ContextOverflowError.isInstance(error)) return undefined
  // 260903 cc 传输层看门狗掐断的两类超时都可重试。
  //   它们既不是 APIError、文案也不匹配下面任何一条限流模式，此前一律落到函数末尾的
  //   `return undefined` = 直接 halt：用户等满 75 秒（或流中途静默 120 秒）之后看到的是
  //   报错，而不是自动重试一次。而这两类恰恰是最该重试的——网关停摆通常换一次连接就好。
  //   走 `_tag` 而不是 instanceof：这里拿到的 Err 已经过 Cause 归一化，跨模块的类实例
  //   判等不可靠（同一个类经不同打包路径会有两份）。
  const tag = (error as { _tag?: unknown })._tag
  if (tag === "FirstEventTimeoutError") return { message: "网关未响应，正在重试" }
  if (tag === "StreamIdleTimeoutError") return { message: "响应流中断，正在重试" }
  if (MessageV2.APIError.isInstance(error)) {
    const status = error.data.statusCode
    // 5xx errors are transient server failures and should always be retried,
    // even when the provider SDK doesn't explicitly mark them as retryable.
    if (!error.data.isRetryable && !(status !== undefined && status >= 500)) return undefined
    if (error.data.responseBody?.includes("FreeUsageLimitError")) {
      return {
        message: GO_UPSELL_MESSAGE,
        action: {
          reason: "free_tier_limit",
          provider,
          title: "Free limit reached",
          message: "Subscribe to RedCode Go for reliable access to the best open-source models, starting at $5/month.",
          label: "subscribe",
          link: GO_UPSELL_URL,
        },
      }
    }
    if (error.data.responseBody?.includes("GoUsageLimitError")) {
      const body = parseJSON(error.data.responseBody)
      const workspace = str(body?.metadata?.workspace)
      const limitName = str(body?.metadata?.limitName)
      const retryAfter = num(error.data.responseHeaders?.["retry-after"])
      const resetIn = iife(() => {
        if (retryAfter === undefined) return ""
        const seconds = Math.max(0, Math.ceil(retryAfter))
        const days = Math.floor(seconds / 86_400)
        const hours = Math.floor((seconds % 86_400) / 3_600)
        const minutes = Math.ceil((seconds % 3_600) / 60)
        const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`

        if (days > 0) return hours > 0 ? `${unit(days, "day")} ${unit(hours, "hour")}` : unit(days, "day")
        if (hours > 0) return minutes > 0 ? `${unit(hours, "hour")} ${unit(minutes, "minute")}` : unit(hours, "hour")
        return minutes > 0 ? unit(minutes, "minute") : "less than a minute"
      })

      const message = `${limitName ? `${limitName} usage limit` : "Usage limit"} reached. It will reset in ${resetIn}. To continue using this model now, enable usage from your available balance`

      const link = `https://redcode.dev/workspace/${workspace}/go`
      return {
        message: `${message} - ${link}`,
        action: {
          reason: "account_rate_limit",
          provider,
          title: "Go limit reached",
          message,
          label: "open settings",
          link,
        },
      }
    }
    return { message: error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message }
  }

  // Check for rate limit patterns in plain text error messages
  const msg = isRecord(error.data) ? error.data.message : undefined
  if (typeof msg === "string") {
    const lower = msg.toLowerCase()
    if (
      lower.includes("rate increased too quickly") ||
      lower.includes("rate limit") ||
      lower.includes("too many requests")
    ) {
      return { message: msg }
    }
  }

  const json = parseJSON(msg)
  if (!json || typeof json !== "object") return undefined
  const code = typeof json.code === "string" ? json.code : ""

  if (json.type === "error" && json.error?.type === "too_many_requests") {
    return { message: "Too Many Requests" }
  }
  if (code.includes("exhausted") || code.includes("unavailable")) {
    return { message: "Provider is overloaded" }
  }
  if (json.type === "error" && typeof json.error?.code === "string" && json.error.code.includes("rate_limit")) {
    return { message: "Rate Limited" }
  }
  return undefined
}

function str(value: unknown) {
  if (value === undefined || value === null) return ""
  return String(value)
}

function num(value: unknown) {
  const parsed = Number.parseFloat(str(value))
  if (Number.isNaN(parsed)) return undefined
  return parsed
}

function parseJSON(value: unknown) {
  return iife(() => {
    try {
      if (typeof value !== "string") return undefined
      return JSON.parse(value)
    } catch {
      return undefined
    }
  })
}

export function policy(opts: {
  provider: string
  parse: (error: unknown) => Err
  set: (input: { attempt: number; message: string; action?: Retryable["action"]; next: number }) => Effect.Effect<void>
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      const retry = retryable(error, opts.provider)
      if (!retry) return Cause.done(meta.attempt)
      if (meta.attempt > RETRY_MAX_ATTEMPTS) return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        const wait = delay(meta.attempt, MessageV2.APIError.isInstance(error) ? error : undefined)
        const now = yield* Clock.currentTimeMillis
        yield* opts.set({
          attempt: meta.attempt,
          message: retry.message,
          action: retry.action,
          next: now + wait,
        })
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

export * as SessionRetry from "./retry"
