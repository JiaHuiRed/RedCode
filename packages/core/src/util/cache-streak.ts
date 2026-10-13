/**
 * 连续缓存未命中（cache-miss streak）检测 —— 「服务端缓存事故」的客户端判据。
 *
 * 261013 Red 事故回放（同会话 Sol 六连零命中、~512k 全价输入）得到的口径：单轮
 * read=0 无法区分「合法冷启动」（切模型/压缩后/会话首条，前缀本来就是新的）与
 * 「服务端事故」（前缀没变却整轮 miss、连缓存写入都没有）。冷启动边界那根 miss
 * 不计入 streak；边界之后连续第 2 轮零命中起，冷启动解释被排除，事故概率占优 ——
 * 这也是预警的物理下限：客户端要等响应回来才能看到 usage，第一根永远无法提前知道。
 *
 * 判据（对 assistant 消息按 time.created 顺序逐条处理）：
 * - `mode === "compaction"`（压缩摘要，与时间线同一判据）或 `modelID` 变化 → 计数清零并
 *   跳过该条：前缀重置，该轮 miss 是合法冷启动，不计入也不累计全价；
 * - `cache.read > 0` → 计数清零：缓存恢复正常，事故结束；
 * - `cache.read === 0` 且 `context > minContextTokens` → 计数 +1，累加全价输入；
 * - usage 缺失（read 未知）→ 跳过：既不计数也不清零（前缀在服务端照样延伸）。
 *
 * 连续 ≥ alertTurns（默认 2）轮时返回当前 streak（模型、轮数、累计全价 token），
 * 否则返回 undefined。纯函数：TUI（`usePromptUsage`）与 GUI（`session-context-usage`）
 * 各自从消息列表驱动，口径只有这一份。
 */

export type CacheStreakMessage = {
  role?: string
  modelID?: string
  /** 压缩摘要消息：与时间线同一判据（`mode === "compaction"`），作为前缀重置边界。 */
  mode?: string
  time?: { created?: number }
  tokens?: { context?: number; cache?: { read?: number } }
}

export type CacheMissStreak = {
  modelID: string
  streak: number
  fullPriceTokens: number
}

/** 低于该 context 的零命中不计数：小请求的冷启动代价可忽略；usage 缺失的消息 context 为 0，天然被排除。 */
export const CACHE_STREAK_MIN_CONTEXT_TOKENS = 20_000

/** 边界之后连续多少轮零命中算事故：1 轮仍可能是冷启动余波，≥2 轮才排除冷启动解释。 */
export const CACHE_STREAK_ALERT_TURNS = 2

export function cacheMissStreak(
  messages: readonly CacheStreakMessage[],
  options?: { minContextTokens?: number; alertTurns?: number },
): CacheMissStreak | undefined {
  const minContext = options?.minContextTokens ?? CACHE_STREAK_MIN_CONTEXT_TOKENS
  const alertTurns = options?.alertTurns ?? CACHE_STREAK_ALERT_TURNS
  const ordered = [...messages].sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
  let modelID: string | undefined
  let streak = 0
  let fullPrice = 0
  for (const message of ordered) {
    if (message.role !== "assistant") continue
    if (message.mode === "compaction" || message.modelID !== modelID) {
      streak = 0
      fullPrice = 0
      modelID = message.modelID
      continue
    }
    const read = message.tokens?.cache?.read
    if (read === undefined) continue
    if (read > 0) {
      streak = 0
      fullPrice = 0
      continue
    }
    const context = message.tokens?.context ?? 0
    if (context > minContext) {
      streak++
      fullPrice += context
    }
  }
  if (modelID === undefined || streak < alertTurns) return undefined
  return { modelID, streak, fullPriceTokens: fullPrice }
}
