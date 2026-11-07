// 261107 Red 性能探针：把 ≥50ms 的 span 以 JSONL 追加到 ~/.redcode/data/trace/spans.jsonl。
// 用途：定位 GUI 卡顿闸门（261107 现场：13s 请求簇、56s dispose）——Effect.fn 全家自带
// span，导出器一挂，dispose/load/git 全族的单次耗时自动现身，无需逐处插桩。
// 启用：REDCODE_TRACE_SPANS=1，或放一个标记文件 ~/.redcode/data/trace/enabled（GUI exe
// 双击启动带不了 env，标记文件是给它的开关；诊断完删掉即关，需重启生效）。
// 不做轮转——诊断产物按会话量级增长，整目录可随时删除；写失败静默丢样本（探针绝不拖垮主流程）。
import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { Context } from "@opentelemetry/api"
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base"
import { Flag } from "../flag/flag"
import { Global } from "../global"

const TRACE_DIR = join(Global.Path.data, "trace")
const TRACE_FILE = join(TRACE_DIR, "spans.jsonl")
const ENABLED_MARKER = join(TRACE_DIR, "enabled")
const MIN_DURATION_MS = 50

export function traceFileEnabled(): boolean {
  if (Flag.REDCODE_TRACE_SPANS) return true
  try {
    return existsSync(ENABLED_MARKER)
  } catch {
    return false
  }
}

export function traceFilePath(): string {
  return TRACE_FILE
}

export function createFileSpanProcessor(): SpanProcessor {
  try {
    mkdirSync(TRACE_DIR, { recursive: true })
  } catch {
    // 目录建不出来（磁盘/权限）：后续 onEnd 的 appendFileSync 也会失败并被吞，
    // 探针退化为无操作，不值得为它提前终止启动。
  }
  return {
    onStart(_span: Span, _parentContext: Context): void {},
    onEnd(span: ReadableSpan): void {
      const durationMs = span.duration[0] * 1000 + span.duration[1] / 1e6
      if (durationMs < MIN_DURATION_MS) return
      const line = JSON.stringify({
        at: Date.now(),
        name: span.name,
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        parent: span.parentSpanContext?.spanId,
        durationMs: Math.round(durationMs * 100) / 100,
        status: span.status.code,
        attributes: span.attributes,
      })
      try {
        appendFileSync(TRACE_FILE, line + "\n")
      } catch {
        // 同上：写失败丢样本，探针自身零影响
      }
    },
    forceFlush(): Promise<void> {
      return Promise.resolve()
    },
    shutdown(): Promise<void> {
      return Promise.resolve()
    },
  }
}
