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

/**
 * 最后一个**顶层**块级 token 的起始行。
 *
 * 260901 cc 用来把「已经定型的前缀」和「还在长的那一块」切开。判据是 markdown-it 的
 * token 层级：level === 0 才是顶层，nesting >= 0 排掉 _close。列表/引用整体是一个顶层
 * token 序列（bullet_list_open 在 level 0，list_item 在 level 1），所以这条判据**不会切进
 * 列表内部**——那正是这里最怕的事：把一个列表切成两个 <ul>，松散/紧凑语义还会跟着变。
 */
function topLevelStarts(tokens: ReturnType<typeof md.parse>) {
  const lines: number[] = []
  for (const token of tokens) {
    if (token.level !== 0 || token.nesting < 0) continue
    const line = token.map?.[0]
    if (typeof line !== "number") continue
    if (lines.at(-1) === line) continue
    lines.push(line)
  }
  return lines
}

/**
 * 定型前缀的分段粒度。
 *
 * 260901 cc 为什么不是「每个顶层块一块」：markdown.tsx:15 的块缓存是全局 LRU、上限
 * 200 条，而一条 30KB 的回答有约 300 个顶层块——全切会把缓存冲垮，反而更差。
 * 为什么不是「整个前缀一块」：那样每完成一个块就要把**整个前缀**重新 parse 一遍，
 * 实测 30KB / 776 tick 的模拟里只省到 3.6 倍（11.50MB → 3.23MB），远不够。
 *
 * 按固定字节数分段两头都占：块数 = 全文/4KB（30KB 约 8 块），而每 tick 真正重算的只有
 * 「正在填的那一段 + 活跃尾块」，与全文长度无关。分段边界只取决于**更早**的内容，
 * 所以文本增长时已经切好的边界不会移动——缓存命中全靠这一条。
 */
const CHUNK_BYTES = 4096

export function stream(text: string, live: boolean) {
  if (!live) return [{ raw: text, src: text, mode: "full" }] satisfies Block[]
  const src = heal(text)
  // 引用式定义可以出现在正文任何位置并影响**前面**的链接，所以这种文本不能切。
  if (refs(text)) return [{ raw: text, src, mode: "live" }] satisfies Block[]
  // 260802 Red: marked → markdown-it（marked 的 lexer 对长文本 O(n²)，换用线性 tokenize）
  // 未闭合 fence 的特征：markdown-it 不产生 fence_close，token 序列以 fence 结尾
  const tokens = md.parse(text, {})
  const last = tokens.at(-1)
  if (last && last.type === "fence") {
    const code = text.slice(lineStart(text, last.map?.[0] ?? 0))
    if (open(code)) {
      const head = text.slice(0, text.length - code.length)
      if (!head) return [{ raw: code, src: code, mode: "live" }] satisfies Block[]
      // 代码块不 heal —— heal 会去动代码里的字符
      return [
        { raw: head, src: heal(head), mode: "live" },
        { raw: code, src: code, mode: "live" },
      ] satisfies Block[]
    }
  }

  // 260901 cc 一般情况也切成「定型前缀 + 活跃尾块」。
  //
  // 之前只有「正好停在未闭合围栏里」才切，其余一律返回整条消息一块。于是流式期间
  // block.raw 每 tick 都变 ⇒ markdown.tsx:271 那个 per-block 缓存**永远不命中** ⇒
  // 每 tick 对整条消息重跑 md.render + DOMPurify.sanitize。实测每 tick 合计：
  //   10.9KB 4.1ms / 30.1KB 9.8ms / 61.5KB 21.5ms / 123KB 36.7ms
  // 其中 sanitize 是最大头（30KB 时 5.3ms，123KB 时 20.1ms），parse 次之。
  // 长回答越写越卡就是这条：成本与**已写出的全文长度**成正比，而每 tick 都付一次。
  //
  // 切开之后前缀块的 raw 在两次块边界之间是恒定的 ⇒ 缓存命中 ⇒ parse 与 sanitize 都跳过，
  // 只有尾块重算。前缀只在「一个块写完、新块开始」时才变一次，不是每 tick。
  //
  // 注意这里只省掉 parse/sanitize，DOM 那一步（innerHTML + morphdom）仍然是整篇做的
  // ——把每个块渲染进各自的子容器是下一步，风险更高，先不动。
  const starts = topLevelStarts(tokens)
  if (starts.length < 2) return [{ raw: text, src, mode: "live" }] satisfies Block[]

  // 最后一个顶层块还在长，它是活跃尾块；它之前的都已经定型。
  const tailOffset = lineStart(text, starts[starts.length - 1]!)
  if (tailOffset <= 0 || tailOffset >= text.length) return [{ raw: text, src, mode: "live" }] satisfies Block[]

  const blocks: Block[] = []
  let cut = 0
  for (let i = 1; i < starts.length - 1; i++) {
    const offset = lineStart(text, starts[i]!)
    if (offset - cut < CHUNK_BYTES) continue
    const chunk = text.slice(cut, offset)
    blocks.push({ raw: chunk, src: heal(chunk), mode: "live" })
    cut = offset
  }
  const settled = text.slice(cut, tailOffset)
  if (settled) blocks.push({ raw: settled, src: heal(settled), mode: "live" })
  const tail = text.slice(tailOffset)
  blocks.push({ raw: tail, src: heal(tail), mode: "live" })
  return blocks
}
