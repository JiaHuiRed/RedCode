import { Locale } from "@/util/locale"

// 261116 Red A04：引用到草稿的统一格式。带可追溯来源（会话/消息/part），
// 正文有明确上限——超出只带末尾并显式标注，不冒充完整引用。
export const QUOTE_CHAR_CAP = 2_000

export type QuoteSource = {
  kind: "message" | "tool"
  sessionID: string
  messageID: string
  partID?: string
  label?: string
}

export function quoteSourceLabel(source: QuoteSource) {
  const kind =
    source.kind === "tool" ? `工具${source.label ? ` ${source.label} ` : " "}输出` : (source.label ?? "消息")
  const parts = [`会话 ${source.sessionID}`, `消息 ${source.messageID}`]
  if (source.partID) parts.push(`part ${source.partID}`)
  return `${kind} · ${parts.join(" / ")}`
}

export function quoteSnippet(text: string, source: QuoteSource) {
  const body = text.trim()
  if (!body) return ""
  const over = body.length > QUOTE_CHAR_CAP
  const shown = over ? body.slice(-QUOTE_CHAR_CAP) : body
  const tail = over
    ? `\n…（引用已截断：仅含末尾 ${QUOTE_CHAR_CAP.toLocaleString()} 字符，原文共 ${body.length.toLocaleString()} 字符）`
    : ""
  return `\n\n[引用：${quoteSourceLabel(source)}]\n${shown}${tail}\n`
}

// 会话消息里的可见正文（不含 synthetic 内部提醒）。
export function quoteMessageText(parts: { type: string; text?: string; synthetic?: boolean }[]) {
  return parts
    .flatMap((part) => (part.type === "text" && !part.synthetic && part.text ? [part.text] : []))
    .join("\n\n")
    .trim()
}

// 列表里的短标题：只用于对话框条目，不参与引用正文。
export function quoteTitle(text: string) {
  return Locale.truncate(text.replace(/\s+/g, " ").trim(), 32)
}
