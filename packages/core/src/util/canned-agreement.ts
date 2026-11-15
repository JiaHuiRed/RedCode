/**
 * Removes formulaic assent from assistant prose before display.
 * This is presentation-only: stored text, tool output and user messages are untouched.
 * Literal contexts — fenced/indented/quoted lines, inline code and quotation marks — are preserved.
 * A matched clause is dropped whole so the remaining sentence still reads.
 */
const ASSENT = /(?:你|您|哥哥|哥)说[得的]对[ \t]*$/
const ACCEPT = /(?:这个|这点|这回|这事|这次)?我认$/
const BOUNDARY = new Set(["，", ",", "。", "！", "!", "？", "?", "；", ";", "：", ":"])
const HAN = /\p{Script=Han}/u
const QUOTES: Record<string, string> = { '“': '”', '「': '」', '『': '』', '‘': '’', '"': '"' }
const LIST = /^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)/

function stripLine(line: string): string {
  const lead = LIST.exec(line)?.[0] ?? ""
  let out = ""
  let clause = ""
  let dirty = false
  let quote: string | undefined
  let tick = false
  const check = () => {
    if (ASSENT.test(clause) || ACCEPT.test(clause)) dirty = true
  }
  const flush = () => {
    check()
    if (!dirty) out += clause
    clause = ""
    dirty = false
  }
  for (const ch of line.slice(lead.length)) {
    if (tick) {
      clause += ch
      if (ch === "`") tick = false
      continue
    }
    if (quote) {
      clause += ch
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === "`") {
      tick = true
      clause += ch
      continue
    }
    if (ch in QUOTES) {
      quote = QUOTES[ch]
      clause += ch
      continue
    }
    if (BOUNDARY.has(ch)) {
      check()
      clause += ch
      flush()
      continue
    }
    // "我认" is only formulaic when the next character does not continue a word (我认得/我认识).
    if (!HAN.test(ch) && ACCEPT.test(clause)) dirty = true
    clause += ch
    if (ch === "对" || ch === " " || ch === "\t") check()
  }
  flush()
  const body = out.replace(/^(?:哥哥|哥)[，,][ \t]*$/, "")
  if (!body.trim()) return ""
  return lead ? lead + body : body
}

/**
 * Safe on accumulated streaming text: no cross-chunk state is required.
 * Fenced/indented/quoted text and prose discussing the phrase are untouched.
 */
export function filterCannedAgreement(text: string): string {
  if (!text.includes("说") && !text.includes("我认")) return text
  let fence: { marker: string; length: number } | undefined
  let closeQuote: string | undefined
  return text.split('\n').map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker) {
      if (!fence) fence = { marker: marker[0]!, length: marker.length }
      else if (marker[0] === fence.marker && marker.length >= fence.length) fence = undefined
      return line
    }
    if (fence) return line
    const literal = closeQuote || /^\s*>/.test(line) || /^(?: {4}|\t)/.test(line)
    const next = literal ? line : stripLine(line)
    // Track quotation scope using original text so multiline quotations survive.
    for (const character of line) {
      if (closeQuote) {
        if (character === closeQuote) closeQuote = undefined
      } else if (character in QUOTES) closeQuote = QUOTES[character]
    }
    return next
  }).join('\n')
}
