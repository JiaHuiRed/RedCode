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
  /** 会话累计消耗（所有 assistant 消息之和），不是上下文大小 */
  total: number
  /** 这一刻真实占用的上下文（最后一条 assistant 的 tokens.context），历史消息无此字段时 undefined */
  window: number | undefined
  /** 上下文窗口占用率 = window / limit。窗口数缺失时为 null */
  usage: number | null
  /** 引擎判定的压缩档位（服务端算好随消息发来）。历史消息无此字段时 undefined */
  level: AssistantMessage["contextLevel"]
  /**
   * 最近一轮**已完成**回合的解码速率（tok/s）。口径与 TUI 侧边栏一致
   * （cli/cmd/tui/feature-plugins/sidebar/context.tsx:184-197），两处必须一样，
   * 否则同一个会话在两个界面上给出不同的速度。数据不足时 null。
   */
  decodeRate: number | null
  /** 最近一轮**已完成**回合的首字延迟（ms，created→firstChunk）。数据不足时 null */
  firstChunkMs: number | null
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

// 260822 cc 速度指标取「最近一条**跑完且真的吐过字**的 assistant」，与上面那条
// lastAssistantWithTokens 刻意分开：正在流式的那条 time.completed 还没写，纯工具往返的
// 那条 output+reasoning 是 0 —— 两种都算不出速率。分开取的效果是流式期间稳定显示上一轮
// 的数字，而不是闪成空白。
const lastAssistantWithSpeed = (messages: Message[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role !== "assistant") continue
    if (!msg.time.firstChunk || !msg.time.completed) continue
    if (msg.tokens.output + msg.tokens.reasoning <= 0) continue
    return msg
  }
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
  const window = message.tokens.context
  const lastTurn = turns[turns.length - 1]

  // 260822 cc 解码速率 / 首字延迟。两个陷阱，照搬 TUI 的口径（sidebar/context.tsx:184-197）：
  //   ① 分子必须是 output + reasoning —— session.ts:460 把 output 定义成
  //      outputTokens - reasoningTokens，只用 output 会漏掉思考的字，对 DeepSeek
  //      这类长思考模型能把速率低估到一半以下。
  //   ② 分母必须从 firstChunk 起算，不能用 created —— created→firstChunk 那段是排队与
  //      预填，长上下文下能把 60 tok/s 稀释成 20，量出来的就不是解码速度而是排队时间。
  // 两段分开显示也是刻意的：首字慢 = 排队/预填（供应商负载、上下文长度），
  // 解码慢 = 吐字本身，混成一个「总速度」会让两种完全不同的问题看起来一样。
  const speedMessage = lastAssistantWithSpeed(messages)
  const decoded = speedMessage ? speedMessage.tokens.output + speedMessage.tokens.reasoning : 0
  const decodeMs = speedMessage ? speedMessage.time.completed! - speedMessage.time.firstChunk! : 0
  const decodeRate = decodeMs > 0 && decoded > 0 ? Math.round((decoded / decodeMs) * 1000 * 10) / 10 : null
  const firstChunkMs = speedMessage ? speedMessage.time.firstChunk! - speedMessage.time.created : null

  return {
    totalCost,
    costCurrency: CNY_PROVIDERS.has(message.providerID) ? ("CNY" as const) : ("USD" as const),
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
        let sumRead = 0,
          sumMiss = 0,
          sumWrite = 0
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
      // 260819 cc 口径修复：usage 原来是 total / limit，而 total 是**整个会话累计**
      // （注释里 'Aggregate across all assistant messages' 写得很明白）。长会话累计动辄是窗口的
      // 十几倍，ProgressCircle 内部又钳到 [0,100]，于是那个圈从会话超过一个窗口起就永远是满的、
      // 再没变过；tooltip 里那个 1500% 也正是用户一直误以为是「上下文窗口」的数。
      // 改用 tokens.context（最后一条 assistant 那一刻的提示词总量，processor 里覆盖不累加）。
      // 历史消息没有这个字段 → window/usage 都是空，UI 侧不显示，等下一轮请求写入。
      window,
      level: message.contextLevel,
      usage: window !== undefined && limit ? Math.round((window / limit) * 100) : null,
      decodeRate,
      firstChunkMs,
    },
  }
}

export function getSessionContextMetrics(messages: Message[] = [], providers: Provider[] = []) {
  return build(messages, providers)
}
