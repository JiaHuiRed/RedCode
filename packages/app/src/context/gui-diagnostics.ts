// 261011 Red B0（GUI 稳定性审计 §11）：低成本取证链路的核心模块。
//
// 设计约束：
// - **默认关闭**：关闭时 `record()` 只是一次布尔判断，不分配、不计时；录制由用户显式开启。
// - **有界**：环形缓冲同时受 maxRecords 与 maxBytes 约束，超限丢弃最旧的记录并计数，
//   诊断自己不能变成内存泄漏。
// - **只读**：不改变任何同步/渲染行为；停止录制即完全退出。
// - **隐私（§11.2）**：严禁记录提示词/回复/工具参数/密钥/凭据/完整路径；会话与目录一律
//   匿名 key（hashId/anonKey，含每录制随机 salt），一切字符串过 `maskText` 统一 scrub。
//   detail 值约定：数字/布尔/枚举名/匿名 key；自由文本仅限错误消息（确有必要）。
//   已知形态（盘符直反斜杠、任意根 POSIX、UNC、query 凭据、token 形态）有矩阵测试覆盖；
//   不承诺对任意输入的零泄露（正则限界），导出前请人工预览。
// - 事件时间用 `performance.now()`（单调）；longtask 观察不满足时优雅降级。
//
// 本模块故意不依赖 Solid/上下文：可被普通函数（global-sdk flush、server-sync 队列）直接调用，
// 也便于单测。

export const GUI_DIAGNOSTIC_TYPES = [
  "ui.input",
  "ui.popover",
  "ui.session.transition",
  "sse.flush",
  "sync.bootstrap",
  // 261011 Red B0.1: timeline.recompute 改名 message-read（其只测取消息数组）；
  // group-build/merge 是真实的行构建与合并计时（审计 ZW-02）。
  "timeline.message-read",
  "timeline.group-build",
  "timeline.merge",
  "timeline.measure",
  "renderer.longtask",
  "error.boundary",
] as const

export type GuiDiagnosticType = (typeof GUI_DIAGNOSTIC_TYPES)[number]

export type GuiDiagnosticOutcome = "ok" | "error"

/** detail 值：标量，或一层数字直方图（如事件类型计数，key 同样过 maskText） */
export type GuiDiagnosticValue = string | number | boolean | Record<string, number>

export type GuiDiagnosticDetail = Record<string, GuiDiagnosticValue | undefined>

export type GuiDiagnosticRecord = {
  /** 相对 timeOrigin 的单调毫秒（performance.now()），不记墙钟 */
  at: number
  type: GuiDiagnosticType
  name?: string
  /** 毫秒，保留两位小数 */
  duration?: number
  outcome?: GuiDiagnosticOutcome
  detail?: Record<string, GuiDiagnosticValue>
}

export type GuiDiagnosticDurationStats = {
  count: number
  min: number
  max: number
  avg: number
  p50: number
  p95: number
}

export type GuiDiagnosticsExport = {
  schema: "redcode.gui-diagnostics/v1"
  generatedAt: string
  page: { version?: string; platform?: string }
  span: { startedAt: number; endedAt: number; ms: number }
  limits: { maxRecords: number; maxBytes: number }
  counts: { total: number; kept: number; droppedRecords: number; droppedBytes: number; bytes: number }
  summary: {
    byType: Record<string, number>
    byOutcome: Record<string, number>
    durations: Record<string, GuiDiagnosticDurationStats>
  }
  records: GuiDiagnosticRecord[]
}

export const GUI_DIAGNOSTICS_DEFAULT_LIMITS = { maxRecords: 2000, maxBytes: 512 * 1024 } as const

