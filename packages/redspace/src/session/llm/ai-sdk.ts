import { FinishReason, LLMEvent, ProviderMetadata, ToolResultValue } from "@redcode-ai/llm"
import { responsesIncompleteErrorMessage } from "@redcode-ai/llm/protocols/openai-responses"
import { Effect, Schema } from "effect"
import { type streamText } from "ai"
import { errorMessage } from "@/util/error"
import { ThinkTagScanner } from "./think-split"
// 261020 Red 参数解析失败的 tool call 不执行：llm.ts 的 repair 钩子把它改投这个哨兵工具名，
// 让 AI SDK 停在 NoSuchToolError，而不是拿残参数去真跑工具。原生消息只回
// 「unavailable tool 'invalid'」并把**整张可用工具表**塞回上下文——原工具名和真正原因全丢，
// 模型无从修改（261020 mimo 因此连发 6 次同样的残废参数，每次都撞同一个无解报错）。
// 适配层把哨兵调用翻译成一句话：原工具名 + 截断后的原因 + 该怎么重发。
export const INVALID_TOOL_CALL = "invalid"
const MAX_UNPARSED_REASON = 300
const unparsedCalls = new Map<string, { tool: string; reason: string }>()

export function noteUnparsedToolCall(id: string, tool: string, reason: string) {
  // 只留最近 32 条未消费的记录：tool-error 缺席时不能无限攒。
  const oldest = unparsedCalls.keys().next()
  if (unparsedCalls.size >= 32 && !oldest.done) unparsedCalls.delete(oldest.value)
  unparsedCalls.set(id, { tool, reason })
}

