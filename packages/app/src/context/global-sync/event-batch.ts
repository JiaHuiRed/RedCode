import type { Event } from "@redcode-ai/sdk/v2/client"

// 261011 Red B1-b: SSE 合并窗口的纯函数模型（审计 GUI-02）。从 global-sdk.tsx
// 抽出便于事件回放测试；delta 与快照的先后按**到达序**比较——旧实现把「同批出现过
// 快照的 Part」的所有 delta 整批跳过，连最后一次快照之后到达的增量也一起吃掉
// （updated(A), updated(AB), delta(C) 会丢成 AB）。
export type QueuedEvent = { directory: string; payload: Event; at: number }

const deltaKey = (directory: string, messageID: string, partID: string) => `${directory}:${messageID}:${partID}`

export function createEventBatch() {
  let active: QueuedEvent[] = []
  let spare: QueuedEvent[] = []
  let arrival = 0
  const coalesced = new Map<string, number>()
  // 每个 Part 最近一次完整快照的到达序；只有到达时刻早于它的 delta 才视为被快照覆盖。
  const snapshotAt = new Map<string, number>()

  const key = (directory: string, payload: Event) => {
    if (payload.type === "session.status") return `session.status:${directory}:${payload.properties.sessionID}`
    if (payload.type === "lsp.updated") return `lsp.updated:${directory}`
    if (payload.type === "message.part.updated") {
      const part = payload.properties.part
      return `message.part.updated:${directory}:${part.messageID}:${part.id}`
    }
  }

  const push = (directory: string, payload: Event) => {
    const k = key(directory, payload)
    const at = arrival++
    if (k) {
      const i = coalesced.get(k)
      if (i !== undefined) {
        active[i] = { directory, payload, at }
        if (payload.type === "message.part.updated") {
          const part = payload.properties.part
          snapshotAt.set(deltaKey(directory, part.messageID, part.id), at)
        }
        return
      }
      coalesced.set(k, active.length)
    }
    if (payload.type === "message.part.updated") {
      const part = payload.properties.part
      snapshotAt.set(deltaKey(directory, part.messageID, part.id), at)
    }
    active.push({ directory, payload, at })
  }

  const pull = () => {
    if (active.length === 0) return
    const events = active
    const snapshots = snapshotAt.size > 0 ? new Map(snapshotAt) : undefined
    active = spare
    spare = events
    active.length = 0
    coalesced.clear()
    snapshotAt.clear()
    return { events, snapshots }
  }

  const done = () => {
    spare.length = 0
  }

  return { push, pull, done }
}

export const isSupersededDelta = (event: QueuedEvent, snapshots: Map<string, number> | undefined) => {
  if (!snapshots || event.payload.type !== "message.part.delta") return false
  const props = event.payload.properties
  const at = snapshots.get(deltaKey(event.directory, props.messageID, props.partID))
  return at !== undefined && event.at < at
}

export type BatchStats = { received: number; emitted: number; superseded: number; kinds: Record<string, number> }

// 261011 Red B0.1: 转发 + 真值统计（审计 ZW-01）。必须在 done() 之前调用——done 复用并
// 清空 pulled.events 指向的同一数组对象（spare 双缓冲），事后读 length 恒为 0（21d0f715 的教训）。
export const processBatch = (
  pulled: { events: QueuedEvent[]; snapshots: Map<string, number> | undefined },
  emit: (event: QueuedEvent) => void,
): BatchStats => {
  const received = pulled.events.length
  const kinds: Record<string, number> = {}
  let emitted = 0
  let superseded = 0
  for (const event of pulled.events) {
    kinds[event.payload.type] = (kinds[event.payload.type] ?? 0) + 1
    if (isSupersededDelta(event, pulled.snapshots)) {
      superseded++
      continue
    }
    emit(event)
    emitted++
  }
  return { received, emitted, superseded, kinds }
}
