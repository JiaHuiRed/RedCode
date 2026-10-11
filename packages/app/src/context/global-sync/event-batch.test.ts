import { describe, expect, test } from "bun:test"
import type { Event } from "@redcode-ai/sdk/v2/client"
import { createEventBatch, isSupersededDelta, type QueuedEvent } from "./event-batch"

// 261011 Red B1-b: 审计文档 §3.2 的合并矩阵。payload 用最小字段构造，只覆盖
// 文本 Part 的快照/增量语义。
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

// 测试侧的事件应用模型：快照整段替换、delta 追加（与 event-reducer 对 text 字段一致）。
const applyAll = (events: QueuedEvent[]) => {
  let text = ""
  for (const event of events) {
    if (event.payload.type === "message.part.updated") {
      const part = event.payload.properties.part
      if (part.type === "text") text = part.text
    }
    if (event.payload.type === "message.part.delta") text += event.payload.properties.delta
  }
  return text
}

const drain = (batch: ReturnType<typeof createEventBatch>) => {
  const pulled = batch.pull()
  if (!pulled) return [] as QueuedEvent[]
  const emitted = pulled.events.filter((event) => !isSupersededDelta(event, pulled.snapshots))
  batch.done()
  return emitted
}

describe("createEventBatch", () => {
  test("updated(A), delta(B) => AB", () => {
    const batch = createEventBatch()
    batch.push("d", updated("p1", "A"))
    batch.push("d", delta("p1", "B"))
    expect(applyAll(drain(batch))).toBe("AB")
  })

  test("updated(A), updated(AB) => AB（同批快照只发最新一份）", () => {
    const batch = createEventBatch()
    batch.push("d", updated("p1", "A"))
    batch.push("d", updated("p1", "AB"))
    const emitted = drain(batch)
    expect(emitted).toHaveLength(1)
    expect(applyAll(emitted)).toBe("AB")
  })

  test("updated(A), delta(B), updated(ABC) => ABC，不重复 B", () => {
    const batch = createEventBatch()
    batch.push("d", updated("p1", "A"))
    batch.push("d", delta("p1", "B"))
    batch.push("d", updated("p1", "ABC"))
    expect(applyAll(drain(batch))).toBe("ABC")
  })

  test("updated(A), updated(AB), delta(C) => ABC，不丢 C", () => {
    const batch = createEventBatch()
    batch.push("d", updated("p1", "A"))
    batch.push("d", updated("p1", "AB"))
    batch.push("d", delta("p1", "C"))
    expect(applyAll(drain(batch))).toBe("ABC")
  })

  test("updated(A), delta(B), updated(AB), delta(C) => ABC，只跳过被快照覆盖的 B", () => {
    const batch = createEventBatch()
    batch.push("d", updated("p1", "A"))
    batch.push("d", delta("p1", "B"))
    batch.push("d", updated("p1", "AB"))
    batch.push("d", delta("p1", "C"))
    expect(applyAll(drain(batch))).toBe("ABC")
  })

  test("delta(B), updated(AB), delta(C) => ABC", () => {
    const batch = createEventBatch()
    batch.push("d", delta("p1", "B"))
    batch.push("d", updated("p1", "AB"))
    batch.push("d", delta("p1", "C"))
    expect(applyAll(drain(batch))).toBe("ABC")
  })

  test("part-X 与 part-Y 交错时各自独立", () => {
    const batch = createEventBatch()
    batch.push("d", updated("x", "X1"))
    batch.push("d", updated("y", "Y1"))
    batch.push("d", updated("x", "X2"))
    batch.push("d", delta("y", "Y2"))
    const emitted = drain(batch)
    const texts: Record<string, string> = {}
    for (const event of emitted) {
      if (event.payload.type === "message.part.updated") {
        const part = event.payload.properties.part
        if (part.type === "text") texts[part.id] = part.text
      }
      if (event.payload.type === "message.part.delta") {
        const props = event.payload.properties
        texts[props.partID] = (texts[props.partID] ?? "") + props.delta
      }
    }
    expect(texts).toEqual({ x: "X2", y: "Y1Y2" })
  })

  test("跨 flush 边界不丢不重", () => {
    const batch = createEventBatch()
    batch.push("d", updated("p1", "A"))
    batch.push("d", delta("p1", "B"))
    const first = drain(batch)
    batch.push("d", delta("p1", "C"))
    batch.push("d", updated("p1", "ABC"))
    const second = drain(batch)
    expect(applyAll([...first, ...second])).toBe("ABC")
  })
})
