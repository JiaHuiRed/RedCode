import type { ServerHealth } from "./server-health"

/**
 * 261024 Red 启动健康闸门的轮询循环，从 ConnectionGate 的 Effect.gen 里抽出成可测函数。
 *
 * 语义（对齐原实现 + 补上原实现缺的轮询节奏）：
 * - healthy → 放行；
 * - 直连 http 或闸门已切 background → 立即判负（sidecar 需要宽限轮询，直连不用）；
 * - 其余每轮之间隔 intervalMs 再试——原先 while(true) 没有任何间隔，healthy:false 被
 *   server-health 的 750ms 结果缓存原样回喂时，这层会以微任务速度空转；
 * - 预算用尽判负，且**单轮探测也受总预算约束**：每轮把剩余预算作为该轮请求超时传给
 *   check（checkServerHealth 原生支持 timeoutMs）。否则首个悬挂请求会以它自己的 30s
 *   默认超时把「10s 预算」拖成 30s（261024 复审补严）。
 */
export async function awaitStartupHealth(options: {
  check: (opts?: { timeoutMs?: number }) => Promise<ServerHealth>
  /** 直连 http 判负即止；sidecar/ssh 需要宽限轮询（对齐原实现：非 http 一律宽限）。 */
  connectionType: "http" | "sidecar" | "ssh"
  /** blocking 期间外部把闸门切到 background 时，立刻停止阻塞判定。 */
  shouldBackground: () => boolean
  /** 轮询间隔，默认 500ms。 */
  intervalMs?: number
  /** 总预算，默认 10s（与原 Effect.timeoutOrElse 一致）。 */
  timeoutMs?: number
  /** 可注入的时钟/休眠，测试用；生产走 Date.now 与 setTimeout。 */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<boolean> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const intervalMs = options.intervalMs ?? 500
  const deadline = now() + (options.timeoutMs ?? 10_000)

  for (;;) {
    const remaining = deadline - now()
    if (remaining <= 0) return false
    const result = await options.check({ timeoutMs: remaining })
    if (result.healthy) return true
    if (options.connectionType === "http" || options.shouldBackground()) return false
    if (now() + intervalMs > deadline) return false
    await sleep(intervalMs)
  }
}
