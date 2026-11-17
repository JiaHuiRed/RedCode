import { describe, expect, test } from "bun:test"
import { addCost, costBucketParts, emptyCostBucket, formatCost, singleCurrencyAmount } from "@/session/cost-bucket"

describe("addCost", () => {
  test("undefined 币种按 USD 归桶（与投影器同界）", () => {
    const bucket = emptyCostBucket()
    addCost(bucket, undefined, 1.5)
    expect(bucket).toEqual({ cny: 0, usd: 1.5 })
  })

  test("CNY 进 cny 桶", () => {
    const bucket = emptyCostBucket()
    addCost(bucket, "CNY", 69.21)
    expect(bucket).toEqual({ cny: 69.21, usd: 0 })
  })

  test("混合累加互不污染", () => {
    const bucket = emptyCostBucket()
    addCost(bucket, "CNY", 69.21)
    addCost(bucket, "USD", 0.3)
    addCost(bucket, undefined, 0.01)
    expect(bucket).toEqual({ cny: 69.21, usd: 0.31 })
  })
})

describe("costBucketParts", () => {
  test("全零返回空数组", () => {
    expect(costBucketParts({ cny: 0, usd: 0 })).toEqual([])
  })

  test("稳定序 USD 在前", () => {
    const parts = costBucketParts({ cny: 2, usd: 1 })
    expect(parts.map((p) => p.currency)).toEqual(["USD", "CNY"])
  })
})

describe("formatCost", () => {
  test("全零显示 $0.00", () => {
    expect(formatCost({ cny: 0, usd: 0 })).toBe("$0.00")
  })

  test("纯 USD 单行", () => {
    expect(formatCost({ cny: 0, usd: 12.5 })).toBe("$12.50")
  })

  test("纯 CNY 显示人民币符号（en-US 下 Intl 输出 CN¥ 前缀）", () => {
    expect(formatCost({ cny: 69.21, usd: 0 })).toBe("CN¥69.21")
  })

  test("混合并排不求和——审计反例 69.21CNY+0.30USD 不得变成 69.51USD", () => {
    const text = formatCost({ cny: 69.21, usd: 0.3 })
    expect(text).not.toBe("$69.51")
    expect(text).toBe("$0.30 + CN¥69.21")
  })
})

describe("singleCurrencyAmount", () => {
  test("单一 USD 退化成功", () => {
    expect(singleCurrencyAmount({ cny: 0, usd: 3 })).toEqual({ amount: 3, currency: "USD" })
  })

  test("单一 CNY 退化成功", () => {
    expect(singleCurrencyAmount({ cny: 3, usd: 0 })).toEqual({ amount: 3, currency: "CNY" })
  })

  test("混合拒绝伪装单币种", () => {
    expect(singleCurrencyAmount({ cny: 69.21, usd: 0.3 })).toBeUndefined()
  })

  test("全零不给金额（ACP 省略 cost）", () => {
    expect(singleCurrencyAmount({ cny: 0, usd: 0 })).toBeUndefined()
  })
})
