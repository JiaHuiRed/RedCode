import { describe, expect, test } from "bun:test"
import { cacheMissStreak, CACHE_STREAK_MIN_CONTEXT_TOKENS } from "@redcode-ai/core/util/cache-streak"

let seq = 0
function assistant(input: {
  modelID?: string
  mode?: string
  context?: number
  read?: number
  created?: number
}) {
  seq += 1
  return {
    role: "assistant",
    modelID: input.modelID,
    mode: input.mode,
    time: { created: input.created ?? seq },
    tokens: {
      ...(input.context === undefined ? {} : { context: input.context }),
      cache: { ...(input.read === undefined ? {} : { read: input.read }) },
    },
  }
}

const user = () => {
  seq += 1
  return { role: "user", time: { created: seq } }
}

describe("cacheMissStreak", () => {
  test("会话首条零命中是合法冷启动，不计入 streak", () => {
    seq = 0
    expect(cacheMissStreak([user(), assistant({ modelID: "m", context: 40_000, read: 0 })])).toBeUndefined()
  })

  test("边界后连续两轮零命中 → 事故（Sol 回放：冷启动不计，其后两轮报警）", () => {
    seq = 0
    const streak = cacheMissStreak([
      user(),
      // 18:07 首条：冷启动，不计
      assistant({ modelID: "m", context: 42_000, read: 0 }),
      assistant({ modelID: "m", context: 55_000, read: 0 }),
      assistant({ modelID: "m", context: 69_000, read: 0 }),
    ])
    expect(streak).toEqual({ modelID: "m", streak: 2, fullPriceTokens: 124_000 })
  })

  test("六连零命中的完整事故：轮数与全价累计持续增长", () => {
    seq = 0
    const streak = cacheMissStreak([
      user(),
      assistant({ modelID: "m", context: 42_000, read: 0 }),
      assistant({ modelID: "m", context: 55_000, read: 0 }),
      assistant({ modelID: "m", context: 69_000, read: 0 }),
      assistant({ modelID: "m", context: 88_000, read: 0 }),
      assistant({ modelID: "m", context: 126_000, read: 0 }),
      assistant({ modelID: "m", context: 131_000, read: 0 }),
    ])
    expect(streak).toEqual({ modelID: "m", streak: 5, fullPriceTokens: 469_000 })
  })

  test("中间夹一轮命中 → 事故结束", () => {
    seq = 0
    const streak = cacheMissStreak([
      user(),
      assistant({ modelID: "m", context: 40_000, read: 0 }),
      assistant({ modelID: "m", context: 45_000, read: 0 }),
      assistant({ modelID: "m", context: 50_000, read: 49_000 }),
      assistant({ modelID: "m", context: 55_000, read: 0 }),
    ])
    expect(streak).toBeUndefined()
  })

  test("切模型重置：新模型的前缀冷启动不计旧账，其后两轮才报警", () => {
    seq = 0
    const streak = cacheMissStreak([
      user(),
      assistant({ modelID: "old", context: 40_000, read: 0 }),
      assistant({ modelID: "old", context: 45_000, read: 0 }),
      // 切模型：新前缀第一根 miss 合法（不计），其后两轮才报警
      assistant({ modelID: "new", context: 198_000, read: 0 }),
      assistant({ modelID: "new", context: 202_000, read: 0 }),
      assistant({ modelID: "new", context: 210_000, read: 0 }),
    ])
    expect(streak).toEqual({ modelID: "new", streak: 2, fullPriceTokens: 412_000 })
  })

  test("压缩摘要重置：摘要本身不计，其后两轮才报警", () => {
    seq = 0
    const streak = cacheMissStreak([
      user(),
      assistant({ modelID: "m", context: 40_000, read: 0 }),
      assistant({ modelID: "m", context: 45_000, read: 0 }),
      // 压缩摘要（它自己的请求通常也是零命中，但不计）
      assistant({ modelID: "m", mode: "compaction", context: 9_000, read: 0 }),
      assistant({ modelID: "m", context: 185_000, read: 0 }),
      assistant({ modelID: "m", context: 202_000, read: 0 }),
    ])
    expect(streak).toEqual({ modelID: "m", streak: 2, fullPriceTokens: 387_000 })
  })

  test("usage 缺失的消息跳过：既不计数也不清零", () => {
    seq = 0
    const streak = cacheMissStreak([
      user(),
      assistant({ modelID: "m", context: 40_000, read: 0 }),
      // output-only-estimated：context/read 都没有
      assistant({ modelID: "m" }),
      assistant({ modelID: "m", context: 55_000, read: 0 }),
      assistant({ modelID: "m", context: 69_000, read: 0 }),
    ])
    expect(streak).toEqual({ modelID: "m", streak: 2, fullPriceTokens: 124_000 })
  })

  test("小 context 零命中不计数", () => {
    seq = 0
    const streak = cacheMissStreak([
      user(),
      assistant({ modelID: "m", context: CACHE_STREAK_MIN_CONTEXT_TOKENS - 1, read: 0 }),
      assistant({ modelID: "m", context: CACHE_STREAK_MIN_CONTEXT_TOKENS - 1, read: 0 }),
      assistant({ modelID: "m", context: CACHE_STREAK_MIN_CONTEXT_TOKENS - 1, read: 0 }),
    ])
    expect(streak).toBeUndefined()
  })

  test("输入乱序时按 time.created 排序后判定", () => {
    seq = 0
    const streak = cacheMissStreak([
      assistant({ modelID: "m", context: 55_000, read: 0, created: 2 }),
      assistant({ modelID: "m", context: 40_000, read: 0, created: 3 }),
      user(),
      assistant({ modelID: "m", context: 45_000, read: 0, created: 4 }),
    ])
    // 排序后：55k 是首条（冷启动不计），40k → 1，45k → 2
    expect(streak).toEqual({ modelID: "m", streak: 2, fullPriceTokens: 85_000 })
  })
})
