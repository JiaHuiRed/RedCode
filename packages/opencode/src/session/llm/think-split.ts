// 261024 Red 部分 OpenAI 兼容模型（step-5-preview 实测，DeepSeek-R1 同款模板）把推理以
// `<think>…</think>` 内联在 content 通道输出，而协议层（openai-chat.ts）只把
// `reasoning_content` 字段映射成推理事件——内联块整段漏进正文，TUI/GUI 里思考链变正文、
// 收尾还带字面 `</think>`。这个扫描器把 content 增量流拆成 text / reasoning 两路：
// 开标签后进推理路，闭标签回文本路；孤立闭标签（serving 模板把 </think> 当普通 token
// 泄出的形态）只丢标签本身，已流出的文本无法也不应回捞。
//
// 与 instruction-echo 的 LeakAnchorScanner 同一类「尾窗缓冲」手法：可能构成标签前缀的
// 尾巴（≤7 字符）扣到下一条增量再判，标签跨增量分裂也能命中。模型不吐 think 标签时
// 除 7 字符延迟外零影响。

const OPEN = "<think>"
const CLOSE = "</think>"
const TAG_MAX = OPEN.length // 两标签前缀共享的最长可能剩余 = 7（"<think>"）

/** 悬挂尾窗里最长、且恰好是某个标签前缀的后缀长度；没有则 0。 */
function holdbackLength(rest: string): number {
  const max = Math.min(TAG_MAX, rest.length)
  for (let k = max; k > 0; k--) {
    const suffix = rest.slice(-k)
    if (OPEN.startsWith(suffix) || CLOSE.startsWith(suffix)) return k
  }
  return 0
}

export type ThinkSplit = { text: string; reasoning: string }

export class ThinkTagScanner {
  private tail = ""
  private inThink = false

  /** 喂一段 content 增量，返回两路各自要下发的纯文本（可为空串）。 */
  feed(delta: string): ThinkSplit {
    const window = this.tail + delta
    this.tail = ""
    let text = ""
    let reasoning = ""
    let i = 0
    for (;;) {
      if (i >= window.length) break
      if (this.inThink) {
        const close = window.indexOf(CLOSE, i)
        if (close < 0) break
        reasoning += window.slice(i, close)
        this.inThink = false
        i = close + CLOSE.length
        continue
      }
      const open = window.indexOf(OPEN, i)
      const close = window.indexOf(CLOSE, i)
      if (open >= 0 && (close < 0 || open < close)) {
        text += window.slice(i, open)
        this.inThink = true
        i = open + OPEN.length
        continue
      }
      if (close >= 0) {
        // 孤立闭标签：只丢标签，前后都是正文。
        text += window.slice(i, close)
        i = close + CLOSE.length
        continue
      }
      break
    }
    if (i < window.length) {
      const rest = window.slice(i)
      const hold = holdbackLength(rest)
      const release = rest.slice(0, rest.length - hold)
      if (this.inThink) reasoning += release
      else text += release
      this.tail = rest.slice(rest.length - hold)
    }
    return { text, reasoning }
  }

  /**
   * 流（或 text part）收尾时调用：放行悬挂尾窗。已开未闭的 think 块保持开启
   * （跨 part 的内联思考合法），调用方按返回值路由后自行决定何时收推理块。
   */
  flush(): ThinkSplit {
    const held = this.tail
    this.tail = ""
    if (!held) return { text: "", reasoning: "" }
    return this.inThink ? { text: "", reasoning: held } : { text: held, reasoning: "" }
  }
}
