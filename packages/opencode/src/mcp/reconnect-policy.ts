// 261104 Red 重连退避：原实现每次工具调用失败都直接重连，配置错的 server（命令不存在、端口不通）
// 会被反复 spawn / 超时，且没有任何上限。策略对齐 deepseek-harness 的 mcp-client：
// 500ms 起指数翻倍、上限 30s、最多 10 次；连接成功满 30s（稳定期）才重置预算，
// 避免「连上就断」的 flapping 每次都从头计数。
export const MAX_ATTEMPTS = 10
export const BASE_MS = 500
export const MAX_DELAY_MS = 30_000
export const STABLE_MS = 30_000

export interface Budget {
  failures: number
  nextAt: number
  connectedAt?: number
}

export type Decision =
  | { type: "connect"; attempt: number }
  | { type: "wait"; waitMs: number }
  | { type: "exhausted" }

export function decide(input: { budget: Budget | undefined; now: number }): Decision {
  const budget = input.budget
  if (!budget) return { type: "connect", attempt: 1 }
  if (budget.connectedAt !== undefined && input.now - budget.connectedAt >= STABLE_MS)
    return { type: "connect", attempt: 1 }
  if (budget.failures >= MAX_ATTEMPTS) return { type: "exhausted" }
  if (input.now < budget.nextAt) return { type: "wait", waitMs: budget.nextAt - input.now }
  return { type: "connect", attempt: budget.failures + 1 }
}

export function delayFor(failures: number): number {
  return Math.min(BASE_MS * 2 ** Math.max(0, failures - 1), MAX_DELAY_MS)
}

// 261104 Red 连接成功只记录时间，不清零失败次数：5 秒后再次断开的 flapping 若每次成功
// 都从 0 开始，MAX_ATTEMPTS 永远触发不了。真正的重置由 decide() 在稳定期过后完成。
export function onConnected(budget: Budget | undefined, now: number): Budget {
  return { failures: budget?.failures ?? 0, nextAt: 0, connectedAt: now }
}

export * as McpReconnectPolicy from "./reconnect-policy"
