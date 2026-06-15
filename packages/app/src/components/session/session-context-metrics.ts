import type { AssistantMessage, Message } from "@redcode-ai/sdk/v2/client"

type Provider = {
  id: string
  name?: string
  models: Record<string, Model | undefined>
}

type Model = {
  name?: string
  limit: {
    context: number
  }
}

type Context = {
  message: AssistantMessage
  provider?: Provider
  model?: Model
  providerLabel: string
  modelLabel: string
  limit: number | undefined
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cacheHit: number | null
  total: number
  usage: number | null
}

type Metrics = {
  totalCost: number
  // 260615 Red: "CNY" when session uses DeepSeek/Xiaomi (official RMB pricing), "USD" otherwise
  costCurrency: "USD" | "CNY"
  context: Context | undefined
}

const tokenTotal = (msg: AssistantMessage) => {
  return msg.tokens.input + msg.tokens.output + msg.tokens.reasoning + msg.tokens.cache.read + msg.tokens.cache.write
}

const lastAssistantWithTokens = (messages: Message[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== "assistant") continue
    if (tokenTotal(msg) <= 0) continue
    return msg
  }
}

// 260615 Red: providers with official CNY pricing — cost values are already in ¥, no USD→CNY conversion needed
const CNY_PROVIDERS = new Set(["deepseek", "xiaomi"])

const build = (messages: Message[] = [], providers: Provider[] = []): Metrics => {
  const totalCost = messages.reduce((sum, msg) => sum + (msg.role === "assistant" ? msg.cost : 0), 0)
  const message = lastAssistantWithTokens(messages)
  if (!message) return { totalCost, costCurrency: "USD", context: undefined }

  const provider = providers.find((item) => item.id === message.providerID)
  const model = provider?.models[message.modelID]
  const limit = model?.limit.context

  // Aggregate across all assistant messages (not just the last one)
  const agg = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  for (const m of messages) {
    if (m.role !== "assistant") continue
    agg.input += m.tokens.input ?? 0
    agg.output += m.tokens.output ?? 0
    agg.reasoning += m.tokens.reasoning ?? 0
    agg.cacheRead += m.tokens.cache.read ?? 0
    agg.cacheWrite += m.tokens.cache.write ?? 0
  }
  const total = agg.input + agg.output + agg.reasoning + agg.cacheRead + agg.cacheWrite

  return {
    totalCost,
    costCurrency: CNY_PROVIDERS.has(message.providerID) ? "CNY" as const : "USD" as const,
    context: {
      message,
      provider,
      model,
      providerLabel: provider?.name ?? message.providerID,
      modelLabel: model?.name ?? message.modelID,
      limit,
      input: agg.input,
      output: agg.output,
      reasoning: agg.reasoning,
      cacheRead: agg.cacheRead,
      cacheWrite: agg.cacheWrite,
      // 260612 Red session-aggregate cache rate (not last-turn-only which is always ~99%)
      // 260613 fix: denominator should only be cache-relevant tokens (read+write), not including fresh input
      // 260615 fix: fallback to input for providers that don't return write/cache-miss metadata
      cacheHit: (() => {
        let sumRead = 0, sumWrite = 0, sumInput = 0
        for (const m of messages) {
          if (m.role === "assistant") {
            sumRead += m.tokens.cache.read
            sumWrite += m.tokens.cache.write
            sumInput += m.tokens.input
          }
        }
        const denom = sumRead + (sumWrite || sumInput)
        return denom > 0 && sumRead > 0 ? Math.round((sumRead / denom) * 1000) / 10 : null
      })(),
      total,
      usage: limit ? Math.round((total / limit) * 100) : null,
    },
  }
}

export function getSessionContextMetrics(messages: Message[] = [], providers: Provider[] = []) {
  return build(messages, providers)
}
