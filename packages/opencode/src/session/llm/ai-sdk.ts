import { FinishReason, LLMEvent, ProviderMetadata, ToolResultValue } from "@redcode-ai/llm"
import { responsesIncompleteErrorMessage } from "@redcode-ai/llm/protocols/openai-responses"
import { Effect, Schema } from "effect"
import { type streamText } from "ai"
import { errorMessage } from "@/util/error"

type Result = Awaited<ReturnType<typeof streamText>>
type AISDKEvent = Result["fullStream"] extends AsyncIterable<infer T> ? T : never

export function adapterState() {
  return {
    step: 0,
    text: 0,
    reasoning: 0,
    textBytes: 0,
    reasoningBytes: 0,
    currentTextID: undefined as string | undefined,
    currentReasoningID: undefined as string | undefined,
    toolNames: {} as Record<string, string>,
    routedVia: undefined as string | undefined,
    routedViaPromise: undefined as Promise<void> | undefined,
    // 261014 Red 终态未完成追踪：当前 step 是否已有实报 step-finish（llm.ts 的估算
    // 守卫用，防双重记账）；以及最后一步的终态未完成 raw reason（finish 时消费，
    // 追加 provider-error，与 native 协议同语义）。
    sawStepFinish: false,
    terminalIncomplete: undefined as string | undefined,
  }
}

// 260803 Red byte counters feed the interrupted-stream usage estimate in llm.ts.
const byteLength = (text: string) => new TextEncoder().encode(text).length

function finishReason(value: string | undefined): FinishReason {
  return Schema.is(FinishReason)(value) ? value : "unknown"
}

function providerMetadata(value: unknown): ProviderMetadata | undefined {
  if (value == null) return undefined
  return Schema.is(ProviderMetadata)(value) ? value : undefined
}

function usage(value: unknown) {
  if (!value || typeof value !== "object") return undefined
  const item = value as {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    reasoningTokens?: number
    cachedInputTokens?: number
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number }
    outputTokenDetails?: { reasoningTokens?: number }
    raw?: Record<string, unknown>
  }
  // DeepSeek returns prompt_cache_hit_tokens and prompt_cache_miss_tokens at usage top level,
  // but @ai-sdk/openai-compatible only reads prompt_tokens_details.cached_tokens.
  // The AI SDK preserves the original response as raw, so we check it as fallback.
  // 260705 Red: also extract prompt_cache_miss_tokens for correct cache write billing.
  const deepSeekCacheRead = item.raw?.prompt_cache_hit_tokens as number | undefined
  const deepSeekCacheWrite = item.raw?.prompt_cache_miss_tokens as number | undefined
  // 260714 Red: raw prompt_cache_hit_tokens can be cumulative KV-cache size, not per-request.
  // Only use it as lowest-priority fallback if it's reasonable (≤ inputTokens for one request).
  const maxCacheRead = item.inputTokens ?? Infinity
  const safeDeepSeekCacheRead = deepSeekCacheRead && deepSeekCacheRead <= maxCacheRead ? deepSeekCacheRead : undefined
  const safeDeepSeekCacheWrite =
    deepSeekCacheWrite && deepSeekCacheWrite <= maxCacheRead ? deepSeekCacheWrite : undefined
  const entries = Object.entries({
    inputTokens: item.inputTokens,
    outputTokens: item.outputTokens,
    totalTokens: item.totalTokens,
    reasoningTokens: item.outputTokenDetails?.reasoningTokens ?? item.reasoningTokens,
    cacheReadInputTokens: item.inputTokenDetails?.cacheReadTokens ?? item.cachedInputTokens ?? safeDeepSeekCacheRead,
    cacheWriteInputTokens: safeDeepSeekCacheWrite ?? item.inputTokenDetails?.cacheWriteTokens,
  }).filter((entry) => entry[1] !== undefined)
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

function currentTextID(state: ReturnType<typeof adapterState>, id: string | undefined) {
  state.currentTextID = id ?? state.currentTextID ?? `text-${state.text++}`
  return state.currentTextID
}

function currentReasoningID(state: ReturnType<typeof adapterState>, id: string | undefined) {
  state.currentReasoningID = id ?? state.currentReasoningID ?? `reasoning-${state.reasoning++}`
  return state.currentReasoningID
}

