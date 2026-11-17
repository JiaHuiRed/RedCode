// 261101 Red 从未完结束的工具参数 JSON 文本里容错抽取字符串字段——写长文档的渐进预览用。
// 引擎把 tool-input-delta 按节流间隔累进 pending part 的 state.raw，那是一段随时可能
// 截断的 JSON（尾部可能挂在 "\u00" 这种半个转义上），不能用 JSON.parse。这里做最好努力
// 解析：key 找不到或值不是字符串开头返回 undefined；值中途截断按 partial 返回已收到部分。
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" }

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
      const mapped = ESCAPES[next]
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

// 261108 Red 审计 RC-P2-08：上面的函数每次调用都从头扫整段 raw 并重建 value，
// 写工具的预览每来一个 delta 就调一次 —— 1 MiB 文档累计 7.76 秒（后段单次 62ms）。
// 这里给同一条流水的复用版本：只消费新增字符，value 只保留尾部窗口（预览只看最后
// 8 行，几 KB 够用），总内存与单次成本都不再随累计长度恶化。
// 前提是 raw 单调增长（引擎的 state.raw 就是累加）；一旦发现变短就整体重来。
export class PartialJsonStringReader {
  private value = ""
  private lineCount = 0
  private at = -1 // 下一个待消费的 raw 下标；-1 表示还没定位到值的起始引号
  private searchFrom = 0
  private done = false
  private lastRawLength = 0

  constructor(
    private readonly key: string,
    private readonly tailChars = 4096,
  ) {}

  /** 完整值的行数（value 被裁剪后仍准确，预览用它显示总行数） */
  get lines() {
    return this.lineCount + 1
  }

  reset() {
    this.value = ""
    this.lineCount = 0
    this.at = -1
    this.searchFrom = 0
    this.done = false
    this.lastRawLength = 0
  }

  read(raw: string): { value: string; complete: boolean } | undefined {
    // 变短说明不是累积增长（换了一个 part 或引擎重置），状态作废重来。
    // 这条要排在 done 短路之前，否则复用的 reader 会一直返回上一个值。
    if (raw.length < this.lastRawLength) this.reset()
    this.lastRawLength = raw.length
    if (this.done) return { value: this.value, complete: true }
    if (this.at < 0) {
      const marker = `"${this.key}"`
      const keyIdx = raw.indexOf(marker, this.searchFrom)
      if (keyIdx < 0) {
        this.searchFrom = Math.max(0, raw.length - marker.length + 1)
        return undefined
      }
      this.searchFrom = keyIdx
      const colon = raw.indexOf(":", keyIdx + marker.length)
      if (colon < 0) return undefined
      let i = colon + 1
      while (i < raw.length && /\s/.test(raw[i])) i++
      if (raw[i] !== '"') return undefined
      this.at = i + 1
    }
    while (this.at < raw.length) {
      const ch = raw[this.at]
      if (ch === "\\") {
        const next = raw[this.at + 1]
        // 尾部挂在半个转义上：停在这里，下次 delta 到了继续
        if (next === undefined) return { value: this.value, complete: false }
        if (next === "u") {
          const hex = raw.slice(this.at + 2, this.at + 6)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { value: this.value, complete: false }
          this.push(String.fromCharCode(Number.parseInt(hex, 16)))
          this.at += 6
          continue
        }
        const mapped = ESCAPES[next]
        if (mapped === undefined) return { value: this.value, complete: false }
        this.push(mapped)
        this.at += 2
        continue
      }
      if (ch === '"') {
        this.done = true
        this.at = raw.length
        return { value: this.value, complete: true }
      }
      // 261108 Red 审计 RC-P2-09：普通字符按段消费。逐字符 push 在 4MiB 文档上是
      // 400 万次字符串拼接（实测中位 1844ms）；用原生 indexOf 找下一个引号/反斜杠，
      // 一次 slice 追加，成本从「字符数」降到「转义与引号数」。
      const quote = raw.indexOf('"', this.at)
      const escape = raw.indexOf("\\", this.at)
      const end = quote < 0 ? (escape < 0 ? raw.length : escape) : escape < 0 ? quote : Math.min(quote, escape)
      this.pushChunk(raw.slice(this.at, end))
      this.at = end
    }
    return { value: this.value, complete: false }
  }

  private push(ch: string) {
    this.pushChunk(ch)
  }

  private pushChunk(chunk: string) {
    this.value += chunk
    for (let i = chunk.indexOf("\n"); i >= 0; i = chunk.indexOf("\n", i + 1)) this.lineCount++
    // 超过两倍窗口才裁一次，均摊 O(1)；预览只要尾部，裁掉的前缀不再需要
    if (this.value.length > this.tailChars * 2) this.value = this.value.slice(-this.tailChars)
  }
}
