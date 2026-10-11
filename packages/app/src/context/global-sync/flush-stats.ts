import type { BatchStats } from "./event-batch"

// 261011 Red B0.1: sse.flush 高频聚合（审计 ZW-01/08 修订）。真机约 9 批/秒，逐批落盘
// 会挤爆环形缓冲且信息量低；窗口内求和并保留峰值与类型直方图，慢批单独留样。
export const FLUSH_WINDOW_MS = 1000
export const FLUSH_SLOW_MS = 50
export const MAX_KINDS = 6

export type FlushSample = BatchStats & {
  duration: number
  snapshots: number
}

export type FlushAggregate = {
  windowMs: number
  batches: number
  received: number
  emitted: number
  superseded: number
  snapshots: number
  maxDuration: number
  slowBatches: number
  kinds: Record<string, number>
}

const foldKinds = (target: Record<string, number>, add: Record<string, number>) => {
  for (const [kind, count] of Object.entries(add)) target[kind] = (target[kind] ?? 0) + count
}

// kinds 直方图硬上限：top MAX_KINDS + other（detail 尺寸有界，ZW-08 精神）
const capKinds = (kinds: Record<string, number>) => {
  const entries = Object.entries(kinds).sort((a, b) => b[1] - a[1])
  if (entries.length <= MAX_KINDS) return kinds
  const capped: Record<string, number> = {}
  let other = 0
  for (let i = 0; i < entries.length; i++) {
    if (i < MAX_KINDS) capped[entries[i][0]] = entries[i][1]
    else other += entries[i][1]
  }
  if (other > 0) capped.other = other
  return capped
}

export function createFlushAggregator(opts: {
  emit: (aggregate: FlushAggregate) => void
  emitSlow?: (sample: FlushSample) => void
  windowMs?: number
  slowMs?: number
  schedule?: (fn: () => void, ms: number) => unknown
}) {
  const windowMs = opts.windowMs ?? FLUSH_WINDOW_MS
  const slowMs = opts.slowMs ?? FLUSH_SLOW_MS
  const schedule = opts.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  let pending: FlushAggregate | undefined
  let timer: unknown

  const flushWindow = () => {
    if (!pending) return
    const aggregate = pending
    pending = undefined
    aggregate.kinds = capKinds(aggregate.kinds)
    opts.emit(aggregate)
  }

  const push = (sample: FlushSample) => {
    if (opts.emitSlow && sample.duration >= slowMs) opts.emitSlow(sample)
    if (!pending) {
      pending = {
        windowMs,
        batches: 0,
        received: 0,
        emitted: 0,
        superseded: 0,
        snapshots: 0,
        maxDuration: 0,
        slowBatches: 0,
        kinds: {},
      }
    }
    pending.batches++
    pending.received += sample.received
    pending.emitted += sample.emitted
    pending.superseded += sample.superseded
    pending.snapshots += sample.snapshots
    if (sample.duration > pending.maxDuration) pending.maxDuration = sample.duration
    if (sample.duration >= slowMs) pending.slowBatches++
    foldKinds(pending.kinds, sample.kinds)
    if (timer === undefined) {
      timer = schedule(() => {
        timer = undefined
        flushWindow()
      }, windowMs)
    }
  }

  return { push, flush: flushWindow }
}
