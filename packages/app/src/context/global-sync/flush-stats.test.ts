import { describe, expect, test } from "bun:test"
import type { Event } from "@redcode-ai/sdk/v2/client"
import { createEventBatch, processBatch } from "./event-batch"
import { createFlushAggregator, type FlushAggregate, type FlushSample } from "./flush-stats"

// 261011 Red B0.1: 审计 ZW-01/08 回归——统计必须在 done() 前取真值（done 复用并清空
// 事件数组），高频批经 1s 窗口聚合且不丢慢批样本与低频证据。
const updated = (partID: string, text: string) =>
  ({
    type: "message.part.updated",
    properties: { part: { id: partID, messageID: "m1", sessionID: "s1", type: "text", text } },
  }) as unknown as Event

const delta = (partID: string, text: string) =>
  ({
    type: "message.part.delta",
    properties: { messageID: "m1", partID, field: "text", delta: text },
  }) as unknown as Event

const status = (sessionID: string) =>
  ({ type: "session.status", properties: { sessionID } }) as unknown as Event

describe("processBatch（B0.1 真值计数）", () => {
  test("纯 delta 批：received/emitted 真值；done() 清空数组不污染统计", () => {
    const batch = createEventBatch()
    batch.push("d", delta("p1", "B"))
    batch.push("d", delta("p1", "C"))
    const pulled = batch.pull()
    expect(pulled).toBeDefined()
    const moved: string[] = []
    const stats = processBatch(pulled!, (event) => moved.push(event.payload.type))
    batch.done() // 模拟 flush 尾部：数组复用在这里被清空
    expect(stats).toEqual({ received: 2, emitted: 2, superseded: 0, kinds: { "message.part.delta": 2 } })
    expect(moved).toEqual(["message.part.delta", "message.part.delta"])
    // 文档化：done 后 pulled.events 被复用清空——统计必须提前取（21d0f715 的教训）
    expect(pulled!.events.length).toBe(0)
  })

  test("快照覆盖旧 delta：superseded 计数，emitted 为过滤后真值", () => {
    const batch = createEventBatch()
    batch.push("d", delta("p1", "B"))
    batch.push("d", updated("p1", "AB"))
    batch.push("d", delta("p1", "C"))
    const pulled = batch.pull()!
    const moved: string[] = []
    const stats = processBatch(pulled, (event) => moved.push(event.payload.type))
    batch.done()
    expect(stats.received).toBe(3)
    expect(stats.superseded).toBe(1)
    expect(stats.emitted).toBe(2)
    expect(stats.kinds).toEqual({ "message.part.delta": 2, "message.part.updated": 1 })
    expect(moved).toEqual(["message.part.updated", "message.part.delta"])
  })

  test("无快照的状态事件照常计入（不能因无快照被判空批）", () => {
    const batch = createEventBatch()
    batch.push("d", status("s1"))
    const pulled = batch.pull()!
    const moved: string[] = []
    const stats = processBatch(pulled, (event) => moved.push(event.payload.type))
    batch.done()
    expect(stats).toEqual({ received: 1, emitted: 1, superseded: 0, kinds: { "session.status": 1 } })
    expect(moved).toEqual(["session.status"])
  })
})

describe("createFlushAggregator（1s 窗口 + 慢批留样）", () => {
  const makeHarness = () => {
    const aggs: FlushAggregate[] = []
    const slows: FlushSample[] = []
    const timers: Array<() => void> = []
    const agg = createFlushAggregator({
      emit: (a) => aggs.push(a),
      emitSlow: (s) => slows.push(s),
      schedule: (fn) => {
        timers.push(fn)
        return 0 // 返回假值（0）验证实现不依赖 schedule 返回值的真值性
      },
    })
    return { agg, aggs, slows, timers }
  }
  const sample = (over: Partial<FlushSample> = {}): FlushSample => ({
    received: 1,
    emitted: 1,
    superseded: 0,
    snapshots: 0,
    duration: 5,
    kinds: { "message.part.delta": 1 },
    ...over,
  })

  test("多批合并为一条窗口记录：求和 / 峰值 / kinds 折叠", () => {
    const h = makeHarness()
    h.agg.push(sample({ received: 2, emitted: 2, duration: 10, kinds: { "message.part.delta": 2 } }))
    h.agg.push(sample({ received: 3, emitted: 3, duration: 30, kinds: { "message.part.updated": 3 } }))
    expect(h.aggs).toHaveLength(0) // 未到窗口不落盘
    h.timers[0]() // 窗口到点
    expect(h.aggs).toHaveLength(1)
    expect(h.aggs[0]).toMatchObject({ batches: 2, received: 5, emitted: 5, superseded: 0, maxDuration: 30, slowBatches: 0 })
    expect(h.aggs[0].kinds).toEqual({ "message.part.delta": 2, "message.part.updated": 3 })
  })

  test("慢批（≥50ms）单独留样，同时计入窗口 slowBatches", () => {
    const h = makeHarness()
    h.agg.push(sample({ duration: 120 }))
    expect(h.slows).toHaveLength(1)
    expect(h.slows[0].duration).toBe(120)
    h.timers[0]()
    expect(h.aggs[0]).toMatchObject({ batches: 1, slowBatches: 1, maxDuration: 120 })
  })

  test("kinds 超过上限折叠为 other", () => {
    const h = makeHarness()
    const kinds: Record<string, number> = {}
    for (let i = 0; i < 8; i++) kinds[`t${i}`] = i + 1
    h.agg.push(sample({ kinds }))
    h.timers[0]()
    const k = h.aggs[0].kinds
    expect(Object.keys(k)).toHaveLength(7) // top 6 + other
    expect(k["t7"]).toBe(8)
    expect(k["t2"]).toBe(3)
    expect(k.other).toBe(3) // t1(2) + t0(1)
  })

  test("窗口落盘后新一批开启新窗口；连续 push 不重复 arm 定时器", () => {
    const h = makeHarness()
    h.agg.push(sample())
    h.agg.push(sample())
    expect(h.timers).toHaveLength(1) // 同一窗口只 arm 一次
    h.timers[0]()
    h.agg.push(sample())
    expect(h.aggs).toHaveLength(1)
    expect(h.timers).toHaveLength(2) // 新窗口重新 arm
    h.timers[1]()
    expect(h.aggs).toHaveLength(2)
    expect(h.aggs[1].batches).toBe(1)
  })

  test("flush() 手动落盘未满窗口；无数据时是 no-op", () => {
    const h = makeHarness()
    h.agg.flush()
    expect(h.aggs).toHaveLength(0)
    h.agg.push(sample())
    h.agg.flush()
    expect(h.aggs).toHaveLength(1)
    h.agg.flush()
    expect(h.aggs).toHaveLength(1) // 不重复落盘
  })

  test("9 批/秒场景：27 批压成 3 条窗口记录（每窗 9 批）", () => {
    const h = makeHarness()
    for (let w = 0; w < 3; w++) {
      for (let i = 0; i < 9; i++) h.agg.push(sample())
      h.timers[w]()
    }
    expect(h.aggs).toHaveLength(3)
    for (const agg of h.aggs) {
      expect(agg).toMatchObject({ batches: 9, received: 9, emitted: 9 })
    }
  })
})
