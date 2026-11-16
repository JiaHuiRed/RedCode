// 261116 Red B05/B06/A04 共用引用契约：消息/工具/终端/文件选区 → 草稿里的带来源引用块。
// 纯文本组装，不碰 Solid/i18n/发送；时间线、终端、后台结果共用同一套截断与来源格式。
// 来源写进头部以便回跳定位；定位不到具体片段时头部必须显式写「来源不可定位」。
// 决策：docs/notes/implemented/feature/2026-11-16-experience-roadmap-v2.md

import type { Prompt } from "@/context/prompt"

/** 单条引用的正文上限（与后台结果引用一致）。 */
export const REFERENCE_TEXT_LIMIT = 2000
/** 头部来源字段（终端 title/文件 path 等外部串）的单字段上限。 */
export const REFERENCE_HEADER_FIELD_LIMIT = 120

export type ReferenceAnchor =
  | {
      kind: "message"
      sessionID?: string
      messageID?: string
      partID?: string
      /** 命中片段所属的用户轮次；有它时跳转不必再解析父消息。 */
      userMessageID?: string
      role?: "user" | "assistant"
      /** 选区在 part 正文里的起始字符偏移（仅作说明，不参与定位）。 */
      offset?: number
    }
  | {
      kind: "tool"
      sessionID?: string
      messageID?: string
      partID?: string
      userMessageID?: string
      tool?: string
    }
  | {
      kind: "terminal"
      sessionID?: string
      terminalID?: string
      title?: string
    }
  | {
      kind: "file"
      path?: string
      startLine?: number
      endLine?: number
    }
  | {
      kind: "unknown"
      label?: string
    }

export type ReferenceInput = {
  anchor: ReferenceAnchor
  text: string
  /** 采样时刻（epoch ms），默认 Date.now()。 */
  at?: number
  /** 超限时保留哪一端；默认保留开头（选区是用户显式选的）。 */
  keep?: "head" | "tail"
  limit?: number
  labels?: {
    unknown?: string
    truncated?: (info: { total: number; shown: number; keep: "head" | "tail" }) => string
  }
}

export type Reference = {
  anchor: ReferenceAnchor
  /** 截断后的正文（未加引用前缀）。 */
  text: string
  total: number
  truncated: boolean
  /** 可直接追加到 prompt 的完整块（头部 + 引用正文 + 截断提示）。 */
  block: string
}

const pad = (value: number) => String(value).padStart(2, "0")

/** 本地时间 `YYYY-MM-DD HH:mm`：不依赖 locale。 */
export function referenceTime(at = Date.now()) {
  const date = new Date(at)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// 外部串（终端标题、文件路径）可以任意长；头部同样要有界，否则正文有界而整体无界。
const field = (value: string | undefined, limit = REFERENCE_HEADER_FIELD_LIMIT) => {
  if (!value) return undefined
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

export function referenceLabel(anchor: ReferenceAnchor, unknown = "来源不可定位") {
  if (anchor.kind === "message") {
    return anchor.role === "user" ? "用户" : anchor.role === "assistant" ? "助手" : "消息"
  }
  if (anchor.kind === "tool") return anchor.tool ? `工具 ${field(anchor.tool)}` : "工具输出"
  if (anchor.kind === "terminal") return anchor.title ? `终端「${field(anchor.title)}」` : "终端"
  if (anchor.kind === "file") return anchor.path ? `文件 ${field(anchor.path)}` : "文件"
  return field(anchor.label) || unknown
}

const sourceIDs = (anchor: ReferenceAnchor) => {
  const parts: string[] = []
  if (anchor.kind === "message" || anchor.kind === "tool") {
    if (anchor.sessionID) parts.push(`会话 ${field(anchor.sessionID)}`)
    if (anchor.messageID) parts.push(`消息 ${field(anchor.messageID)}`)
    if (anchor.partID) parts.push(`片段 ${field(anchor.partID)}`)
    // 没有选区时的整条引用要写明范围，读者才知道引的是整条消息而不是某一段。
    if (anchor.kind === "message" && !anchor.partID) parts.push("整条消息")
  } else if (anchor.kind === "terminal") {
    if (anchor.sessionID) parts.push(`会话 ${field(anchor.sessionID)}`)
    if (anchor.terminalID) parts.push(`终端 ${field(anchor.terminalID)}`)
  } else if (anchor.kind === "file" && anchor.startLine) {
    parts.push(
      anchor.endLine && anchor.endLine !== anchor.startLine
        ? `行:${anchor.startLine}-${anchor.endLine}`
        : `行:${anchor.startLine}`,
    )
  }
  return parts.length ? ` · ${parts.join(" · ")}` : ""
}

const locatable = (anchor: ReferenceAnchor) => {
  if (anchor.kind === "message" || anchor.kind === "tool") return !!(anchor.messageID || anchor.partID)
  if (anchor.kind === "terminal") return !!(anchor.terminalID || anchor.title)
  if (anchor.kind === "file") return !!anchor.path
  return false
}

const quoteBody = (text: string) =>
  text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")

export function buildReference(input: ReferenceInput): Reference {
  const limit = Math.min(REFERENCE_TEXT_LIMIT, Math.max(1, input.limit ?? REFERENCE_TEXT_LIMIT))
  const keep = input.keep ?? "head"
  const total = input.text.length
  const truncated = total > limit
  const clipped = truncated ? (keep === "tail" ? input.text.slice(total - limit) : input.text.slice(0, limit)) : input.text
  const text = clipped.trim()
  const anchor = input.anchor
  const unknown = input.labels?.unknown ?? "来源不可定位"
  const label = locatable(anchor) ? referenceLabel(anchor, unknown) : unknown
  const header = `[引用 · ${label} · ${referenceTime(input.at)}${locatable(anchor) ? sourceIDs(anchor) : ""}]`
  const body = text ? quoteBody(text) : "> "
  const note = truncated
    ? input.labels?.truncated?.({ total, shown: text.length, keep }) ??
      `…（引用已截断：原长 ${total} 字符，仅保留${keep === "tail" ? "末尾" : "开头"} ${text.length} 字符）`
    : undefined
  return { anchor, text, total, truncated, block: note ? `${header}\n${body}\n${note}` : `${header}\n${body}` }
}

/**
 * 追加引用块到草稿末尾：不动已有部件（附件/@文件/Agent/图片都保留），只追加一个文本部件，
 * start/end 按现有内容长度累加，光标落到引用块末尾。
 */
export function appendReference(prompt: Prompt, reference: Reference | string) {
  const block = typeof reference === "string" ? reference : reference.block
  if (!block) return { prompt, cursor: 0 }
  const parts = prompt.slice()
  const base = parts.map((part) => ("content" in part && typeof part.content === "string" ? part.content : "")).join("")
  const separator = base.length === 0 ? "" : base.endsWith("\n\n") ? "" : base.endsWith("\n") ? "\n" : "\n\n"
  const content = `${separator}${block}\n`
  const cursor = base.length + content.length
  return {
    prompt: [...parts, { type: "text" as const, content, start: base.length, end: cursor }],
    cursor,
  }
}
