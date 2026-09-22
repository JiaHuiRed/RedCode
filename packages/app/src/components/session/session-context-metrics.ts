import type { AssistantMessage, CompactionPart, Message, Part } from "@redcode-ai/sdk/v2/client"

type Provider = {
  id: string
  name?: string
  models: Record<string, Model | undefined>
}

type Model = {
  name?: string
  cost?: {
    currency?: "USD" | "CNY"
  }
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

// 260923 Red 单趟遍历：原实现 totalCost / lastAssistantWithTokens / agg / lastAssistantWithSpeed /
// cacheHit 各扫一遍，长会话一次 metrics 重算要付 5 趟 O(N)，而流式期间每批 SSE 都会触发重算。
// 合并成一趟；「取最后一条满足条件的」两个语义用正序覆盖（后者覆盖前者）保持等价。
const build = (messages: Message[] = [], providers: Provider[] = []): Metrics => {
  let totalCost = 0
  let tokenMessage: AssistantMessage | undefined
  let speedMessage: AssistantMessage | undefined
  // Aggregate across all assistant messages (not just the last one)
  const agg = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  // 260805 Red 逐轮 read/bad 序列，供 turnHitPct 与 stalled 判据使用
  const turns: Array<{ read: number; bad: number }> = []
  let sumRead = 0
  let sumMiss = 0
  let sumWrite = 0
  for (const m of messages) {
    if (m.role !== "assistant") continue
    totalCost += m.cost
    if (tokenTotal(m) > 0) tokenMessage = m
    if (m.time.firstChunk && m.time.completed && m.tokens.output + m.tokens.reasoning > 0) speedMessage = m
    agg.input += m.tokens.input ?? 0
    agg.output += m.tokens.output ?? 0
    agg.reasoning += m.tokens.reasoning ?? 0
    agg.cacheRead += m.tokens.cache.read ?? 0
    agg.cacheWrite += m.tokens.cache.write ?? 0
    const read = m.tokens.cache.read ?? 0
    const bad = (m.tokens.cache.miss ?? 0) + (m.tokens.cache.write ?? 0)
    if (read + bad > 0) turns.push({ read, bad })
    sumRead += m.tokens.cache.read
    sumMiss += m.tokens.cache.miss ?? 0
    sumWrite += m.tokens.cache.write
  }
  const message = tokenMessage
  if (!message) return { totalCost, costCurrency: "USD", context: undefined }

  const provider = providers.find((item) => item.id === message.providerID)
  const model = provider?.models[message.modelID]
  const limit = model?.limit.context
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
  const decoded = speedMessage ? speedMessage.tokens.output + speedMessage.tokens.reasoning : 0
  const decodeMs = speedMessage ? speedMessage.time.completed! - speedMessage.time.firstChunk! : 0
  const decodeRate = decodeMs > 0 && decoded > 0 ? Math.round((decoded / decodeMs) * 1000 * 10) / 10 : null
  const firstChunkMs = speedMessage ? speedMessage.time.firstChunk! - speedMessage.time.created : null

  return {
    totalCost,
    // 260827 Red 币种读 model.cost.currency（无标记按 USD 折算，USD_TO_CNY 见上）
    costCurrency: (model?.cost?.currency ?? "USD") === "CNY" ? ("CNY" as const) : ("USD" as const),
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
      // 260923 Red read/miss/write 已随主循环一趟累计，这里只做归一
      cacheHit: (() => {
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

/**
 * 最近一次压缩的那个 part。
 *
 * 260822 cc 抽成纯函数只为一件事：倒序扫描很容易写成正序，而写反之后界面上仍然会显示
 * 一组"看着挺像"的数字（会话第一次压缩，而不是最近一次），没人看得出来。测试钉住它。
 * 一次压缩写一个 CompactionPart（compaction.ts:714-726 回填 tokens_before/after），
 * 所以要的是"最后一条消息里的最后一个"，两层都得倒着走。
 */
export function findLastCompaction(
  messages: Message[],
  getParts: (messageID: string) => Part[],
): CompactionPart | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message) continue
    const parts = getParts(message.id)
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]
      if (part?.type === "compaction") return part
    }
  }
}
