// 261107 Red 性能探针：把 ≥50ms 的 span 以 JSONL 追加到 ~/.redcode/data/trace/spans.jsonl。
// 用途：定位 GUI 卡顿闸门（261107 现场：13s 请求簇、56s dispose）——Effect.fn 全家自带
// span，导出器一挂，dispose/load/git 全族的单次耗时自动现身，无需逐处插桩。
// 启用：REDCODE_TRACE_SPANS=1，或放一个标记文件 ~/.redcode/data/trace/enabled（GUI exe
// 双击启动带不了 env，标记文件是给它的开关；诊断完删掉即关，需重启生效）。
//
// 261107 Red 评审修正（RC-03）：①onEnd 热路径只进内存缓冲，批量落盘（1s 或满 20 条），
// 不再每 span 同步写盘——探针自己给要测的执行线程加磁盘延迟是最讽刺的污染源；shutdown/
// forceFlush 同步清空兜底。②文件 8MiB 封顶，写满即停采集并落一行 trace.capped 标记——
// 长会话 span 持续增长，探针不能变成无界写手。③属性过脱敏：键名疑似凭据直接丢弃，
// URL 值剥查询串——对齐 gui-diagnostics §11.2 的本地诊断文件隐私纪律。
// 不做轮转（写满即停比轮转简单且够用）；诊断产物整目录可随时删除。
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Context } from "@opentelemetry/api"
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base"
import { Flag } from "../flag/flag"
import { Global } from "../global"

const TRACE_DIR = join(Global.Path.data, "trace")
const TRACE_FILE = join(TRACE_DIR, "spans.jsonl")
const ENABLED_MARKER = join(TRACE_DIR, "enabled")
const MIN_DURATION_MS = 50
const MAX_FILE_BYTES = 8 * 1024 * 1024
const FLUSH_INTERVAL_MS = 1_000
const FLUSH_THRESHOLD_LINES = 20
const SENSITIVE_KEY = /key|token|auth|password|secret|credential/i

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

// 凭据最常藏在 URL 查询串（token=...）；剥掉查询串、留个痕迹说明原本有。
function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    if (/^https?:\/\//.test(value) && value.includes("?")) return `${value.slice(0, value.indexOf("?"))}?…`
    return value
  }
  if (Array.isArray(value)) return value.map(sanitizeValue)
  return value
}

function sanitizeAttributes(attributes: ReadableSpan["attributes"]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(attributes)) {
    if (SENSITIVE_KEY.test(key)) continue
    out[key] = sanitizeValue(value)
  }
  return out
}

export function createFileSpanProcessor(): SpanProcessor {
  try {
    mkdirSync(TRACE_DIR, { recursive: true })
  } catch {
    // 目录建不出来（磁盘/权限）：后续写入也会失败并被吞，探针退化为无操作，
    // 不值得为它提前终止启动。
  }
  let bytesWritten = (() => {
    try {
      return existsSync(TRACE_FILE) ? statSync(TRACE_FILE).size : 0
    } catch {
      return 0
    }
  })()
  let capped = false
  let buffer: string[] = []
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (capped || buffer.length === 0) return
    const lines = buffer.splice(0)
    const payload = lines.join("\n") + "\n"
    try {
      appendFileSync(TRACE_FILE, payload)
      bytesWritten += Buffer.byteLength(payload)
    } catch {
      // 写失败丢整批样本：探针绝不拖垮主流程
    }
  }

  const scheduleFlush = () => {
    if (timer !== undefined) return
    // unref：探针的定时器绝不阻止进程退出
    timer = setTimeout(flush, FLUSH_INTERVAL_MS)
    timer.unref?.()
  }

  return {
    onStart(_span: Span, _parentContext: Context): void {},
    onEnd(span: ReadableSpan): void {
      if (capped) return
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
        attributes: sanitizeAttributes(span.attributes),
      })
      if (bytesWritten + Buffer.byteLength(line) + 1 > MAX_FILE_BYTES) {
        capped = true
        try {
          appendFileSync(TRACE_FILE, JSON.stringify({ at: Date.now(), name: "trace.capped" }) + "\n")
        } catch {
          // 同上
        }
        return
      }
      buffer.push(line)
      if (buffer.length >= FLUSH_THRESHOLD_LINES) flush()
      else scheduleFlush()
    },
    forceFlush(): Promise<void> {
      flush()
      return Promise.resolve()
    },
    shutdown(): Promise<void> {
      flush()
      return Promise.resolve()
    },
  }
}
