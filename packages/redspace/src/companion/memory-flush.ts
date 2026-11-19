// 261119 Red 压缩前记忆冲刷（迁移路线第 2 项）：压缩会把会话折叠成摘要，长期记忆若只靠
// agent 自觉，重要上下文会在压缩边界后彻底消失。这里在摘要前跑一个静默 turn，让模型只
// 提取「还没落盘、值得长期保留」的事实，经既有 Companion.remember 路径写入日记。
// 默认关 REDCODE_EXPERIMENTAL_COMPANION_MEMORY_FLUSH=1；失败不阻断压缩。
// 决策：docs/notes/proposed/architecture/2026-11-18-qiuqiu-full-migration.md
export const MAX_ENTRIES = 3
export const MAX_ENTRY_BYTES = 1024
export const MAX_CONTEXT_BYTES = 12_000
export const MIN_CONTEXT_BYTES = 200

export const enabled = () => process.env["REDCODE_EXPERIMENTAL_COMPANION_MEMORY_FLUSH"] === "1"

function truncate(value: string, bytes: number) {
  if (Buffer.byteLength(value) <= bytes) return value
  return Buffer.from(value).subarray(0, bytes).toString("utf8").replace(/\uFFFD+$/, "")
}

// 模型偶尔包代码围栏；只认 {"entries":[...]}，条目可以是字符串或 {"text": "..."}。
export function parse(raw: string): string[] {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
  if (!cleaned) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== "object") return []
  const entries = Array.isArray((parsed as { entries?: unknown }).entries) ? (parsed as { entries: unknown[] }).entries : []
  return entries
    .flatMap((item) => {
      const text =
        typeof item === "string"
          ? item
          : item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
            ? (item as { text: string }).text
            : undefined
      const trimmed = text?.trim()
      return trimmed ? [truncate(trimmed, MAX_ENTRY_BYTES)] : []
    })
    .slice(0, MAX_ENTRIES)
}

// 从展示序消息里倒序收集可见正文，总量有界；只给模型看最近这一段，不回放整库。
export function contextText(
  messages: { parts: { type: string; text?: string; synthetic?: boolean }[] }[],
  bytes = MAX_CONTEXT_BYTES,
) {
  const blocks: string[] = []
  let used = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message) continue
    const text = message.parts
      .flatMap((part) => (part.type === "text" && !part.synthetic && part.text ? [part.text.trim()] : []))
      .filter(Boolean)
      .join("\n")
    if (!text) continue
    const separator = blocks.length ? Buffer.byteLength("\n\n") : 0
    const remaining = bytes - used - separator
    if (remaining <= 0) break
    const size = Buffer.byteLength(text)
    if (size > remaining) {
      const clipped = Buffer.from(text).subarray(0, remaining).toString("utf8").replace(/\uFFFD+$/, "")
      if (clipped) blocks.unshift(clipped)
      break
    }
    blocks.unshift(text)
    used += separator + size
  }
  return blocks.join("\n\n")
}

export * as MemoryFlush from "./memory-flush"
