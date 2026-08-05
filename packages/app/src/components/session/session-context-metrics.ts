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
  // 260805 Red 单次交互命中率 + 缓存冻结判据（对齐 TUI 4d596f3 状态栏实现）
  turnHitPct: number | null
  stalled: boolean
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
// 260701 Red exported for reuse by home-stats.tsx (cross-session cost aggregation)
//
// 260730 Karina 这份名单的权威来源是 provider.ts 的 CNY_PRICING —— 那边加了 provider
// 这里不同步就会把人民币金额当美元再乘一次 6.76。实测漏的就是 `stepfun-step-plan`
// （0.8.1 刚给它补了人民币定价）：库里 ¥7.50 被显示成 ¥50.73。
// TUI 侧（feature-plugins/home/footer.tsx）已改成直接读 `model.cost.currency`，不再维护名单；
// 这里暂时保留名单是因为 home-stats.tsx 只拿得到 session、拿不到 provider 的 model 报价。
// **CNY_PRICING 增删条目时必须同步改这里。**
export const CNY_PROVIDERS = new Set([
  "deepseek",
  "xiaomi",
  "stepfun",
  "stepfun-step-plan",
  "zhipuai",
  "opencode-go",
  "openox", // 260731 Karina openox 报价是人民币（见 provider.ts CNY_PRICING）
])

const build = (messages: Message[] = [], providers: Provider[] = []): Metrics => {
  const totalCost = messages.reduce((sum, msg) => sum + (msg.role === "assistant" ? msg.cost : 0), 0)
  const message = lastAssistantWithTokens(messages)
  if (!message) return { totalCost, costCurrency: "USD", context: undefined }

  const provider = providers.find((item) => item.id === message.providerID)
  const model = provider?.models[message.modelID]
  const limit = model?.limit.context

  // Aggregate across all assistant messages (not just the last one)
  const agg = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  // 260805 Red 逐轮 read/bad 序列，供 turnHitPct 与 stalled 判据使用
  const turns: Array<{ read: number; bad: number }> = []
  for (const m of messages) {
    if (m.role !== "assistant") continue
    agg.input += m.tokens.input ?? 0
    agg.output += m.tokens.output ?? 0
    agg.reasoning += m.tokens.reasoning ?? 0
    agg.cacheRead += m.tokens.cache.read ?? 0
    agg.cacheWrite += m.tokens.cache.write ?? 0
    const read = m.tokens.cache.read ?? 0
    const bad = (m.tokens.cache.miss ?? 0) + (m.tokens.cache.write ?? 0)
    if (read + bad > 0) turns.push({ read, bad })
  }
  const total = agg.input + agg.output + agg.reasoning + agg.cacheRead + agg.cacheWrite
  const lastTurn = turns[turns.length - 1]

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
      // 260707 Red fix: session.ts's DeepSeek cache-cap fallback can route the real miss/fresh
      // tokens into cache.write instead of cache.miss depending on which raw metadata field the
      // SDK response populated for a given step. miss and write never double-count the same tokens
      // (tokens.cache.miss === tokens.input by construction in session.ts), so summing read+miss+write
      // gives the true total instead of an either/or pick that silently drops whichever bucket the
      // buggy path skipped — this was inflating hit% (e.g. 99% vs the real ~96%).
      cacheHit: (() => {
        let sumRead = 0, sumMiss = 0, sumWrite = 0
        for (const m of messages) {
          if (m.role === "assistant") {
            sumRead += m.tokens.cache.read
            sumMiss += m.tokens.cache.miss ?? 0
            sumWrite += m.tokens.cache.write
          }
        }
        const denom = sumRead + sumMiss + sumWrite
        return denom > 0 && sumRead > 0 ? Math.round((sumRead / denom) * 10000) / 100 : null
      })(),
      // 260805 Red 单次交互（最近一轮请求）命中率 + 缓存冻结判据，对齐 TUI 4d596f3。
      // 累计值对"缓存卡住"几乎没有诊断力（全窗口平均，冻结几十轮才看得出）；真正的判据
      // 是**本轮 read 有没有在长**——正常每轮递增，卡住时纹丝不动而 write/miss 每轮重付。
      // stalled：连续 3 轮 read 完全不变且本轮未命中 > 3k = 前缀缓存被钉死。
      turnHitPct: lastTurn ? Math.round((lastTurn.read / (lastTurn.read + lastTurn.bad)) * 10000) / 100 : null,
      stalled: (() => {
        if (!lastTurn || lastTurn.read <= 0) return false
        let flat = 0
        for (let i = turns.length - 2; i >= 0 && turns[i].read === lastTurn.read; i--) flat++
        return flat >= 2 && lastTurn.bad > 3000
      })(),
      total,
      usage: limit ? Math.round((total / limit) * 100) : null,
    },
  }
}

export function getSessionContextMetrics(messages: Message[] = [], providers: Provider[] = []) {
  return build(messages, providers)
}
