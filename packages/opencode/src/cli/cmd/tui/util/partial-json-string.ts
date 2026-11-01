// 261101 Red 从未完结束的工具参数 JSON 文本里容错抽取字符串字段——写长文档的渐进预览用。
// 引擎把 tool-input-delta 按节流间隔累进 pending part 的 state.raw，那是一段随时可能
// 截断的 JSON（尾部可能挂在 "\u00" 这种半个转义上），不能用 JSON.parse。这里做最好努力
// 解析：key 找不到或值不是字符串开头返回 undefined；值中途截断按 partial 返回已收到部分。
export function extractPartialJsonString(
  raw: string,
  key: string,
): { value: string; complete: boolean } | undefined {
  const marker = `"${key}"`
  const keyIdx = raw.indexOf(marker)
  if (keyIdx < 0) return undefined
  const colon = raw.indexOf(":", keyIdx + marker.length)
  if (colon < 0) return undefined
  let i = colon + 1
  while (i < raw.length && /\s/.test(raw[i])) i++
  if (raw[i] !== '"') return undefined
  i++
  // JSON 基本转义表；\uXXXX 单独处理（长度 6，且尾部可能只到一半）
  const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" }
  let value = ""
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === "\\") {
      const next = raw[i + 1]
      if (next === undefined) break
      if (next === "u") {
        const hex = raw.slice(i + 2, i + 6)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break
        value += String.fromCharCode(Number.parseInt(hex, 16))
        i += 6
        continue
      }
      const mapped = escapes[next]
      if (mapped === undefined) break
      value += mapped
      i += 2
      continue
    }
    if (ch === '"') return { value, complete: true }
    value += ch
    i++
  }
  return { value, complete: false }
}
