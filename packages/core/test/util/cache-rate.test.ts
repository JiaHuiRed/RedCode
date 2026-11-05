import { describe, expect, test } from "bun:test"
import { cacheHitPercent, cacheHitRate, cacheStalled, CACHE_STALL_MIN_MISS_TOKENS } from "@redcode-ai/core/util/cache-rate"

describe("cacheHitRate", () => {
  // 260707 现场：混桶会话里 either/or 会丢掉 write 桶，把 96% 抬成 97.96%。
  test("三桶无条件求和：write 与 miss 都要进分母", () => {
    expect(cacheHitRate({ read: 960, miss: 20, write: 20 })).toBeCloseTo(0.96, 6)
  })

  test("零命中但确有输入时返回 0，不是 undefined", () => {
    expect(cacheHitRate({ read: 0, miss: 1000, write: 0 })).toBe(0)
  })

  test("完全没有输入时返回 undefined", () => {
    expect(cacheHitRate({ read: 0, miss: 0, write: 0 })).toBeUndefined()
  })

  test("read 有值但分母恒等 read 时是 100%", () => {
    expect(cacheHitRate({ read: 500, miss: 0, write: 0 })).toBe(1)
  })
})

describe("cacheHitPercent", () => {
  test("digits 决定保留位数，公式不变", () => {
    const buckets = { read: 2, miss: 1, write: 0 }
    expect(cacheHitPercent(buckets, 0)).toBe(67)
    expect(cacheHitPercent(buckets, 1)).toBe(66.7)
    expect(cacheHitPercent(buckets, 2)).toBe(66.67)
  })

  test("无输入同样是 undefined", () => {
    expect(cacheHitPercent({ read: 0, miss: 0, write: 0 }, 2)).toBeUndefined()
  })
})

describe("cacheStalled", () => {
  const turn = (read: number, bad: number) => ({ read, bad })

  test("连续三轮 read 不变且本轮未命中超阈值 → 冻结", () => {
    expect(cacheStalled([turn(97_000, 60_000), turn(97_000, 60_000), turn(97_000, 60_000)])).toBe(true)
  })

  test("read 每轮增长（缓存正常延伸）→ 不判冻结", () => {
    expect(cacheStalled([turn(97_000, 60_000), turn(100_000, 20_000), turn(104_000, 20_000)])).toBe(false)
  })

  test("read 不变但本轮未命中低于阈值 → 不判冻结", () => {
    expect(
      cacheStalled([turn(97_000, 1_000), turn(97_000, 1_000), turn(97_000, CACHE_STALL_MIN_MISS_TOKENS)]),
    ).toBe(false)
  })

  test("只有两轮相同（未达 CACHE_STALL_TURNS+1）→ 不判冻结", () => {
    expect(cacheStalled([turn(97_000, 60_000), turn(97_000, 60_000)])).toBe(false)
  })

  test("零命中轮次不进入冻结判据（冷启动不是事故）", () => {
    expect(cacheStalled([turn(0, 60_000), turn(0, 60_000), turn(0, 60_000)])).toBe(false)
  })

  test("空序列 → 不判冻结", () => {
    expect(cacheStalled([])).toBe(false)
  })
})
