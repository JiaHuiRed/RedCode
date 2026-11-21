/**
 * Removes formulaic assent from assistant prose before display.
 * This is presentation-only: stored text, tool output and user messages are untouched.
 * Literal contexts — fenced/indented/quoted lines, inline code and quotation marks — are preserved.
 * A matched clause is dropped whole so the remaining sentence still reads.
 */
const ASSENT = /(?:你|您|哥哥|哥)说[得的]对[ \t]*$/
const ACCEPT = /(?:这个|这点|这回|这事|这次)?我认$/
// 261115 Red：条件/让步从句里的「说得对」不是机械附和——整句删除会把条件前提
// 一并抹掉，剩下的断言读起来变成无条件成立（审查实例：「如果你说得对，我们再看
// 数据。」曾整段删成「我们再看数据。」）。同一从句里出现这些引导词就原样保留。
const CONDITIONAL =
  /(?:如果|假如|假使|要是|若是|倘若|即使|即便|就算|哪怕|虽然|虽说|只要|除非|既然|因为|不论|不管|无论)/
const TRAILING = /[，,。！!？?；;：:\s]+$/
const BOUNDARY = new Set(["，", ",", "。", "！", "!", "？", "?", "；", ";", "：", ":"])
const HAN = /\p{Script=Han}/u
const QUOTES: Record<string, string> = { '“': '”', '「': '」', '『': '』', '‘': '’', '"': '"' }
const LIST = /^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+)/

const GEGE = /^(?:哥哥|哥)[，,][ \t]*$/

function stripLine(line: string): string {
  const lead = LIST.exec(line)?.[0] ?? ""
  let out = ""
  let clause = ""
  let dirty = false
  let quote: string | undefined
  let tick = false
  const check = () => {
    const statement = clause.replace(TRAILING, "")
    if (!statement) return
    if (CONDITIONAL.test(statement)) return
    if (ASSENT.test(statement) || ACCEPT.test(statement)) dirty = true
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
  const body = out.replace(GEGE, "")
  if (!body.trim()) return ""
  return lead ? lead + body : body
}

type LineState = {
  fence: { marker: string; length: number } | undefined
  closeQuote: string | undefined
}

/** 单行变换：围栏/引号状态由调用方持有；commit=false 只预览未结束行，不推进状态。 */
function transformLine(line: string, state: LineState, commit: boolean): string {
  const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1]
  if (marker) {
    if (commit) {
      if (!state.fence) state.fence = { marker: marker[0]!, length: marker.length }
      else if (marker[0] === state.fence.marker && marker.length >= state.fence.length) state.fence = undefined
    }
    return line
  }
  if (state.fence) return line
  const literal = state.closeQuote || /^\s*>/.test(line) || /^(?: {4}|\t)/.test(line)
  const next = literal ? line : stripLine(line)
  // Track quotation scope using original text so multiline quotations survive.
  if (commit) {
    for (const character of line) {
      if (state.closeQuote) {
        if (character === state.closeQuote) state.closeQuote = undefined
      } else if (character in QUOTES) state.closeQuote = QUOTES[character]
    }
  }
  return next
}

/**
 * Safe on accumulated streaming text: no cross-chunk state is required.
 * Fenced/indented/quoted text and prose discussing the phrase are untouched.
 */
export function filterCannedAgreement(text: string): string {
  if (!text.includes("说") && !text.includes("我认")) return text
  const state: LineState = { fence: undefined, closeQuote: undefined }
  return text.split("\n").map((line) => transformLine(line, state, true)).join("\n")
}

