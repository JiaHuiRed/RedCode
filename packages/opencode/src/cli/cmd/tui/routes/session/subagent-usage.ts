import type { Message } from "@redcode-ai/sdk/v2"

/**
 * 261028 Red 子代理页脚的用量行：总 token + cache 命中率。
 *
 * 总 token 优先读服务端会话行聚合（projector 随 step-finish 增量维护）——页脚手里的
 * messages 只是分页已加载子集，长子代理下能比真实累计少一个数量级（与侧边栏
 * sessionUsage 同口径，那边 261011 踩过：1.8 千万 vs 1.3 亿）。聚合缺失（旧行）时
 * 退回已加载消息累计。
 *
 * cache 命中率口径与主会话三处显示逐字对齐——read / (read + miss + write)，三桶
 * 无条件求和：
 *   260612 Red session-aggregate（不是只算最后一轮，那恒等于 ~99%）；
 *   260707 Red fix：session.ts 的 DeepSeek cache-cap 回退（260705）会按该 step 恰好
 *   填充哪个 raw metadata 字段，把真实 fresh token 时而记进 miss、时而记进 write；
 *   两桶永不重复计量（tokens.cache.miss === tokens.input by construction），求和才是
 *   真总量。
 * 子代理页脚此前停在 260614 的 either/or 链（miss || write || input），混桶会话下
 * 只要有过 miss 就把 write 整桶丢掉——正是 260707 在主会话侧修掉的 inflated hit
 * （实测 99% vs 真实 ~96%），子代理这一侧一直没跟上。对齐以主会话为准：它的 hit
 * 与官方开放平台对得上，作为准确口径。
 *
 * 总 token 与 cache 解绑：没有 cache 的供应商（read 恒 0）也要看得到用量——
 * 旧实现在 sumRead <= 0 时把整行吞掉，那类子代理此前一个数字都看不到。
 */
export function subagentUsage(
  messages: ReadonlyArray<Message>,
  aggregate?: { tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } },
) {
  let sumRead = 0,
    sumMiss = 0,
    sumWrite = 0,
    sumTotal = 0
  for (const m of messages) {
    if (m.role !== "assistant") continue
    sumRead += m.tokens.cache.read
    sumMiss += m.tokens.cache.miss ?? 0
    sumWrite += m.tokens.cache.write
    sumTotal += m.tokens.input + m.tokens.output + m.tokens.reasoning + m.tokens.cache.read + m.tokens.cache.write
  }
  const total = aggregate?.tokens
    ? aggregate.tokens.input +
      aggregate.tokens.output +
      aggregate.tokens.reasoning +
      aggregate.tokens.cache.read +
      aggregate.tokens.cache.write
    : sumTotal
  if (total <= 0) return
  const cacheDenom = sumRead + sumMiss + sumWrite
  const parts: string[] = []
  if (sumRead > 0) parts.push(`Cache: ${Math.round((sumRead / cacheDenom) * 1000) / 10}%`)
  parts.push(`Total ${total.toLocaleString()}`)
  return { label: parts.join(" · ") }
}
