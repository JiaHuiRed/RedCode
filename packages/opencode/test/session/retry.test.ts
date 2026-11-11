import { describe, expect, test } from "bun:test"
import type { NamedError } from "@redcode-ai/core/util/error"
import { APICallError } from "ai"
import { setTimeout as sleep } from "node:timers/promises"
import { Effect, Layer, Schedule, Schema } from "effect"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { SessionRetry } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderID } from "../../src/provider/schema"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { StreamIdleTimeoutError } from "../../src/session/llm"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const providerID = ProviderID.make("test")
const retryProvider = "test"
const it = testEffect(Layer.mergeAll(SessionStatus.defaultLayer, CrossSpawnSpawner.defaultLayer))

function apiError(headers?: Record<string, string>): MessageV2.APIError {
  return Schema.decodeUnknownSync(MessageV2.APIError.Schema)(
    new MessageV2.APIError({
      message: "boom",
      isRetryable: true,
      responseHeaders: headers,
    }).toObject(),
  )
}

function wrap(message: unknown): ReturnType<NamedError["toObject"]> {
  return { name: "", data: { message } }
}

describe("session.retry.delay", () => {
  // 261107 Red 退避定版：首 3s、封顶 15s——瞬时容量拒绝快快重试，不再越等越久。
  test("caps delay at 15 seconds when headers missing", () => {
    const error = apiError()
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.delay(index + 1, error))
    expect(delays).toStrictEqual([3000, 6000, 12000, 15000, 15000, 15000, 15000, 15000, 15000, 15000])
  })

  // 261108 Red 回归：上游返回了响应头但没有有效 retry-after（如只有 content-type）时，
  // 该分支此前漏了 15s 封顶，第 4 次起 24s/48s/… 无限翻倍，恰好违背退避定版。
  // 应与无响应头分支同形：复用快退避。
  test("caps delay at 15 seconds when headers lack a valid retry hint", () => {
    const error = apiError({ "content-type": "application/json", "x-request-id": "req_test" })
    const delays = Array.from({ length: 8 }, (_, index) => SessionRetry.delay(index + 1, error))
    expect(delays).toStrictEqual([3000, 6000, 12000, 15000, 15000, 15000, 15000, 15000])
  })

  test("prefers retry-after-ms when shorter than exponential", () => {
    const error = apiError({ "retry-after-ms": "1500" })
    expect(SessionRetry.delay(4, error)).toBe(1500)
  })

  test("uses retry-after seconds when reasonable", () => {
    const error = apiError({ "retry-after": "30" })
    expect(SessionRetry.delay(3, error)).toBe(30000)
  })

  test("accepts http-date retry-after values", () => {
    const date = new Date(Date.now() + 20000).toUTCString()
    const error = apiError({ "retry-after": date })
    const d = SessionRetry.delay(1, error)
    expect(d).toBeGreaterThanOrEqual(19000)
    expect(d).toBeLessThanOrEqual(20000)
  })

  test("ignores invalid retry hints", () => {
    const error = apiError({ "retry-after": "not-a-number" })
    expect(SessionRetry.delay(1, error)).toBe(3000)
  })

  test("ignores malformed date retry hints", () => {
    const error = apiError({ "retry-after": "Invalid Date String" })
    expect(SessionRetry.delay(1, error)).toBe(3000)
  })

  test("ignores past date retry hints", () => {
    const pastDate = new Date(Date.now() - 5000).toUTCString()
    const error = apiError({ "retry-after": pastDate })
    expect(SessionRetry.delay(1, error)).toBe(3000)
  })

  // 260811 cc audit Y1：行为变更——retry-after 不再照单全收。此前上限是 2^31-1
  // （≈24.8 天），retry-after: 604800 会让会话静默睡一周；现在一律钳到
  // RETRY_MAX_DELAY（5 分钟，261107 Red 从 10 分钟收紧），更长的等待交给
  // RETRY_MAX_ATTEMPTS 尽早放弃。
  test("honors retry-after below the cap, clamps above it", () => {
    const error = apiError({ "retry-after": "50" })
    expect(SessionRetry.delay(1, error)).toBe(50000)

    const longError = apiError({ "retry-after-ms": "700000" })
    expect(SessionRetry.delay(1, longError)).toBe(SessionRetry.RETRY_MAX_DELAY)
  })

  test("caps oversized header delays to RETRY_MAX_DELAY", () => {
    const error = apiError({ "retry-after-ms": "999999999999" })
    expect(SessionRetry.delay(1, error)).toBe(SessionRetry.RETRY_MAX_DELAY)
  })

  it.live("policy updates retry status and increments attempts", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionID = SessionID.make("session-retry-test")
        const error = apiError({ "retry-after-ms": "0" })
        const status = yield* SessionStatus.Service

        const step = yield* Schedule.toStepWithMetadata(
          SessionRetry.policy({
            provider: "test",
            parse: Schema.decodeUnknownSync(MessageV2.APIError.Schema),
            set: (info) =>
              status.set(sessionID, {
                type: "retry",
                attempt: info.attempt,
                message: info.message,
                next: info.next,
              }),
          }),
        )
        yield* step(error)
        yield* step(error)

        expect(yield* status.get(sessionID)).toMatchObject({
          type: "retry",
          attempt: 2,
          message: "boom",
        })
      }),
    ),
  )

  // 261017 Red 回归：工具一旦出现，重试会重放请求并让模型再发一次同样的调用，
  // 非幂等操作（追加写、执行命令）就执行两遍。此时必须放弃自动重试。
  it.live("policy stops retrying once a tool call has started", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const error = apiError({ "retry-after-ms": "0" })
        const step = yield* Schedule.toStepWithMetadata(
          SessionRetry.policy({
            provider: retryProvider,
            parse: Schema.decodeUnknownSync(MessageV2.APIError.Schema),
            toolsStarted: () => true,
            set: () => Effect.void,
          }),
        )
        expect((yield* Effect.exit(step(error)))._tag).toBe("Failure")
      }),
    ),
  )

  it.live("policy still retries before any tool call appears", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const error = apiError({ "retry-after-ms": "0" })
        const step = yield* Schedule.toStepWithMetadata(
          SessionRetry.policy({
            provider: retryProvider,
            parse: Schema.decodeUnknownSync(MessageV2.APIError.Schema),
            toolsStarted: () => false,
            set: () => Effect.void,
          }),
        )
        expect((yield* Effect.exit(step(error)))._tag).toBe("Success")
      }),
    ),
  )

  // 260811 cc audit Y1：重试封顶——第 RETRY_MAX_ATTEMPTS+1 次失败不再排下一次等待
  it.live("policy gives up after RETRY_MAX_ATTEMPTS", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionID = SessionID.make("session-retry-cap-test")
        const error = apiError({ "retry-after-ms": "0" })
        const status = yield* SessionStatus.Service

        const step = yield* Schedule.toStepWithMetadata(
          SessionRetry.policy({
            provider: "test",
            parse: Schema.decodeUnknownSync(MessageV2.APIError.Schema),
            set: (info) =>
              status.set(sessionID, {
                type: "retry",
                attempt: info.attempt,
                message: info.message,
                next: info.next,
              }),
          }),
        )
        for (let i = 0; i < SessionRetry.RETRY_MAX_ATTEMPTS; i++) {
          yield* step(error)
        }
        const exit = yield* Effect.exit(step(error))
        expect(exit._tag).toBe("Failure")
        expect(yield* status.get(sessionID)).toMatchObject({
          type: "retry",
          attempt: SessionRetry.RETRY_MAX_ATTEMPTS,
        })
      }),
    ),
  )

  it.live("policy classifies stream timeouts before message error normalization", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionID = SessionID.make("session-retry-timeout-test")
        const status = yield* SessionStatus.Service
        const timeout = new StreamIdleTimeoutError(120_000)
        expect(MessageV2.fromError(timeout, { providerID }).name).toBe("UnknownError")
        const step = yield* Schedule.toStepWithMetadata(
          SessionRetry.policy({
            provider: retryProvider,
            parse: (error) => MessageV2.fromError(error, { providerID }),
            set: (info) =>
              status.set(sessionID, {
                type: "retry",
                attempt: info.attempt,
                message: info.message,
                next: info.next,
              }),
          }),
        )
        const exit = yield* Effect.exit(step(timeout))

        expect(exit._tag).toBe("Success")
        expect(yield* status.get(sessionID)).toMatchObject({
          type: "retry",
          attempt: 1,
          message: "响应流中断，正在重试",
        })
      }),
    ),
  )
})

