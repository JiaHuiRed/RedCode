import type { ServerHealth } from "./server-health"

/**
 * 261024 Red 启动健康闸门的轮询循环，从 ConnectionGate 的 Effect.gen 里抽出成可测函数。
 *
 * 语义（对齐原实现 + 补上原实现缺的轮询节奏）：
 * - healthy → 放行；
 * - 直连 http 或闸门已切 background → 立即判负（sidecar 需要宽限轮询，直连不用）；
 * - 其余每轮之间隔 intervalMs 再试——原先 while(true) 没有任何间隔，healthy:false 被
 *   server-health 的 750ms 结果缓存原样回喂时，这层会以微任务速度空转；
 * - 预算用尽判负。硬上限有轻微放宽：预算卡的是「下一轮起跑」，单次探测自身的
 *   30s AbortSignal 超时仍是尾部边界（原先 Effect.timeoutOrElse 会硬中断整条 fiber）。
 */
export async function awaitStartupHealth(options: {
  check: () => Promise<ServerHealth>
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
    const result = await options.check()
    if (result.healthy) return true
    if (options.connectionType === "http" || options.shouldBackground()) return false
    if (now() + intervalMs > deadline) return false
    await sleep(intervalMs)
  }
}