export function toLLMEvents(
  state: ReturnType<typeof adapterState>,
  event: AISDKEvent,
): Effect.Effect<ReadonlyArray<LLMEvent>, unknown> {
  switch (event.type) {
    case "start":
      return Effect.succeed([])

    case "start-step":
      return Effect.sync(() => {
        // 261014 Red 新 step 开始：上一 step 的终态追踪作废（估算守卫按当前 step 判定）。
        state.sawStepFinish = false
        state.terminalIncomplete = undefined
        return [LLMEvent.stepStart({ index: state.step })]
      })

    case "finish-step":
      return Effect.sync(() => {
        // 261014 Red 终态未完成检测（value-scoped）：rawFinishReason 只有 OpenAI
        // Responses 会发这两个字面量（chat=finish_reason、Anthropic=stop_reason、
        // Gemini 大写枚举，均不撞）。AI SDK 接缝拿不到「这是 Responses API」的标记，
        // 未知 reason 无法安全判定、交由 native 协议路径按事件类型精确识别；
        // `interrupted` 不入——官方语义可续接，保持 unknown finish 自然续跑。
        if (event.rawFinishReason === "max_output_tokens" || event.rawFinishReason === "content_filter")
          state.terminalIncomplete = event.rawFinishReason
        state.sawStepFinish = true
        return [
          LLMEvent.stepFinish({
            index: state.step++,
            reason: finishReason(event.finishReason),
            usage: usage(event.usage),
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "finish":
      return Effect.promise(async () => {
        await state.routedViaPromise
        const events: LLMEvent[] = [
          LLMEvent.finish({
            reason: finishReason(event.finishReason),
            usage: usage(event.totalUsage),
            providerMetadata: "providerMetadata" in event ? providerMetadata(event.providerMetadata) : undefined,
            routedVia: state.routedVia,
          }),
        ]
        // 261014 Red 终态未完成：finish（实报 usage 已记账、只此一次）之后补
        // provider-error，会话层以可见错误收尾而不是把截断当成功。
        if (state.terminalIncomplete)
          events.push(LLMEvent.providerError({ message: responsesIncompleteErrorMessage(state.terminalIncomplete) }))
        // Reset so the adapter can be reused for a follow-up stream without leaking
        // counters or block IDs. adapterState() is the single source of truth for shape.
        Object.assign(state, adapterState())
        return events
      })

    case "text-start":
      return Effect.sync(() => {
        state.currentTextID = currentTextID(state, event.id)
        return [
          LLMEvent.textStart({
            id: state.currentTextID,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "text-delta":
      return Effect.sync(() => {
        state.textBytes += byteLength(event.text)
        return [
          LLMEvent.textDelta({
            id: currentTextID(state, event.id),
            text: event.text,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "text-end":
      return Effect.sync(() => {
        const id = currentTextID(state, event.id)
        state.currentTextID = undefined
        return [
          LLMEvent.textEnd({
            id,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "reasoning-start":
      return Effect.sync(() => {
        state.currentReasoningID = currentReasoningID(state, event.id)
        return [
          LLMEvent.reasoningStart({
            id: state.currentReasoningID,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "reasoning-delta":
      return Effect.sync(() => {
        state.reasoningBytes += byteLength(event.text)
        return [
          LLMEvent.reasoningDelta({
            id: currentReasoningID(state, event.id),
            text: event.text,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "reasoning-end":
      return Effect.sync(() => {
        const id = currentReasoningID(state, event.id)
        state.currentReasoningID = undefined
        return [
          LLMEvent.reasoningEnd({
            id,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-input-start":
      return Effect.sync(() => {
        state.toolNames[event.id] = event.toolName
        return [
          LLMEvent.toolInputStart({
            id: event.id,
            name: event.toolName,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-input-delta":
      return Effect.succeed([
        LLMEvent.toolInputDelta({
          id: event.id,
          name: state.toolNames[event.id] ?? "unknown",
          text: event.delta ?? "",
        }),
      ])

    case "tool-input-end":
      return Effect.succeed([
        LLMEvent.toolInputEnd({
          id: event.id,
          name: state.toolNames[event.id] ?? "unknown",
          providerMetadata: providerMetadata(event.providerMetadata),
        }),
      ])

    case "tool-call":
      return Effect.sync(() => {
        state.toolNames[event.toolCallId] = event.toolName
        return [
          LLMEvent.toolCall({
            id: event.toolCallId,
            name: event.toolName,
            input: event.input,
            providerExecuted: "providerExecuted" in event ? event.providerExecuted : undefined,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-result":
      return Effect.sync(() => {
        const name = state.toolNames[event.toolCallId] ?? "unknown"
        delete state.toolNames[event.toolCallId]
        return [
          LLMEvent.toolResult({
            id: event.toolCallId,
            name,
            result: ToolResultValue.make(event.output),
            providerExecuted: "providerExecuted" in event ? event.providerExecuted : undefined,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "tool-error":
      return Effect.sync(() => {
        const name = state.toolNames[event.toolCallId] ?? ("toolName" in event ? event.toolName : "unknown")
        delete state.toolNames[event.toolCallId]
        return [
          LLMEvent.toolError({
            id: event.toolCallId,
            name,
            message: errorMessage(event.error),
            error: event.error,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        ]
      })

    case "error":
      return Effect.fail(event.error)

    case "abort":
    case "source":
    case "file":
    case "raw":
    case "tool-output-denied":
    case "tool-approval-request":
    // 260807 Red v7 新增分片：reasoning-file（模型产出的推理附件）/ tool-approval-response /
    // custom。本仓事件语言暂无对应载体，与 source/file 同策略忽略，不进 LLMEvent。
    case "reasoning-file":
    case "tool-approval-response":
    case "custom":
      return Effect.succeed([])

    default: {
      const _exhaustive: never = event
      void _exhaustive
      return Effect.succeed([])
    }
  }
}

export * as LLMAISDK from "./ai-sdk"
