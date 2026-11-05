/**
 * 缓存命中率唯一口径 —— `read / (read + miss + write)`。
 *
 * 三桶无条件求和，不做 either/or 选择：`tokens.cache.miss === tokens.input`
 * by construction（session.ts），miss 与 write 永不重复计量；任何「miss 非空就
 * 不要 write」的分支都会在某条路径漏桶。260707 现场就是漏桶把命中率抬到 99%、
 * 真实只有约 96%（DeepSeek cache-cap 回退会按 step 把 fresh token 时而记进
 * miss、时而记进 write）。
 *
 * 261105 收敛：此前 TUI prompt / 侧边栏 / 子代理页脚 / run 模式 / TUI 首页 /
 * GUI 上下文面板 / GUI 使用页各自复制了同一段公式（加两处单轮值、两处冻结
 * 判据），261028 对齐口径后又长出两处副本。现在只保留这一份：
 * - 调用方决定**数据范围**（已加载消息 / 会话行 / usage 聚合）；
 * - 调用方决定**空值语义**（`undefined` 还是 `null`、零命中算不算有数据）；
 * - 调用方决定**显示精度**（`digits`，0/1/2 位）。
 *
 * 行为边界：`read = 0` 但分母 > 0 时这里返回 0（确实是全未命中）。要把「没有
 * 缓存读入」显示成「—」的调用方，自己判 `read > 0`——那是展示策略，不是口径。
 */

export type CacheTokenBuckets = {
  /** 命中缓存的输入 token（消息侧 `tokens.cache.read`，会话行 `tokens_cache_read`）。 */
  read: number
  /**
   * 未命中（全价）输入 token。消息侧用 `tokens.cache.miss`；会话行与 usage 聚合
   * 没有 miss 列，`tokens.input` 就是那一项（session.ts 保证两者相等）。
   */
  miss: number
  /** 缓存写入 token（DeepSeek 恒 0，部分供应商非 0）。 */
  write: number
}

/** 0..1 命中率；分母为 0（没有任何输入）时返回 undefined。 */
export function cacheHitRate(buckets: CacheTokenBuckets): number | undefined {
  const denom = buckets.read + buckets.miss + buckets.write
  if (denom <= 0) return undefined
  return buckets.read / denom
}

/**
 * 百分数（0-100）。`digits` 是保留小数位：TUI 提示区 2 位、侧边栏/run/子代理
 * 1 位、首页整数、GUI 上下文面板 2 位——精度是各端展示选择，公式只有这一处。
 */
export function cacheHitPercent(buckets: CacheTokenBuckets, digits = 1): number | undefined {
  const rate = cacheHitRate(buckets)
  if (rate === undefined) return undefined
  const factor = 10 ** digits
  return Math.round(rate * 100 * factor) / factor
}

/**
 * 冻结判据的输入：逐轮 `read`（命中）与 `bad`（未命中 + 写入）。
 * 只保留有 usage 的轮次（`read + bad > 0`），由调用方过滤。
 */
export type CacheTurn = { read: number; bad: number }

/** 连续多少轮 `read` 完全不变才算冻结：1 轮可能只是采样抖动。 */
export const CACHE_STALL_TURNS = 2

/** 冻结轮次的最小未命中量：小请求每轮本来就没几个 token，不构成事故。 */
export const CACHE_STALL_MIN_MISS_TOKENS = 3_000

/**
 * 「前缀缓存被钉死」判据：最后 N+1 轮 `read` 纹丝不动，且本轮未命中超过阈值。
 *
 * 累计命中率对这件事几乎没有诊断力（全窗口平均，冻结几十轮才看得出）。08-04
 * 实测形态：vision 临时文件名带 Date.now()，每轮改写一条历史消息，`read` 连续
 * 几十轮停在 97k/110k/114k，`write` 每轮重付 55~84k。按这条扫历史数据，三次
 * 冻结全部命中、健康轮次零误报。
 */
export function cacheStalled(turns: readonly CacheTurn[]): boolean {
  const last = turns[turns.length - 1]
  if (!last || last.read <= 0) return false
  let flat = 0
  for (let i = turns.length - 2; i >= 0 && turns[i].read === last.read; i--) flat++
  return flat >= CACHE_STALL_TURNS && last.bad > CACHE_STALL_MIN_MISS_TOKENS
}
