import { describe, expect, test } from "bun:test"
import { createSpanMemo } from "../../src/session/summary"

// 260904 cc A1 第 2 步：summarize 用 (from,to) 指纹跳过重算。这里只测 memo 本身的三条语义——
// 精确匹配才命中、有界 LRU、显式失效——hit/miss 在 summarize 里的接线是直线代码，靠 typecheck 与阅读守。

describe("createSpanMemo", () => {
  test("hits only when both from and to match exactly", () => {
    const memo = createSpanMemo<string, { from: string; to: string; n: number }>(4)
    memo.set("s1", { from: "a", to: "b", n: 1 })

    expect(memo.hit("s1", { from: "a", to: "b" })?.n).toBe(1)
    expect(memo.hit("s1", { from: "a", to: "c" })).toBeUndefined()
    expect(memo.hit("s1", { from: "x", to: "b" })).toBeUndefined()
    expect(memo.hit("s2", { from: "a", to: "b" })).toBeUndefined()
  })

  test("set on an existing key replaces the entry", () => {
    const memo = createSpanMemo<string, { from: string; to: string; n: number }>(4)
    memo.set("s1", { from: "a", to: "b", n: 1 })
    memo.set("s1", { from: "a", to: "c", n: 2 })

    expect(memo.size).toBe(1)
    expect(memo.hit("s1", { from: "a", to: "b" })).toBeUndefined()
    expect(memo.hit("s1", { from: "a", to: "c" })?.n).toBe(2)
  })

  test("evicts the least recently used entry beyond the limit", () => {
    const memo = createSpanMemo<string, { from: string; to: string }>(2)
    memo.set("s1", { from: "a", to: "a" })
    memo.set("s2", { from: "b", to: "b" })
    // 命中 s1 会刷新它的 LRU 位置，接下来该被挤出去的是 s2
    expect(memo.hit("s1", { from: "a", to: "a" })).toBeDefined()
    memo.set("s3", { from: "c", to: "c" })

    expect(memo.size).toBe(2)
    expect(memo.hit("s2", { from: "b", to: "b" })).toBeUndefined()
    expect(memo.hit("s1", { from: "a", to: "a" })).toBeDefined()
    expect(memo.hit("s3", { from: "c", to: "c" })).toBeDefined()
  })

  test("delete makes the next lookup miss", () => {
    const memo = createSpanMemo<string, { from: string; to: string }>(4)
    memo.set("s1", { from: "a", to: "b" })
    memo.delete("s1")

    expect(memo.hit("s1", { from: "a", to: "b" })).toBeUndefined()
    expect(memo.size).toBe(0)
  })
})