/**
 * 261120 Red 流式增量版：按 part 保存已完成行的结果与围栏/引号状态，每次只处理新增的完整行，
 * 未结束行按当前状态预览、不提交状态。替换快照（文本不再是上一份的延长）整体重建；全文首次
 * 出现触发词时回扫之前的行，与 filterCannedAgreement 的全文口径逐字一致。
 * 依据 → docs/audits/2026-11-20-redspace-windows-performance-audit.md §3
 *
 * 261121 Red 单行增量化（方案三）：0.20.0 的版本每个流式更新都把整段未换行文本重跑
 * transformLine——同样长的中文，换行频率直接决定累计开销（同输入实测：分行 9.2ms vs
 * 单行 349.8ms）。现在把 stripLine 的逐字扫描拆成「已结算前缀 + 活跃分句」：
 *   · 分句命运在边界符（，。！？等）到达时即定，可安全提交缓存；
 *   · 活跃分句保留完整状态（dirty/引号/反引号），允许后续输入重新解释（「我认」补成
 *     「我认得」），只有语义确定的边界才提交；
 *   · 行首歧义（列表前导/围栏标记/缩进与引用字面量/数字前导）由一个小型判定机 hold 住，
 *     判定前不提交任何字符——判定本身是确定性的（见 stepUndecided 的分支与注释）；
 *   · 预览 = 已结算输出 + 活跃分句按行尾规则的一次性假想 flush，与全文版逐前缀逐字相等
 *     （canned-agreement.test.ts 逐前缀与随机模糊等价性用例覆盖）。
 * 仍然 O(行长/更新) 的残余：整行没有任何边界符的极端输入（活跃分句无限增长）——按方案三
 * 验收口径另列基准单独评估。依据 → .redcode/temp/RedSpace-四项体验改进方案.md 方案三
 */

type LineScan = {
  /** 已结算输出（不含行首列表前导）：遇到边界符的分句命运已定。 */
  committed: string
  /** 活跃分句：后续输入仍可能改写结果，不缓存。 */
  clause: string
  dirty: boolean
  tick: boolean
  quote: string | undefined
}

type Undecided = {
  buffer: string
  spaces: number
  sawTab: boolean
  hashes: number
  digits: number
  afterNum: boolean
  marker: string | undefined
  fenceChar: string | undefined
  fenceRun: number
}

type ActiveLine =
  | { kind: "undecided"; pos: number; state: Undecided }
  | { kind: "literal"; pos: number }
  | { kind: "scan"; pos: number; lead: string; scan: LineScan }

const freshScan = (): LineScan => ({ committed: "", clause: "", dirty: false, tick: false, quote: undefined })

/** 行级结算规则与 stripLine 的 flush 相同：哥哥/哥单独称呼行整行丢弃。 */
const lineResult = (lead: string, body: string) => {
  const replaced = body.replace(GEGE, "")
  if (!replaced.trim()) return ""
  return lead ? lead + replaced : replaced
}

const checkClause = (s: LineScan) => {
  const statement = s.clause.replace(TRAILING, "")
  if (!statement) return
  if (CONDITIONAL.test(statement)) return
  if (ASSENT.test(statement) || ACCEPT.test(statement)) s.dirty = true
}

/** 活跃分句若此刻行尾 flush，是否会被丢弃——预览用，不改状态。 */
const flushWouldDrop = (s: LineScan) => {
  if (s.dirty) return true
  const statement = s.clause.replace(TRAILING, "")
  if (!statement) return false
  if (CONDITIONAL.test(statement)) return false
  return ASSENT.test(statement) || ACCEPT.test(statement)
}

/** 边界符到达：分句命运已定，连同边界符一起提交或丢弃。 */
const settle = (s: LineScan) => {
  if (!s.dirty) s.committed += s.clause
  s.clause = ""
  s.dirty = false
}

/** stripLine 逐字扫描的单字推进，状态外置以便增量复用。 */
const feedChar = (s: LineScan, ch: string) => {
  if (s.tick) {
    s.clause += ch
    if (ch === "`") s.tick = false
    return
  }
  if (s.quote) {
    s.clause += ch
    if (ch === s.quote) s.quote = undefined
    return
  }
  if (ch === "`") {
    s.tick = true
    s.clause += ch
    return
  }
  if (ch in QUOTES) {
    s.quote = QUOTES[ch]
    s.clause += ch
    return
  }
  if (BOUNDARY.has(ch)) {
    checkClause(s)
    s.clause += ch
    settle(s)
    return
  }
  if (!HAN.test(ch) && ACCEPT.test(s.clause)) s.dirty = true
  s.clause += ch
  if (ch === "对" || ch === " " || ch === "\t") checkClause(s)
}