// FNV-1a：仅为匿名 key 取稳定短标签——非安全哈希（32 位、候选值可枚举比对、会碰撞），
// 不承诺不可逆；anonKey 另加每录制随机 salt，导出样本无法脱离 salt 复现映射。
export function hashId(value: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

let anonSalt = ""
const randomSalt = () => {
  const source = globalThis.crypto
  if (!source?.getRandomValues) return Math.random().toString(36).slice(2, 18)
  return Array.from(source.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("")
}
export const anonKey = (value: string) => `anon-${hashId(anonSalt + value)}`

// 遮蔽规则（宁可多吃字符，不可漏）：目标是让「完整路径 / 凭据」永远不会出现在导出里。
// Windows/UNC 路径允许含空格——错误消息里的路径常带空格，只到行尾或常见闭合符为止。
// 261011 Red B0.1（审计 ZW-04）：盘符正反斜杠都遮（此前 C:/... 只剩 C:<path>）；POSIX 从
// 白名单前缀放开为任意 ≥2 段绝对路径（/data/private/... 此前整条残留），单段路由
// （/doc、/tui、/session）不误伤；新增 URL query 凭据只遮值、保留键名。
const MASK_RULES: [RegExp, string][] = [
  [/[A-Za-z]:[\\/][^\n"'`<>|)]*/g, "<path>"],
  [/\\\\[^\n"'`<>|)]*/g, "<path>"],
  [/(^|[\s("'`=:])\/(?:[^\n"'`)]+\/)+[^\n"'`)]*/g, "$1<path>"],
  [/([?&](?:token|access_token|api_key|apikey|secret|password)=)[^\s&"'`]*/gi, "$1<redacted>"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>"],
  [/sk-[A-Za-z0-9._-]{8,}/g, "<redacted>"],
  [/gh[pousr]_[A-Za-z0-9]{8,}/g, "<redacted>"],
  [/xox[bp]-[A-Za-z0-9-]{8,}/g, "<redacted>"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>"],
]

export function maskText(value: string, maxLength = 300): string {
  let text = value
  for (const [pattern, replacement] of MASK_RULES) text = text.replace(pattern, replacement)
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}

function sanitizeDetail(detail: GuiDiagnosticDetail): Record<string, GuiDiagnosticValue> | undefined {
  const out: Record<string, GuiDiagnosticValue> = {}
  for (const [key, value] of Object.entries(detail)) {
    if (value === undefined) continue
    if (typeof value === "string") out[key] = maskText(value, 200)
    else if (typeof value === "number") out[key] = Number.isFinite(value) ? Math.round(value * 100) / 100 : 0
    else if (typeof value === "object") {
      // 261011 Red B0.1: 一层数字直方图——key 过 maskText，值只留有限数
      const histogram: Record<string, number> = {}
      for (const [k, v] of Object.entries(value)) histogram[maskText(k, 80)] = Number.isFinite(v) ? v : 0
      out[key] = histogram
    } else out[key] = value
  }
  return Object.keys(out).length === 0 ? undefined : out
}

export type GuiDiagnosticsRecordInput = {
  name?: string
  duration?: number
  outcome?: GuiDiagnosticOutcome
  detail?: GuiDiagnosticDetail
}

export type GuiDiagnosticsOptions = {
  maxRecords?: number
  maxBytes?: number
  /** 测试可注入；默认 performance.now()（不可用时退 Date.now） */
  now?: () => number
}

export type GuiDiagnostics = {
  enabled: () => boolean
  count: () => number
  start: () => void
  stop: () => void
  record: (type: GuiDiagnosticType, input?: GuiDiagnosticsRecordInput) => void
  /** 导出载荷（脱敏后）；meta 由调用方提供页面信息（版本/平台），不进其他数据 */
  payload: (meta?: { version?: string; platform?: string }) => GuiDiagnosticsExport
}

export function createGuiDiagnostics(options: GuiDiagnosticsOptions = {}): GuiDiagnostics {
  const maxRecords = Math.max(1, options.maxRecords ?? GUI_DIAGNOSTICS_DEFAULT_LIMITS.maxRecords)
  const maxBytes = Math.max(1, options.maxBytes ?? GUI_DIAGNOSTICS_DEFAULT_LIMITS.maxBytes)
  const now = options.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()))
  // 261011 Red B0.1: maxBytes 按真实 UTF-8 字节计（此前用 JSON 字符串的 UTF-16 码元数，CJK 低估）
  const encoder = new TextEncoder()

  type Entry = GuiDiagnosticRecord & { size: number }
  const slots: (Entry | undefined)[] = new Array(maxRecords)
  // 261011 Red B0.1（审计 ZW-08）：失败证据（outcome=error）不进主环，单独进高优先级槽——
  // 高频洪峰不会把异常挤出导出（真机 3302→1302 淘汰曾吞掉故障注入证据）。容量为主环的
  // 10%（至少 1 条），超容量按 FIFO 顶旧；单条大小受 maskText 截断约束，槽占用有界。
  const errorSlots: Entry[] = []
  const errorMax = Math.max(1, Math.min(maxRecords, Math.floor(maxRecords / 10)))
  let head = 0
  let size = 0
  let bytes = 0
  let errorBytes = 0
  let total = 0
  let droppedRecords = 0
  let droppedBytes = 0

  let on = false
  let startedAt = 0
  let stoppedAt: number | undefined
  let disconnectLongTasks: (() => void) | undefined

  const evictOldest = () => {
    const evicted = slots[head]
    if (!evicted) return
    slots[head] = undefined
    head = (head + 1) % maxRecords
    size -= 1
    bytes -= evicted.size
    droppedRecords += 1
    droppedBytes += evicted.size
  }

  const push = (record: GuiDiagnosticRecord) => {
    // 261011 Red B0.1: 真实 UTF-8 字节（此前按 UTF-16 码元近似，CJK 低估约三分之一）
    const entry: Entry = { ...record, size: encoder.encode(JSON.stringify(record)).length }
    total += 1
    if (record.outcome === "error") {
      errorSlots.push(entry)
      errorBytes += entry.size
      if (errorSlots.length > errorMax) {
        const evicted = errorSlots.shift()
        if (evicted) {
          errorBytes -= evicted.size
          droppedRecords += 1
          droppedBytes += evicted.size
        }
      }
      return
    }
    if (size === maxRecords) evictOldest()
    slots[(head + size) % maxRecords] = entry
    size += 1
    bytes += entry.size
    while (bytes > maxBytes && size > 1) evictOldest()
  }

  const records = (): GuiDiagnosticRecord[] => {
    const out: GuiDiagnosticRecord[] = []
    for (let i = 0; i < size; i++) {
      const entry = slots[(head + i) % maxRecords]
      if (!entry) continue
      const { size: _size, ...record } = entry
      out.push(record)
    }
    for (const entry of errorSlots) {
      const { size: _size, ...record } = entry
      out.push(record)
    }
    // 两段各自时间升序，合并后统一排序（导出/预览一次性成本）
    return out.sort((a, b) => a.at - b.at)
  }

  const record = (type: GuiDiagnosticType, input: GuiDiagnosticsRecordInput = {}) => {
    if (!on) return
    const out: GuiDiagnosticRecord = { at: Math.round(now() * 100) / 100, type }
    if (input.name) out.name = maskText(input.name, 80)
    if (input.duration !== undefined && Number.isFinite(input.duration))
      out.duration = Math.round(Math.max(0, input.duration) * 100) / 100
    if (input.outcome) out.outcome = input.outcome
    if (input.detail) {
      const detail = sanitizeDetail(input.detail)
      if (detail) out.detail = detail
    }
    push(out)
  }

  const startLongTasks = () => {
    // 兼容性不足则优雅降级：没有 PerformanceObserver / 内核不认 longtask 都只是少一类事件
    if (typeof PerformanceObserver === "undefined") return
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          record("renderer.longtask", { name: entry.name || "longtask", duration: entry.duration })
        }
      })
      observer.observe({ entryTypes: ["longtask"] })
      disconnectLongTasks = () => observer.disconnect()
    } catch {
      disconnectLongTasks = undefined
    }
  }

  const start = () => {
    if (on) return
    // 261011 Red B0.1: 每次录制换 salt——anonKey 不可跨录制对照（审计 ZW-04）
    anonSalt = randomSalt()
    // 新一次录制从空缓冲开始：避免两次录制的 span 混在一起
    for (let i = 0; i < maxRecords; i++) slots[i] = undefined
    head = 0
    size = 0
    bytes = 0
    errorSlots.length = 0
    errorBytes = 0
    total = 0
    droppedRecords = 0
    droppedBytes = 0
    on = true
    startedAt = now()
    stoppedAt = undefined
    startLongTasks()
  }

  const stop = () => {
    if (!on) return
    on = false
    stoppedAt = now()
    disconnectLongTasks?.()
    disconnectLongTasks = undefined
  }

  const durationStats = (values: number[]): GuiDiagnosticDurationStats => {
    const sorted = [...values].sort((a, b) => a - b)
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
    const sum = sorted.reduce((acc, v) => acc + v, 0)
    return {
      count: sorted.length,
      min: sorted[0]!,
      max: sorted[sorted.length - 1]!,
      avg: Math.round((sum / sorted.length) * 100) / 100,
      p50: at(0.5),
      p95: at(0.95),
    }
  }

  const payload = (meta: { version?: string; platform?: string } = {}): GuiDiagnosticsExport => {
    const list = records()
    const byType: Record<string, number> = {}
    const byOutcome: Record<string, number> = {}
    const durationGroups: Record<string, number[]> = {}
    for (const item of list) {
      byType[item.type] = (byType[item.type] ?? 0) + 1
      if (item.outcome) byOutcome[item.outcome] = (byOutcome[item.outcome] ?? 0) + 1
      if (item.duration !== undefined) (durationGroups[item.type] ??= []).push(item.duration)
    }
    const durations: Record<string, GuiDiagnosticDurationStats> = {}
    for (const [type, values] of Object.entries(durationGroups)) durations[type] = durationStats(values)
    const endedAt = stoppedAt ?? now()
    return {
      schema: "redcode.gui-diagnostics/v1",
      generatedAt: new Date().toISOString(),
      page: {
        ...(meta.version ? { version: meta.version } : {}),
        ...(meta.platform ? { platform: meta.platform } : {}),
      },
      span: { startedAt, endedAt, ms: Math.round(Math.max(0, endedAt - startedAt)) },
      limits: { maxRecords, maxBytes },
        counts: { total, kept: list.length, droppedRecords, droppedBytes, bytes: bytes + errorBytes },
      summary: { byType, byOutcome, durations },
      records: list,
    }
  }

  return {
    enabled: () => on,
    count: () => size + errorSlots.length,
    start,
    stop,
    record,
    payload,
  }
}

/** 应用级单例：所有接线点直接 import 它（默认关闭，零成本）。 */
export const guiDiagnostics = createGuiDiagnostics()
