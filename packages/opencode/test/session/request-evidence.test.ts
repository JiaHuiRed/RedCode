import { describe, expect, test } from "bun:test"
import { LLMEvent, ToolResultValue, Usage } from "@redcode-ai/llm"
import { LLMClient, RequestExecutor, WebSocketExecutor } from "@redcode-ai/llm/route"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { jsonSchema, streamText, tool, wrapLanguageModel } from "ai"
import { Effect, Layer, Schema, Stream } from "effect"
import crypto from "node:crypto"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { OAUTH_DUMMY_KEY } from "@/auth"
import { RequestEvidence } from "@/session/request-evidence"
import { ConfigRequestEvidence } from "@/config/request-evidence"
import { Config } from "@/config/config"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import { testEffect } from "../lib/effect"

const model: Provider.Model = {
  id: ModelID.make("gpt-5-mini"),
  providerID: ProviderID.make("openai"),
  api: { id: "gpt-5-mini", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
  name: "GPT-5 Mini",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 128_000, input: 128_000, output: 32_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

const provider = {
  id: ProviderID.make("openai"),
  name: "OpenAI",
  source: "config",
  env: ["OPENAI_API_KEY"],
  options: { apiKey: "test-openai-key" },
  models: {},
} satisfies Provider.Info

const clientLayer = LLMClient.layer.pipe(
  Layer.provide(Layer.mergeAll(RequestExecutor.defaultLayer, WebSocketExecutor.layer)),
)
const it = testEffect(clientLayer)
const context = (over: Partial<Parameters<typeof RequestEvidence.create>[0]> = {}) => ({
  sessionID: "ses_request_evidence",
  modelKey: "openai/gpt-5-mini",
  runtime: "ai-sdk" as const,
  model,
  ...over,
})

type Captured = Extract<ReturnType<ReturnType<typeof RequestEvidence.create>["capture"]>, { status: "captured" }>

const captured = (observation: ReturnType<ReturnType<typeof RequestEvidence.create>["capture"]>): Captured => {
  if (observation.status !== "captured") throw new Error(`Expected captured request body, got ${observation.reason}`)
  return observation
}

const chatBody = (history = "first turn", system = "private system", tools: unknown[] = []) => ({
  messages: [
    { role: "system", content: system },
    { role: "user", content: history },
  ],
  tools,
})

describe("session.request-evidence", () => {
  test("validates file-backed diagnostic caps and resolves bounded defaults", () => {
    expect(ConfigRequestEvidence.resolve()).toEqual({
      maxBodyBytes: 16 * 1024 * 1024,
      maxMessages: 4096,
      maxPendingCompressions: 16,
    })
    const decoded = Schema.decodeUnknownSync(Config.Info)({
      experimental: { requestEvidence: { maxBodyBytes: 1024, maxMessages: 3, maxPendingCompressions: 2 } },
    })
    expect(ConfigRequestEvidence.resolve(decoded.experimental?.requestEvidence)).toEqual({
      maxBodyBytes: 1024, maxMessages: 3, maxPendingCompressions: 2,
    })
    for (const input of [
      { maxBodyBytes: 64 * 1024 * 1024 + 1 }, { maxBodyBytes: 0 },
      { maxMessages: 16385 }, { maxMessages: 1.5 }, { maxPendingCompressions: 129 },
    ]) {
      expect(() => ConfigRequestEvidence.resolve(input)).toThrow()
      expect(() => Schema.decodeUnknownSync(Config.Info)({ experimental: { requestEvidence: input } })).toThrow()
    }
  })

  test("fingerprints actual serialized bytes and control fields without exposing cache keys", () => {
    RequestEvidence.reset()
    const observer = RequestEvidence.create(context())
    const body = { ...chatBody(), model: "fixture-model", prompt_cache_key: "private-cache-key", reasoning: { effort: "high" } }
    const wire = JSON.stringify(body)
    const first = captured(observer.capture(wire))
    const same = captured(observer.capture(wire))
    const changed = captured(observer.capture({ ...body, prompt_cache_key: "different-private-key" }))
    const spaced = captured(observer.capture(JSON.stringify({ ...body, prompt_cache_key: "different-private-key" }, null, 2)))
    expect(first.serialized.sha256).toBe(crypto.createHash("sha256").update(wire).digest("hex"))
    expect(first.serialized.length).toBe(Buffer.byteLength(wire))
    expect(same.serialized.change).toBe("unchanged")
    expect(same.affinity.prompt_cache_key).toBe(first.affinity.prompt_cache_key)
    expect(changed.affinity.prompt_cache_key).not.toBe(first.affinity.prompt_cache_key)
    expect(changed.history.change).toBe("unchanged")
    expect(changed.parameters.change).toBe("rewrite")
    expect(changed.wire.change).toBe("unchanged")
    expect(changed.serialized.change).toBe("changed")
    expect(spaced.parameters.change).toBe("unchanged")
    expect(spaced.serialized.change).toBe("changed")
    expect(JSON.stringify([first, same, changed, spaced])).not.toContain("private-cache-key")
    expect(JSON.stringify([first, same, changed, spaced])).not.toContain("different-private-key")
    RequestEvidence.reset()
  })

  test("rejects malformed, cyclic and boundary payloads without resetting the last valid fingerprint", () => {
    RequestEvidence.reset()
    const limits = ConfigRequestEvidence.resolve({ maxBodyBytes: 1024, maxMessages: 2 })
    const observer = RequestEvidence.create(context(), limits)
    const prefix = '{"messages":[{"role":"user","content":"'
    const suffix = '"}]}'
    const body = prefix + "x".repeat(1024 - prefix.length - suffix.length) + suffix
    expect(captured(observer.capture(body)).serialized.length).toBe(1024)
    expect(observer.capture(body + " ")).toMatchObject({ status: "unsupported", reason: "body-too-large" })
    expect(observer.capture("{malformed")).toMatchObject({ status: "unsupported", reason: "invalid-json" })
    const cyclic: { messages: unknown[] } = { messages: [] }
    cyclic.messages.push(cyclic)
    expect(observer.capture(cyclic)).toMatchObject({ status: "unsupported", reason: "body-unavailable" })
    expect(observer.capture({ messages: Array.from({ length: 3 }, () => ({ role: "user", content: "x" })) }))
      .toMatchObject({ status: "unsupported", reason: "message-limit" })
    expect(captured(observer.capture(body)).history.change).toBe("unchanged")
    RequestEvidence.reset()
  })

  test("keeps concurrent transport identities scoped and prefers the final transport body", async () => {
    RequestEvidence.reset()
    const a = RequestEvidence.create(context({ sessionID: "ses_transport_a" }))
    const b = RequestEvidence.create(context({ sessionID: "ses_transport_b" }))
    const account = "private-account"
    const endpoint = "https://fixture.invalid/secret-route"
    const dispatch = (observer: typeof a, accountID: string, route: string) =>
      RequestEvidence.withRequest(observer, async () => {
        await Promise.resolve()
        const body = JSON.stringify({ ...chatBody(), prompt_cache_key: "final-private-key" })
        const transport = RequestEvidence.observeTransport({ accountID, endpoint: route, body })
        const capture = captured(observer.capture({ ...chatBody(), prompt_cache_key: "wrong-adapter-key" }))
        expect(transport?.requestID).toBe(capture.requestID)
        expect(capture.system.change).toBe("baseline")
        expect(capture.serialized.sha256).toBe(crypto.createHash("sha256").update(body).digest("hex"))
        return { transport, capture }
      })
    const [left, right] = await Promise.all([dispatch(a, account, endpoint), dispatch(b, "other-account", endpoint)])
    expect(left.transport?.requestID).not.toBe(right.transport?.requestID)
    expect(left.transport?.accountHash).not.toBe(right.transport?.accountHash)
    expect(left.transport?.endpointHash).toBe(right.transport?.endpointHash)
    const next = RequestEvidence.withRequest(a, () => RequestEvidence.observeTransport({ accountID: account, endpoint }))
    const moved = RequestEvidence.withRequest(a, () => RequestEvidence.observeTransport({ accountID: account, endpoint: endpoint + "/other" }))
    expect(next?.accountHash).toBe(left.transport?.accountHash)
    expect(moved?.endpointHash).not.toBe(next?.endpointHash)
    expect(RequestEvidence.observeTransport({ accountID: account, endpoint })).toBeUndefined()
    expect(JSON.stringify([left, right, next, moved])).not.toContain(account)
    expect(JSON.stringify([left, right, next, moved])).not.toContain(endpoint)
    expect(JSON.stringify([left, right, next, moved])).not.toContain("final-private-key")
    RequestEvidence.reset()
  })

  test("diagnostic capture failures do not prevent the original provider response", async () => {
    const result = { request: { body: "unchanged" }, response: { status: 200 } }
    const middleware = RequestEvidence.middleware({ capture() { throw new Error("broken diagnostic sink") } })
    expect(await middleware.wrapStream({ doStream: async () => result })).toBe(result)
  })

  test("compares long multibyte requests without retaining their contents", () => {
    RequestEvidence.reset()
    const observer = RequestEvidence.create(context())
    const body = chatBody(`private-long-context-${"语境🧠".repeat(80_000)}`)
    expect(Buffer.byteLength(JSON.stringify(body), "utf8")).toBeGreaterThan(512 * 1024)
    const before = JSON.stringify(body)
    const first = captured(observer.capture(body))
    const appended = captured(observer.capture({
      ...body,
      messages: [...body.messages, { role: "assistant", content: "new response" }],
    }))
    const rewritten = captured(observer.capture({
      ...body,
      messages: [body.messages[0], { role: "user", content: "changed old message" }],
    }))
    expect(first.history.change).toBe("baseline")
    expect(appended.history.change).toBe("append")
    expect(rewritten.history.change).toBe("rewrite")
    expect(JSON.stringify([first, appended, rewritten])).not.toContain("private-long-context")
    expect(JSON.stringify(body)).toBe(before)
    RequestEvidence.reset()
  })

  test("classifies wire prefix unchanged, appended, rewound, and rewritten without retaining text", () => {
    RequestEvidence.reset()
    const observer = RequestEvidence.create(context())
    const first = captured(observer.capture(chatBody()))
    const appended = captured(observer.capture({
      ...chatBody(),
      messages: [...chatBody().messages, { role: "assistant", content: "answer" }],
    }))
    const rewound = captured(observer.capture(chatBody()))
    const rewritten = captured(observer.capture(chatBody("changed")))
    const unchanged = captured(observer.capture(chatBody("changed")))

    expect(first).toMatchObject({
      status: "captured",
      system: { change: "baseline" },
      history: { change: "baseline" },
    })
    expect(appended.history.change).toBe("append")
    expect(rewound.history.change).toBe("rewind")
    expect(rewritten.history.change).toBe("rewrite")
    expect(unchanged.history.change).toBe("unchanged")
    expect(first.wire.change).toBe("baseline")
    expect(appended.wire.change).toBe("changed")
    expect(rewound.wire.change).toBe("changed")
    expect(rewritten.wire.change).toBe("changed")
    expect(unchanged.wire.change).toBe("unchanged")
    expect(first.requestID).not.toBe(appended.requestID)
    expect(first.requestID).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.stringify([first, appended, rewound, rewritten, unchanged])).not.toContain("private system")
    expect(JSON.stringify([first, appended, rewound, rewritten, unchanged])).not.toContain("first turn")

    const toolsObserver = RequestEvidence.create(context({ modelKey: "openai/tool-prefix" }))
    expect(captured(toolsObserver.capture(chatBody())).tools.change).toBe("baseline")
    expect(
      captured(
        toolsObserver.capture(chatBody("first turn", "private system", [{ type: "function", function: { name: "lookup" } }])),
      ).tools.change,
    ).toBe("append")
    expect(
      captured(
        toolsObserver.capture(chatBody("first turn", "private system", [{ type: "function", function: { name: "search" } }])),
      ).tools.change,
    ).toBe("rewrite")
    RequestEvidence.reset()
  })

  test("detects whole-wire reordering that section diffs report as unchanged", () => {
    RequestEvidence.reset()
    const observer = RequestEvidence.create(context())
    const moved = {
      messages: [
        { role: "user", content: "first turn" },
        { role: "system", content: "private system" },
      ],
      tools: [],
    }
    const first = captured(observer.capture(chatBody()))
    const reordered = captured(observer.capture(moved))
    const same = captured(observer.capture(moved))

    // system 角色消息在 messages 里换了位置：两个 section 的内容和顺序都没变，
    // 只有 whole-wire 顺序证据能证明这次跨段重排真的发生了
    expect(first.wire.change).toBe("baseline")
    expect(first.wire.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(reordered.system.change).toBe("unchanged")
    expect(reordered.history.change).toBe("unchanged")
    expect(reordered.wire.change).toBe("changed")
    expect(reordered.wire.sha256).not.toBe(first.wire.sha256)
    expect(reordered.wire.length).toBeGreaterThan(0)
    expect(same.wire.change).toBe("unchanged")
    expect(same.wire.length).toBe(reordered.wire.length)
    expect(JSON.stringify([first, reordered, same])).not.toContain("private system")
    expect(JSON.stringify([first, reordered, same])).not.toContain("first turn")
    RequestEvidence.reset()
  })

  test("keeps independent session/model/runtime baselines and does not reset on model interleaving", () => {
    RequestEvidence.reset()
    const a = RequestEvidence.create(context())
    const b = RequestEvidence.create(context({ modelKey: "openai/other" }))
    expect(captured(a.capture(chatBody())).history.change).toBe("baseline")
    expect(captured(b.capture(chatBody("other history"))).history.change).toBe("baseline")
    expect(captured(a.capture(chatBody())).history.change).toBe("unchanged")
    const native = RequestEvidence.create(context({ runtime: "native" }))
    expect(captured(native.capture(chatBody())).history.change).toBe("baseline")
    for (let index = 0; index < 40; index++) {
      const isolated = RequestEvidence.create(context({ sessionID: `ses_${index}` }))
      captured(isolated.capture(chatBody()))
    }
    expect(RequestEvidence.size()).toBe(32)
    RequestEvidence.reset()
  })

  test("does not compare oversized or over-limit payloads as stable", () => {
    RequestEvidence.reset()
    const observer = RequestEvidence.create(context(), ConfigRequestEvidence.resolve({
      maxBodyBytes: 512 * 1024,
      maxMessages: 2048,
    }))
    expect(captured(observer.capture(chatBody())).status).toBe("captured")
    expect(observer.capture({ messages: [{ role: "user", content: "x".repeat(512 * 1024) }] })).toMatchObject({
      status: "unsupported",
      reason: "body-too-large",
    })
    expect(observer.capture({ messages: Array.from({ length: 2049 }, () => ({ role: "user", content: "x" })) })).toMatchObject({
      status: "unsupported",
      reason: "message-limit",
    })
    expect(captured(observer.capture(chatBody())).history.change).toBe("unchanged")
    RequestEvidence.reset()
  })

  test("supports Responses, Anthropic, Gemini, and signed-thinking wire histories", () => {
    RequestEvidence.reset()
    const observer = RequestEvidence.create(context())
    const responses = captured(observer.capture({
      instructions: "private instructions",
      input: [{ role: "user", content: [{ type: "input_text", text: "question" }] }],
    }))
    expect(responses.status).toBe("captured")
    expect(captured(observer.capture({
      system: [{ type: "text", text: "private system" }],
      messages: [{ role: "user", content: "question" }],
    })).system.change).toBe("rewrite")
    expect(captured(observer.capture({
      system_instruction: { parts: [{ text: "private system" }] },
      contents: [{ role: "user", parts: [{ text: "question" }] }],
    })).status).toBe("captured")
    const signedThinking = {
      messages: [
        { role: "system", content: "stable" },
        { role: "assistant", content: [{ type: "reasoning", text: "thinking", signature: "signed" }] },
      ],
    }
    expect(captured(observer.capture(signedThinking)).history.change).toBe("rewrite")
    expect(captured(observer.capture(signedThinking)).history.change).toBe("unchanged")
    expect(JSON.stringify(captured(observer.capture(signedThinking)))).not.toContain("signed")
    RequestEvidence.reset()
  })

  test("reports explicit cache zero but leaves absent cache fields unknown", () => {
    RequestEvidence.reset()
    const observer = RequestEvidence.create(context())
    const known = observer.event(
      LLMEvent.stepFinish({
        index: 0,
        reason: "stop",
        usage: new Usage({ inputTokens: 0, outputTokens: 1, cacheReadInputTokens: 0 }),
      }),
    )
    const unknown = observer.event(
      LLMEvent.stepFinish({ index: 1, reason: "stop", usage: new Usage({ outputTokens: 1 }) }),
    )
    expect(known).toMatchObject({
      type: "usage",
      usageStatus: "reported",
      cache: { status: "reported", cacheReadInputTokens: 0 },
    })
    expect(unknown).toMatchObject({
      type: "usage",
      usageStatus: "output-only-estimated",
      cache: { status: "unknown" },
      rawUsage: { outputTokens: 1 },
    })
    expect(unknown).not.toHaveProperty("rawUsage.inputTokens")
    RequestEvidence.reset()
  })

  test("carries validated DCP compression scalars to current usage and the next wire prefix", () => {
    RequestEvidence.reset()
    const observer = RequestEvidence.create(context())
    const compression = {
      version: 1,
      runId: 7,
      blockCount: 3,
      inputTokensEstimated: 100,
      summaryTokensEstimated: 30,
      netSavingsEstimated: 70,
    }
    const observed = observer.event(
      LLMEvent.toolResult({
        id: "compress-call",
        name: "compress",
        result: ToolResultValue.make({ metadata: { dcpCompression: compression } }),
      }),
    )
    observer.event(
      LLMEvent.toolResult({
        id: "compress-call",
        name: "compress",
        result: ToolResultValue.make({ metadata: { dcpCompression: compression } }),
      }),
    )
    const usage = observer.event(
      LLMEvent.stepFinish({ index: 0, reason: "tool-calls", usage: new Usage({ outputTokens: 1 }) }),
    )
    expect(observed).toMatchObject({ type: "compression", status: "recorded", blockCount: 3 })
    expect(usage).toMatchObject({ type: "usage", lastCompression: { netSavingsEstimated: 70 } })
    const nextPrefix = captured(observer.capture(chatBody("compressed summary")))
    expect(nextPrefix.afterCompression).toHaveLength(1)
    expect(nextPrefix.afterCompression).toMatchObject([{ inputTokensEstimated: 100, summaryTokensEstimated: 30 }])
    expect(JSON.stringify([observed, usage, nextPrefix])).not.toContain("runId")
    expect(observer.event(
      LLMEvent.toolResult({
        id: "invalid-net",
        name: "compress",
        result: ToolResultValue.make({ metadata: { dcpCompression: { ...compression, netSavingsEstimated: -70 } } }),
      }),
    )).toMatchObject({ type: "compression", status: "invalid" })
    expect(observer.event(
      LLMEvent.toolResult({
        id: "negative-net",
        name: "compress",
        result: ToolResultValue.make({
          metadata: {
            dcpCompression: {
              ...compression,
              inputTokensEstimated: 30,
              summaryTokensEstimated: 70,
              netSavingsEstimated: -40,
            },
          },
        }),
      }),
    )).toMatchObject({ type: "compression", status: "recorded", netSavingsEstimated: -40 })
    expect(captured(observer.capture(chatBody("net negative"))).afterCompression).toMatchObject([
      { netSavingsEstimated: -40 },
    ])
    for (let index = 0; index < 20; index++) {
      observer.event(
        LLMEvent.toolResult({
          id: `bounded-${index}`,
          name: "compress",
          result: ToolResultValue.make({
            metadata: {
              dcpCompression: {
                ...compression,
                runId: index + 1,
                inputTokensEstimated: index,
                summaryTokensEstimated: 0,
                netSavingsEstimated: index,
              },
            },
          }),
        }),
      )
    }
    expect(captured(observer.capture(chatBody("bounded pending"))).afterCompression).toHaveLength(16)
    RequestEvidence.reset()
  })

  test("captures AI SDK's actual outbound body through the production middleware", async () => {
    RequestEvidence.reset()
    let wireBody: string | undefined
    let middlewareBody: unknown
    let middlewareResult: ReturnType<ReturnType<typeof RequestEvidence.create>["capture"]> | undefined
    const observer = RequestEvidence.create(context())
    const fakeFetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
        wireBody = typeof init?.body === "string" ? init.body : undefined
        return new Response(
          [
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}`,
            "",
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
            "",
            "data: [DONE]",
            "",
          ].join("\n"),
          { headers: { "Content-Type": "text/event-stream" } },
        )
      },
      { preconnect: () => undefined },
    ) satisfies typeof fetch
    const compatible = createOpenAICompatible({
      name: "request-evidence-test",
      baseURL: "https://example.test/v1",
      apiKey: "test-key",
      fetch: fakeFetch,
    })
    const languageModel = wrapLanguageModel({
      model: compatible.chatModel("fixture-model"),
      middleware: [
        RequestEvidence.middleware({
          capture(body) {
            middlewareBody = body
            middlewareResult = observer.capture(body)
            return middlewareResult
          },
        }),
      ],
    })
    const result = streamText({
      model: languageModel,
      messages: [{ role: "system", content: "private wire system" }, { role: "user", content: "hello" }],
      allowSystemInMessages: true,
      tools: {
        lookup: tool({
          description: "lookup",
          inputSchema: jsonSchema({ type: "object", properties: {} }),
        }),
      },
    })
    for await (const _part of result.fullStream) {
      // 261004 Red Consume the provider response to exercise the middleware request seam.
    }

    expect(wireBody).toBeDefined()
    const wire = wireBody as string
    expect(typeof middlewareBody === "string" ? middlewareBody : JSON.stringify(middlewareBody)).toBe(wire)
    expect(middlewareResult).toMatchObject({ status: "captured", system: { change: "baseline" } })
    expect(JSON.stringify(middlewareResult)).not.toContain("private wire system")
    expect(JSON.parse(wire)).toMatchObject({
      messages: [
        { role: "system", content: "private wire system" },
        { role: "user", content: "hello" },
      ],
    })
    RequestEvidence.reset()
  })

  it.effect("observes the exact native fetch body without replacing OAuth fetch semantics", () =>
    Effect.gen(function* () {
      RequestEvidence.reset()
      let wireBody: BodyInit | null | undefined
      let observedBody: unknown
      const observer = RequestEvidence.create(context({ runtime: "native" }))
      const captured: ReturnType<typeof observer.capture>[] = []
      let transport: RequestEvidence.TransportObservation | undefined
      const customFetch = Object.assign(
        async (_input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
          wireBody = init?.body
          transport = RequestEvidence.observeTransport({
            accountID: "private-native-account",
            endpoint: "https://example.test/final-native-route",
            body: init?.body,
          })
          return new Response(
            [
              `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", delta: "ok" })}`,
              "",
              `data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } })}`,
              "",
            ].join("\n"),
            { headers: { "Content-Type": "text/event-stream" } },
          )
        },
        { preconnect: () => undefined },
      ) satisfies typeof fetch
      const llmClient = yield* LLMClient.Service
      const native = LLMNativeRuntime.stream({
        model,
        provider: { ...provider, options: { apiKey: OAUTH_DUMMY_KEY, fetch: customFetch } },
        auth: { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000 },
        llmClient,
        messages: [{ role: "user", content: "hello" }],
        tools: {},
        providerOptions: { instructions: "private native system" },
        headers: {},
        abort: new AbortController().signal,
        requestEvidence: observer,
        observeRequest(body) {
          observedBody = body
          captured.push(observer.capture(body))
        },
      })
      expect(native.type).toBe("supported")
      if (native.type === "unsupported") return
      yield* native.stream.pipe(Stream.runCollect)

      expect(typeof wireBody).toBe("object")
      expect(typeof observedBody).toBe("string")
      expect(JSON.parse(observedBody as string)).toMatchObject({
        instructions: "private native system",
      })
      expect(JSON.stringify(captured[0])).not.toContain("private native system")
      const transportID = transport?.requestID
      if (!transportID) throw new Error("Native transport was not observed")
      expect(captured[0]?.requestID).toBe(transportID)
      expect(captured[0]).toMatchObject({ status: "captured", system: { change: "baseline" } })
      expect(JSON.stringify(transport)).not.toContain("private-native-account")
      RequestEvidence.reset()
    }),
  )
})