/**
 * 行首判定机：列表前导（LIST）、围栏标记（``` / ~~~）、缩进与引用字面量（4 空格 / Tab / >）、
 * 数字前导（「12. 」）都只看行首。判定前的字符全部 hold 在 buffer 里不提交——「12.5」和
 * 「12. 」的分水岭在「.」之后的那个字符上，提前提交任何一边都会与全文版分叉。
 * 返回 keep=继续 hold（ch 已并入 buffer）。
 */
const stepUndecided = (u: Undecided, ch: string): { keep: true } | { keep: false; to: "literal" } | { keep: false; to: "lead" } | { keep: false; to: "feed" } => {
  const free = u.digits === 0 && u.hashes === 0 && !u.marker && !u.afterNum && !u.fenceChar
  if (ch === " " || ch === "\t") {
    if (u.marker) return { keep: false, to: "lead" }
    if (u.afterNum) return { keep: false, to: "lead" }
    if (u.hashes > 0) return { keep: false, to: "lead" } // ≤6 由第 7 个 # 分支保证
    if (u.fenceRun > 0) return { keep: false, to: "feed" } // 围栏 run 被空白打断，标记不可能
    if (u.digits > 0) return { keep: false, to: "feed" } // \d[.)]\s+ 需要 [.)]，纯数字不是前导
    if (ch === "\t") {
      // 字面量判定是 ^(?: {4}|\t)：tab 必须是行首第一个字符；空格后的 tab 只是
      // LIST \s* 的一部分，且从此 4 空格缩进不可能再成立。
      if (u.spaces === 0) return { keep: false, to: "literal" }
      u.sawTab = true
      return { keep: true }
    }
    if (!u.sawTab) u.spaces++
    if (!u.sawTab && u.spaces >= 4) return { keep: false, to: "literal" }
    return { keep: true }
  }
  if (ch === ">") return free ? { keep: false, to: "literal" } : { keep: false, to: "feed" }
  if (u.fenceChar && ch === u.fenceChar) {
    u.fenceRun++
    return u.fenceRun >= 3 ? { keep: false, to: "literal" } : { keep: true }
  }
  if ((ch === "`" || ch === "~") && free) {
    u.fenceChar = ch
    u.fenceRun = 1
    return { keep: true }
  }
  if (ch === "#" && free) {
    u.hashes++
    return u.hashes > 6 ? { keep: false, to: "feed" } : { keep: true }
  }
  if ((ch === "-" || ch === "*" || ch === "+") && free) {
    u.marker = ch
    return { keep: true }
  }
  if (ch >= "0" && ch <= "9" && free) {
    u.digits++
    return { keep: true }
  }
  if ((ch === "." || ch === ")") && u.digits > 0 && !u.afterNum) {
    u.afterNum = true
    return { keep: true }
  }
  return { keep: false, to: "feed" }
}

