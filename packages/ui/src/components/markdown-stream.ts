import MarkdownIt from "markdown-it"
import remend from "remend"

export type Block = {
  raw: string
  src: string
  mode: "full" | "live"
}

const md = new MarkdownIt()

function refs(text: string) {
  return /^\[[^\]]+\]:\s+\S+/m.test(text) || /^\[\^[^\]]+\]:\s+/m.test(text)
}

function open(raw: string) {
  const match = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)
  if (!match) return false
  const mark = match[1]
  if (!mark) return false
  const char = mark[0]
  const size = mark.length
  const last = raw.trimEnd().split("\n").at(-1)?.trim() ?? ""
  return !new RegExp(`^[\\t ]{0,3}${char}{${size},}[\\t ]*$`).test(last)
}

function heal(text: string) {
  return remend(text, { linkMode: "text-only" })
}

// 第 line 行（0-based）的起始字符偏移，用于从原文本精确切片
function lineStart(text: string, line: number) {
  let idx = 0
  for (let i = 0; i < line; i++) {
    const nl = text.indexOf("\n", idx)
    if (nl === -1) return text.length
    idx = nl + 1
  }
  return idx
}

export function stream(text: string, live: boolean) {
  if (!live) return [{ raw: text, src: text, mode: "full" }] satisfies Block[]
  const src = heal(text)
  if (refs(text)) return [{ raw: text, src, mode: "live" }] satisfies Block[]
  // 260802 Red: marked → markdown-it（marked 的 lexer 对长文本 O(n²)，换用线性 tokenize）
  // 未闭合 fence 的特征：markdown-it 不产生 fence_close，token 序列以 fence 结尾
  const tokens = md.parse(text, {})
  const last = tokens.at(-1)
  if (!last || last.type !== "fence") return [{ raw: text, src, mode: "live" }] satisfies Block[]
  const fence = last
  const code = text.slice(lineStart(text, fence.map?.[0] ?? 0))
  if (!open(code)) return [{ raw: text, src, mode: "live" }] satisfies Block[]
  const head = text.slice(0, text.length - code.length)
  if (!head) return [{ raw: code, src: code, mode: "live" }] satisfies Block[]
  return [
    { raw: head, src: heal(head), mode: "live" },
    { raw: code, src: code, mode: "live" },
  ] satisfies Block[]
}