export function unparsedToolCallMessage(tool: string, reason: string) {
  const text = reason.replace(/\s+/g, " ").trim()
  const clipped = text.length > MAX_UNPARSED_REASON ? `${text.slice(0, MAX_UNPARSED_REASON)}…` : text
  const detail = clipped ? ` Reason: ${clipped}` : ""
  return `Tool call to \`${tool}\` was NOT executed: its arguments could not be parsed (usually truncated or malformed JSON).${detail} Re-send \`${tool}\` with complete JSON arguments.`
}

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
    // 261024 Red 内联 <think> 拆分器（step-5-preview 实测：推理以 <think>…</think> 内联在
    // content 通道输出，协议层只认 reasoning_content，漏进正文）。text-delta 逐段喂它；
    // thinkPartID 是拆分器自己开的推理块 id——与原生 reasoning-* 事件（reasoning_content
    // 通道）各自独立，两者不会同时开启。
    think: new ThinkTagScanner(),
    thinkPartID: undefined as string | undefined,
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
        const events: LLMEvent[] = []
        // 261024 Red think 状态不跨 step：上一 step 未收口的内联推理块在此收口，
        // 拆分器复位（各 step 是独立补全，<think> 开闭不会跨 step 配对）。
        if (state.thinkPartID !== undefined) {
          events.push(LLMEvent.reasoningEnd({ id: state.thinkPartID }))
          state.thinkPartID = undefined
        }
        state.think = new ThinkTagScanner()
        events.push(LLMEvent.stepStart({ index: state.step }))
        return events
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
        const events: LLMEvent[] = []
        // 261024 Red 流结束先收尾 think 拆分器：悬挂尾窗按状态放行，未闭合的内联
        // 推理块在 finish 上补 reasoningEnd——TUI/GUI 的思考块不能悬着不收口。
        const split = state.think.flush()
        if (split.reasoning) {
          if (state.thinkPartID === undefined) {
            state.thinkPartID = currentReasoningID(state, undefined)
            events.push(LLMEvent.reasoningStart({ id: state.thinkPartID }))
          }
          events.push(LLMEvent.reasoningDelta({ id: state.thinkPartID, text: split.reasoning }))
        }
        if (state.thinkPartID !== undefined) {
          events.push(LLMEvent.reasoningEnd({ id: state.thinkPartID }))
          state.thinkPartID = undefined
        }
        if (split.text) {
          // 正常流里 finish 前必有 text-end（已 flush 过），这里只剩 currentTextID
          // 未定义的残尾形态——独立小 part 呈现，避免丢字。
          const id = state.currentTextID ?? currentTextID(state, undefined)
          if (state.currentTextID === undefined) events.push(LLMEvent.textStart({ id }))
          events.push(LLMEvent.textDelta({ id, text: split.text }))
          if (state.currentTextID === undefined) events.push(LLMEvent.textEnd({ id }))
        }
        events.push(
          LLMEvent.finish({
            reason: finishReason(event.finishReason),
            usage: usage(event.totalUsage),
            providerMetadata: "providerMetadata" in event ? providerMetadata(event.providerMetadata) : undefined,
            routedVia: state.routedVia,
          }),
        )
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
        const events: LLMEvent[] = []
        // 261024 Red content 通道过 think 拆分器：内联 <think> 段落转为推理事件。
        const split = state.think.feed(event.text)
        if (split.reasoning) {
          if (state.thinkPartID === undefined) {
            state.thinkPartID = currentReasoningID(state, undefined)
            events.push(LLMEvent.reasoningStart({ id: state.thinkPartID }))
          }
          state.reasoningBytes += byteLength(split.reasoning)
          events.push(LLMEvent.reasoningDelta({ id: state.thinkPartID, text: split.reasoning }))
        }
        if (split.text) {
          if (state.thinkPartID !== undefined) {
            events.push(LLMEvent.reasoningEnd({ id: state.thinkPartID }))
            state.thinkPartID = undefined
          }
          state.textBytes += byteLength(split.text)
          events.push(
            LLMEvent.textDelta({
              id: currentTextID(state, event.id),
              text: split.text,
              providerMetadata: providerMetadata(event.providerMetadata),
            }),
          )
        }
        return events
      })

    case "text-end":
      return Effect.sync(() => {
        const id = currentTextID(state, event.id)
        const events: LLMEvent[] = []
        // 261024 Red part 收尾先放行拆分器悬挂尾窗（文本进当前 part；推理挂到
        // think 块上——跨 part 的内联思考合法，块保持开启等后续 part 或 finish 收口）。
        const split = state.think.flush()
        if (split.reasoning) {
          if (state.thinkPartID === undefined) {
            state.thinkPartID = currentReasoningID(state, undefined)
            events.push(LLMEvent.reasoningStart({ id: state.thinkPartID }))
          }
          state.reasoningBytes += byteLength(split.reasoning)
          events.push(LLMEvent.reasoningDelta({ id: state.thinkPartID, text: split.reasoning }))
        } else if (split.text) {
          if (state.thinkPartID !== undefined) {
            events.push(LLMEvent.reasoningEnd({ id: state.thinkPartID }))
            state.thinkPartID = undefined
          }
          state.textBytes += byteLength(split.text)
          events.push(LLMEvent.textDelta({ id, text: split.text }))
        }
        state.currentTextID = undefined
        events.push(
          LLMEvent.textEnd({
            id,
            providerMetadata: providerMetadata(event.providerMetadata),
          }),
        )
        return events
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
        // 261020 Red 哨兵调用（repair 钩子登记的未解析参数）换成可操作错误；原工具名优先取
        // tool-input-start 记下的名字（repair 不覆盖它），其余错误保持原样。
        const unparsed = unparsedCalls.get(event.toolCallId)
        unparsedCalls.delete(event.toolCallId)
        const name =
          state.toolNames[event.toolCallId] ?? unparsed?.tool ?? ("toolName" in event ? event.toolName : "unknown")
        delete state.toolNames[event.toolCallId]
        return [
          LLMEvent.toolError({
            id: event.toolCallId,
            name,
            message: unparsed
              ? unparsedToolCallMessage(unparsed.tool, unparsed.reason || errorMessage(event.error))
              : errorMessage(event.error),
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