export function createCannedAgreementFilter() {
  let key: string | undefined
  let source = ""
  let output = ""
  let rest = ""
  let triggered = false
  let state: LineState = { fence: undefined, closeQuote: undefined }
  let active: ActiveLine | undefined

  const reset = () => {
    source = ""
    output = ""
    rest = ""
    triggered = false
    state = { fence: undefined, closeQuote: undefined }
    active = undefined
  }

  /** 解算行尾：flush 活跃分句、按行级规则出结果，并推进跨行围栏/引号状态（与 transformLine 的 commit 块逐字一致）。 */
  const completeLine = (raw: string): string => {
    feedTo(raw, raw.length)
    let result: string
    if (!active || active.kind === "literal") {
      result = raw
    } else {
      let scan: LineScan
      let lead = ""
      if (active.kind === "undecided") {
        // 行尾仍处歧义：按无前导内容解算（歧义缓冲不可能构成前导/字面量——见 stepUndecided 分支）
        scan = freshScan()
        for (const ch of active.state.buffer) feedChar(scan, ch)
      } else {
        scan = active.scan
        lead = active.lead
      }
      checkClause(scan)
      if (!scan.dirty) scan.committed += scan.clause
      result = lineResult(lead, scan.committed)
    }
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1]
    if (marker) {
      if (!state.fence) state.fence = { marker: marker[0]!, length: marker.length }
      else if (marker[0] === state.fence.marker && marker.length >= state.fence.length) state.fence = undefined
    } else {
      for (const character of raw) {
        if (state.closeQuote) {
          if (character === state.closeQuote) state.closeQuote = undefined
        } else if (character in QUOTES) state.closeQuote = QUOTES[character]
      }
    }
    active = undefined
    return result
  }

  /** 把 raw 的 [pos, end) 区间喂给活跃行；解算分支在扫描器上就地生效。 */
  const feedTo = (raw: string, end: number) => {
    if (active === undefined) {
      active = state.fence || state.closeQuote ? { kind: "literal", pos: 0 } : { kind: "undecided", pos: 0, state: { buffer: "", spaces: 0, sawTab: false, hashes: 0, digits: 0, afterNum: false, marker: undefined, fenceChar: undefined, fenceRun: 0 } }
    }
    if (active.kind === "literal") {
      active.pos = end
      return
    }
    while (active.pos < end) {
      // 按码点推进（与 stripLine 的 for..of 口径一致），pos 记 UTF-16 单元偏移
      const ch = String.fromCodePoint(raw.codePointAt(active.pos)!)
      if (active.kind === "undecided") {
        const decision = stepUndecided(active.state, ch)
        if (decision.keep) {
          active.state.buffer += ch
          active.pos += ch.length
          continue
        }
        if (decision.to === "literal") {
          active = { kind: "literal", pos: end }
          return
        }
        // feed/lead：feed 时缓冲区交给扫描器（ch 本身留在原位由扫描器吃掉）；
        // lead 时缓冲区连同 ch 一起成为前导，扫描器从零开始。
        const isLead = decision.to === "lead"
        const scan = freshScan()
        if (!isLead) for (const c of active.state.buffer) feedChar(scan, c)
        const lead: string = isLead ? active.state.buffer + ch : ""
        active = { kind: "scan", pos: active.pos + (isLead ? ch.length : 0), lead, scan }
        continue
      }
      feedChar(active.scan, ch)
      active.pos += ch.length
    }
  }

  const raw = (text: string) => !text.includes("说") && !text.includes("我认")

  return {
    update(nextKey: string, text: string): string {
      if (nextKey !== key) {
        key = nextKey
        reset()
      }
      if (!triggered) {
        // 纯函数全文无触发词时原样返回；这里同样先不处理，等首次触发再回扫。
        if (raw(text)) {
          source = text
          return text
        }
        reset()
        triggered = true
      } else if (!text.startsWith(source)) {
        reset()
        if (raw(text)) {
          source = text
          return text
        }
        triggered = true
      }
      if (text !== source) {
        const parts = (rest + text.slice(source.length)).split("\n")
        rest = parts.pop() ?? ""
        for (const line of parts) output += completeLine(line) + "\n"
        feedTo(rest, rest.length)
        source = text
      }
      return preview()
    },
  }

  function preview(): string {
    if (rest === "") return output
    if (!active || active.kind === "literal") return output + rest
    if (active.kind === "undecided") {
      // 歧义缓冲只含前导候选字符（数字/#/前导符/空白/反引号 run），不含「说」「我认」，
      // 全文版对它不会做任何分句丢弃；唯一差异是纯空白缓冲按空 body 整行丢弃
      // （stripLine 的 !body.trim() 口径）。其余情况原样返回 buffer。
      return output + (active.state.buffer.trim() ? active.state.buffer : "")
    }
    const s = active.scan
    const body = (s.committed + (flushWouldDrop(s) ? "" : s.clause)).replace(GEGE, "")
    if (!body.trim()) return output
    return output + (active.lead ? active.lead + body : body)
  }
}
