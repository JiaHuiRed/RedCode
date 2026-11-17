// 261024 Red 部分 OpenAI 兼容模型（step-5-preview 实测，DeepSeek-R1 同款模板）把推理以
// `<think>…</think>` 内联在 content 通道输出，而协议层（openai-chat.ts）只把
// `reasoning_content` 字段映射成推理事件——内联块整段漏进正文，TUI/GUI 里思考链变正文、
// 收尾还带字面 `</think>`。这个扫描器把 content 增量流拆成 text / reasoning 两路：
// 开标签后进推理路，闭标签回文本路；孤立闭标签（serving 模板把 </think> 当普通 token
// 泄出的形态）只丢标签本身，已流出的文本无法也不应回捞。
//
// 与 instruction-echo 的 LeakAnchorScanner 同一类「尾窗缓冲」手法：可能构成标签前缀的
// 尾巴（≤最长标签长度）扣到下一条增量再判，标签跨增量分裂也能命中。模型不吐这些标签时
// 除尾窗延迟外零影响。
//
// 261113 Red 追加 `<analysis>`→`</summary>` 一组：opencode-go 的 deepseek-v4.1-flash 在
// 长上下文里把历史会话摘要整段当正文输出（实测 ses_ffe5e308… 的 msg_001a1d1f6d4b1001：
// `<analysis>` 开头、`</summary>` 结尾、8245 output token、reasoning=0，用户只看到一坨
// 总结然后回合结束）。这组标签不是正常正文会出现的结构，整段归推理通道即可；闭合配
// `</summary>` 而不是 `</analysis>`，否则中间的 summary 段会漏回正文。

type Pair = { readonly open: string; readonly close: string; readonly atStartOnly?: boolean }

const PAIRS: ReadonlyArray<Pair> = [
  { open: "<think>", close: "</think>" },
  // atStartOnly：对照 <analysis> 只在回复第一个字节处才认。261113 实测踩过——正文里
  // 讨论这个标签（"原来只认 `<analysis>`…"）会被误当成通道标签，把后半段正文切进
  // reasoning（本会话 msg_001a1d200b1f5001：text 245B + 被切的 reasoning 545B）。
  // 真泄漏形态是模型从第一个 token 就开始吐它，开头判定足够。
  { open: "<analysis>", close: "</summary>", atStartOnly: true },
]
const TAGS = PAIRS.flatMap((pair) => [pair.open, pair.close])
const TAG_MAX = TAGS.reduce((max, tag) => Math.max(max, tag.length), 0)

/** 悬挂尾窗里最长、且恰好是某个标签前缀的后缀长度；没有则 0。 */
function holdbackLength(rest: string): number {
  const max = Math.min(TAG_MAX, rest.length)
  for (let k = max; k > 0; k--) {
    const suffix = rest.slice(-k)
    if (TAGS.some((tag) => tag.startsWith(suffix))) return k
  }
  return 0
}

type Match = { index: number; pair: Pair }

/** 最近的开启标签；atStartOnly 组还要求标签本身出现在窗口第 0 字节（真泄漏是从首 token 开始）。 */
function earliestOpen(window: string, from: number, atStartAllowed: boolean): Match | undefined {
  let best: Match | undefined
  for (const pair of PAIRS) {
    const index = window.indexOf(pair.open, from)
    if (index < 0) continue
    if (pair.atStartOnly && (!atStartAllowed || index !== 0)) continue
    if (!best || index < best.index) best = { index, pair }
  }
  return best
}

/** 正文中的孤立闭合标签；atStartOnly 组的闭合只在对应通道内部识别。 */
function earliestClose(window: string, from: number): Match | undefined {
  let best: Match | undefined
  for (const pair of PAIRS) {
    if (pair.atStartOnly) continue
    const index = window.indexOf(pair.close, from)
    if (index >= 0 && (!best || index < best.index)) best = { index, pair }
  }
  return best
}

export type ThinkSplit = { text: string; reasoning: string }

export class ThinkTagScanner {
  private tail = ""
  private active: Pair | undefined
  private emitted = false

  /** 喂一段 content 增量，返回两路各自要下发的纯文本（可为空串）。 */
  feed(delta: string): ThinkSplit {
    const window = this.tail + delta
    this.tail = ""
    let text = ""
    let reasoning = ""
    let i = 0
    for (;;) {
      if (i >= window.length) break
      if (this.active) {
        const close = window.indexOf(this.active.close, i)
        if (close < 0) break
        reasoning += window.slice(i, close)
        i = close + this.active.close.length
        this.active = undefined
        continue
      }
      const open = earliestOpen(window, i, !this.emitted)
      const close = earliestClose(window, i)
      if (open && (!close || open.index < close.index)) {
        text += window.slice(i, open.index)
        this.active = open.pair
        i = open.index + open.pair.open.length
        continue
      }
      if (close) {
        // 孤立闭标签：只丢标签，前后都是正文。
        text += window.slice(i, close.index)
        i = close.index + close.pair.close.length
        continue
      }
      break
    }
    if (i < window.length) {
      const rest = window.slice(i)
      const hold = holdbackLength(rest)
      const release = rest.slice(0, rest.length - hold)
      if (this.active) reasoning += release
      else text += release
      this.tail = rest.slice(rest.length - hold)
    }
    if (text || reasoning) this.emitted = true
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
    return this.active ? { text: "", reasoning: held } : { text: held, reasoning: "" }
  }
}
