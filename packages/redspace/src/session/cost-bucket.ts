// 币种费用桶原语（260930 Red，todo #5：审计 P2 修复的消费端口径统一）。
//
// 规则：任何展示面（stats / run / share / ACP）都不得把 CNY 与 USD 标量裸加后
// 伪装成单一币种（审计反例：69.21 CNY + 0.30 USD = 69.51 "USD"）。混合时并排
// 显示各币种分量，协议只收单一币种时（ACP usage_update）宁可省略 cost 也不谎报。
//
// 纯函数、零依赖：web（Astro/Cloudflare 构建）运行时 import 本文件不会拖进 Node 侧
// 依赖。undefined 币种一律按 USD 归桶，与会话投影器、迁移回填同界
// （docs/notes/implemented/bug-fix/2026-10-01-cost-currency-backfill-from-parts.md）。

export type CostCurrency = "USD" | "CNY"

export type CostBucket = {
  cny: number
  usd: number
}

export function emptyCostBucket(): CostBucket {
  return { cny: 0, usd: 0 }
}

// 原地累加。currency undefined → USD（与 projectors.ts 的投影边界一致）。
export function addCost(bucket: CostBucket, currency: CostCurrency | undefined, amount: number): void {
  if (currency === "CNY") {
    bucket.cny += amount
    return
  }

  bucket.usd += amount
}

// 非零分量，稳定序 USD 在前。全零返回空数组（调用方自行决定是否显示占位）。
export function costBucketParts(bucket: CostBucket): Array<{ currency: CostCurrency; amount: number }> {
  const parts: Array<{ currency: CostCurrency; amount: number }> = []
  if (bucket.usd !== 0) parts.push({ currency: "USD", amount: bucket.usd })
  if (bucket.cny !== 0) parts.push({ currency: "CNY", amount: bucket.cny })
  return parts
}

export function formatCost(bucket: CostBucket): string {
  const parts = costBucketParts(bucket)
  if (parts.length === 0) {
    return formatSingle("USD", 0)
  }

  // 混合币种并排展示，绝不求和——这是本模块存在的理由。
  return parts.map((part) => formatSingle(part.currency, part.amount)).join(" + ")
}

function formatSingle(currency: CostCurrency, amount: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount)
}

// 桶退化为单币种金额：恰好只有一个非零币种时返回 {amount, currency}，
// 否则（混合 / 全零）返回 undefined。给只收单一币种的协议（ACP usage_update）
// 做诚实降级用——拿不到单一币种就省略，不伪装总和。
export function singleCurrencyAmount(bucket: CostBucket): { amount: number; currency: CostCurrency } | undefined {
  const parts = costBucketParts(bucket)
  if (parts.length !== 1) return undefined
  return { amount: parts[0].amount, currency: parts[0].currency }
}