describe("session.retry.messagePreview", () => {
  test("exposes expand affordance at the same boundary as the preview", () => {
    expect(SessionRetry.messagePreview("x".repeat(80))).toEqual({
      message: "x".repeat(80),
      truncated: false,
    })
    expect(SessionRetry.messagePreview("x".repeat(81))).toEqual({
      message: `${"x".repeat(80)}...`,
      truncated: true,
    })
    expect(SessionRetry.messagePreview("x".repeat(120)).truncated).toBe(true)
  })
})

describe("session.retry.retryable", () => {
  test("maps too_many_requests json messages", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { type: "too_many_requests" } }))
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "请求过于频繁" })
  })

  test("maps overloaded provider codes", () => {
    const error = wrap(JSON.stringify({ code: "resource_exhausted" }))
    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "供应商负载过高" })
  })

  test("does not retry unknown json messages", () => {
    const error = wrap(JSON.stringify({ error: { message: "no_kv_space" } }))
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("does not throw on numeric error codes", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { code: 123 } }))
    const result = SessionRetry.retryable(error, retryProvider)
    expect(result).toBeUndefined()
  })

  test("returns undefined for non-json message", () => {
    const error = wrap("not-json")
    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  // 261108 Red RC 审计合并：三条明文限流用例形状全同（各自命中不同匹配分支），
  // test.each 一次覆盖三条分支。
  test.each([
    ["alibaba", "Upstream error from Alibaba: Request rate increased too quickly. To ensure system stability, please adjust your client logic to scale requests more smoothly over time."],
    ["generic rate limit", "Rate limit exceeded, please try again later"],
    ["too many requests", "Too many requests, please slow down"],
  ])("retries plain text rate limit errors (%s)", (_name, msg) => {
    expect(SessionRetry.retryable(wrap(msg), retryProvider)).toEqual({ message: msg })
  })

  test("does not retry context overflow errors", () => {
    const error = new MessageV2.ContextOverflowError({
      message: "Input exceeds context window of this model",
      responseBody: '{"error":{"code":"context_length_exceeded"}}',
    }).toObject()

    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries 500 errors even when isRetryable is false", () => {
    const error = Schema.decodeUnknownSync(MessageV2.APIError.Schema)(
      new MessageV2.APIError({
        message: "Internal server error",
        isRetryable: false,
        statusCode: 500,
        responseBody: '{"type":"api_error","message":"Internal server error"}',
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Internal server error" })
  })

  test("retries 502 bad gateway errors", () => {
    const error = Schema.decodeUnknownSync(MessageV2.APIError.Schema)(
      new MessageV2.APIError({
        message: "Bad gateway",
        isRetryable: false,
        statusCode: 502,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Bad gateway" })
  })

  test("retries 503 service unavailable errors", () => {
    const error = Schema.decodeUnknownSync(MessageV2.APIError.Schema)(
      new MessageV2.APIError({
        message: "Service unavailable",
        isRetryable: false,
        statusCode: 503,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toEqual({ message: "Service unavailable" })
  })

  test("does not retry 4xx errors when isRetryable is false", () => {
    const error = Schema.decodeUnknownSync(MessageV2.APIError.Schema)(
      new MessageV2.APIError({
        message: "Bad request",
        isRetryable: false,
        statusCode: 400,
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, retryProvider)).toBeUndefined()
  })

  test("retries ZlibError decompression failures", () => {
    const error = Schema.decodeUnknownSync(MessageV2.APIError.Schema)(
      new MessageV2.APIError({
        message: "响应解压失败：传输数据已损坏，可直接重发这条消息。",
        isRetryable: true,
        metadata: { code: "ZlibError" },
      }).toObject(),
    )

    const retryable = SessionRetry.retryable(error, retryProvider)
    expect(retryable).toBeDefined()
    expect(retryable).toEqual({ message: "响应解压失败：传输数据已损坏，可直接重发这条消息。" })
  })

  test("maps free limits to Go upsell action", () => {
    const error = Schema.decodeUnknownSync(MessageV2.APIError.Schema)(
      new MessageV2.APIError({
        message: "Free usage exceeded",
        isRetryable: true,
        statusCode: 429,
        responseBody: JSON.stringify({
          type: "error",
          error: { type: "FreeUsageLimitError", message: "Free usage exceeded" },
        }),
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, "redcode")).toEqual({
      message: SessionRetry.GO_UPSELL_MESSAGE,
      action: {
        reason: "free_tier_limit",
        provider: "redcode",
        title: "免费额度已用尽",
        message: "订阅 RedCode Go 可获得稳定访问，起价 $5/月。",
        label: "去订阅",
        link: SessionRetry.GO_UPSELL_URL,
      },
    })
  })

  test("maps Go subscription limits to workspace PAYG upsell", () => {
    const error = Schema.decodeUnknownSync(MessageV2.APIError.Schema)(
      new MessageV2.APIError({
        message: "Subscription quota exceeded. You can continue using free models.",
        isRetryable: true,
        statusCode: 429,
        responseHeaders: {
          "retry-after": "19380",
        },
        responseBody: JSON.stringify({
          type: "error",
          error: {
            type: "GoUsageLimitError",
            message: "Subscription quota exceeded. You can continue using free models.",
          },
          metadata: {
            workspace: "wrk_01K6XGM22R6FM8JVABE9XDQXGH",
            limitName: "5 hour",
          },
        }),
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, "redcode-go")).toEqual({
      message:
        "5 hour 额度已用尽，将在 5 小时 23 分钟后重置。如需现在继续使用该模型，请启用账户余额用量。 - https://redcode.dev/workspace/wrk_01K6XGM22R6FM8JVABE9XDQXGH/go",
      action: {
        reason: "account_rate_limit",
        provider: "redcode-go",
        title: "Go 额度已用尽",
        message: "5 hour 额度已用尽，将在 5 小时 23 分钟后重置。如需现在继续使用该模型，请启用账户余额用量。",
        label: "打开设置",
        link: "https://redcode.dev/workspace/wrk_01K6XGM22R6FM8JVABE9XDQXGH/go",
      },
    })
  })

  test("maps Go subscription limits without limit metadata", () => {
    const error = Schema.decodeUnknownSync(MessageV2.APIError.Schema)(
      new MessageV2.APIError({
        message: "Subscription quota exceeded. You can continue using free models.",
        isRetryable: true,
        statusCode: 429,
        responseHeaders: {
          "retry-after": "900",
        },
        responseBody: JSON.stringify({
          type: "error",
          error: {
            type: "GoUsageLimitError",
            message: "Subscription quota exceeded. You can continue using free models.",
          },
          metadata: {
            workspace: "wrk_01K6XGM22R6FM8JVABE9XDQXGH",
          },
        }),
      }).toObject(),
    )

    expect(SessionRetry.retryable(error, "redcode-go")?.action?.message).toBe(
      "额度已用尽，将在 15 分钟后重置。如需现在继续使用该模型，请启用账户余额用量。",
    )
  })
})

describe("session.message-v2.fromError", () => {
  test.concurrent(
    "converts ECONNRESET socket errors to retryable APIError",
    async () => {
      using server = Bun.serve({
        port: 0,
        idleTimeout: 8,
        async fetch(_req) {
          return new Response(
            new ReadableStream({
              async pull(controller) {
                controller.enqueue("Hello,")
                await sleep(10000)
                controller.enqueue(" World!")
                controller.close()
              },
            }),
            { headers: { "Content-Type": "text/plain" } },
          )
        },
      })

      const error = await fetch(new URL("/", server.url.origin))
        .then((res) => res.text())
        .catch((e) => e)

      const result = MessageV2.fromError(error, { providerID })

      expect(MessageV2.APIError.isInstance(result)).toBe(true)
      if (!MessageV2.APIError.isInstance(result)) throw new Error("expected APIError")
      expect(result.data.isRetryable).toBe(true)
      expect(result.data.message).toBe("连接被服务端重置（多为网络或代理中断），可直接重发这条消息。")
      expect(result.data.metadata?.code).toBe("ECONNRESET")
      expect(result.data.metadata?.message).toInclude("socket connection")
    },
    15_000,
  )

  test("ECONNRESET socket error is retryable", () => {
    const error = Schema.decodeUnknownSync(MessageV2.APIError.Schema)(
      new MessageV2.APIError({
        message: "连接被服务端重置（多为网络或代理中断），可直接重发这条消息。",
        isRetryable: true,
        metadata: { code: "ECONNRESET", message: "The socket connection was closed unexpectedly" },
      }).toObject(),
    )

    const retryable = SessionRetry.retryable(error, retryProvider)
    expect(retryable).toBeDefined()
    expect(retryable).toEqual({ message: "连接被服务端重置（多为网络或代理中断），可直接重发这条消息。" })
  })

  test("marks OpenAI 404 status codes as retryable", () => {
    const error = new APICallError({
      message: "boom",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 404,
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"error":"boom"}',
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID: ProviderID.make("openai") })
    if (!MessageV2.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
  })

  // 261103 Red 订阅额度耗尽：旧逻辑对 429 一路自动重试（真机一条消息空转 27 分钟），
  // 这里守住「归一化即不可重试」这条链，避免上游 parse 改动又把重试放回来。
  test("converts exhausted ChatGPT usage limits to a non-retryable APIError", () => {
    const error = new APICallError({
      message: "The usage limit has been reached",
      url: "https://chatgpt.com/backend-api/codex/responses",
      requestBodyValues: {},
      statusCode: 429,
      isRetryable: true,
      responseHeaders: {
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-after-seconds": "12640",
      },
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
    })
    const result = MessageV2.fromError(error, { providerID: ProviderID.make("openai") })

    if (!MessageV2.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(false)
    expect(result.data.message).toContain("5 小时窗口")
    expect(result.data.message).toContain("已停止自动重试")
    // 生产路径先拿原始错误判一次，再拿归一化结果判；两边都必须拒绝重试。
    expect(SessionRetry.retryable(error, "openai")).toBeUndefined()
    expect(SessionRetry.retryable(result, "openai")).toBeUndefined()
  })

  test("converts OpenAI server_error stream chunks to retryable APIError", () => {
    const result = MessageV2.fromError(
      {
        message: JSON.stringify({
          type: "error",
          sequence_number: 2,
          error: {
            type: "server_error",
            code: "server_error",
            message: "An error occurred while processing your request.",
            param: null,
          },
        }),
      },
      { providerID: ProviderID.make("openai") },
    )

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    if (!MessageV2.APIError.isInstance(result)) throw new Error("expected APIError")
    expect(result.data.isRetryable).toBe(true)
    expect(SessionRetry.retryable(result, retryProvider)).toEqual({
      message: "An error occurred while processing your request.",
    })
  })
})
