// 261119 Red 压缩前记忆冲刷（迁移路线第 2 项）：压缩会把会话折叠成摘要，长期记忆若只靠
// agent 自觉，重要上下文会在压缩边界后彻底消失。这里在摘要前跑一个静默 turn，让模型只
// 提取「还没落盘、值得长期保留」的事实，经既有 Companion.remember 路径写入日记。
// 默认关 REDCODE_EXPERIMENTAL_COMPANION_MEMORY_FLUSH=1；失败不阻断压缩。
// 决策：docs/notes/proposed/architecture/2026-11-18-qiuqiu-full-migration.md
import type { MessageV2 } from "@/session/message-v2"

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

// 261120 Red 每条记录用独立 JSON 行，避免正文伪造角色边界，裁剪也保留完整的消息元数据。
export function context(
  messages: readonly {
    info:
      | Pick<MessageV2.User, "role" | "id" | "time" | "delivery">
      | Pick<MessageV2.Assistant, "role" | "id" | "time" | "summary">
    parts: readonly { type: string; text?: string; synthetic?: boolean; ignored?: boolean }[]
  }[],
  bytes = MAX_CONTEXT_BYTES,
) {
  const blocks: string[] = []
  let used = 0
  let contentBytes = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    const info = message.info
    if (info.role === "user" && (info.delivery === "queued" || info.delivery === "pending_steer")) continue
    const text = message.parts
      .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored && part.text ? [part.text.trim()] : []))
      .filter(Boolean)
      .join("\n")
    if (!text) continue
    const header = JSON.stringify({
      role: info.role === "assistant" && info.summary ? "summary" : info.role,
      messageID: info.id,
      createdAt: info.time.created,
    })
    const prefix = header.slice(0, -1) + ',"text":'
    const overhead = (blocks.length ? 1 : 0) + Buffer.byteLength(prefix) + 1
    const remaining = bytes - used - overhead
    if (remaining <= 2) break
    let clipped = truncate(text, remaining - 2)
    let encoded = JSON.stringify(clipped)
    while (Buffer.byteLength(encoded) > remaining) {
      clipped = truncate(clipped, Math.floor((Buffer.byteLength(clipped) * remaining) / Buffer.byteLength(encoded)))
      encoded = JSON.stringify(clipped)
    }
    if (!clipped) break
    blocks.unshift(prefix + encoded + "}")
    used += overhead + Buffer.byteLength(encoded)
    contentBytes += Buffer.byteLength(clipped)
    if (clipped !== text) break
  }
  return { text: blocks.join("\n"), contentBytes }
}

export * as MemoryFlush from "./memory-flush"
