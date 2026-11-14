/**
 * Removes only independent, formulaic assent openers from assistant prose.
 * This is presentation-only: it does not change saved text, tool output or user messages.
 * Do not extend this to generic apologies or words like "我认识" / "我认错".
 */
const OPENER = /^( {0,3})(?:(哥哥|哥)[，,][ \t]*)?((?:你|您|哥哥|哥)说[得的]对|(?:这个|这点|这回|这事|这次)?我认)(?=$|[ \t，,。！!；;：:])/u
const PUNCT = /^[ \t]*[，,。！!；;：:][ \t]*/u
const QUOTES: Record<string, string> = { '“': '”', '「': '」', '『': '』', '‘': '’', '"': '"' }

function stripOpening(line: string): string {
  let result = line
  // A response can stack two formulaic openers. Never keep stripping beyond them.
  for (let i = 0; i < 3; i++) {
    const match = OPENER.exec(result)
    if (!match) break
    const remainder = result.slice(match[0].length).replace(PUNCT, '').trimStart()
    if (!remainder) return ''
    result = `${match[1]}${match[2] ? `${match[2]}，` : ''}${remainder}`
  }
  return result
}

/**
 * Safe on accumulated streaming text: no cross-chunk state is required.
 * Fenced/indented/quoted text and prose discussing the phrase are untouched.
 */
export function filterCannedAgreement(text: string): string {
  if (!text.includes('说') && !text.includes('我认')) return text
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
    const next = literal ? line : stripOpening(line)
    // Track quotation scope using original text so multiline quotations survive.
    for (const character of line) {
      if (closeQuote) {
        if (character === closeQuote) closeQuote = undefined
      } else if (character in QUOTES) closeQuote = QUOTES[character]
    }
    return next
  }).join('\n')
}
