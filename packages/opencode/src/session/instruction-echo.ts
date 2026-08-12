// 260729 Red 把"注入给模型看的指令"当成"要输出的内容"复述出来 —— 与 xml-tool-call.ts
// 同一类病，但形态不同、可切除性也不同，所以单独一个模块。
//
// 实测形态（哥哥 0.8.1 家用机截图）：DCP `compress` 工具的说明文字整段进了可见正文 ——
// `Rules:` / `- Do not invent IDs.` / `BATCHING` / `THE FORMAT OF COMPRESS` 加一段
// JSON schema（`"startId": string, // Boundary ID at range start`）。用户看到的就是一屏
// 本该只给模型看的东西。
//
// xml-tool-call.ts 管不住它：那边靠 `<function=` 子串触发，而这里一个尖括号标签都没有。
//
// 分两类处理，因为能不能安全切干净差别很大：
//
//   A. **我们自己注入的包装块** —— `<system-reminder>…</system-reminder>`、
//      `<reasoning-language>…</reasoning-language>`、`[System notice] …`。
//      这些有明确起止，模型复述它们永远是错的（那是给它的指令，不是给用户的话），
//      可以整块剥掉，零歧义。
//
//   B. **工具说明 / JSON schema** —— 没有闭合标签，边界靠猜。**只做行级判定**：
//      连续若干行都长得像 schema/指令清单才切，且要求命中多个特征、
//      避免把"用户正常讨论 JSON 字段"误判成泄漏。宁可漏切，不可错切 ——
//      错切会吃掉真正的回答内容，比留着泄漏更糟。

export interface EchoResult {
  /** 命中的类别，便于日志定位；空数组表示没命中 */
  readonly kinds: string[]
  /** 剥离后的正文；无命中时与入参同一个字符串 */
  readonly stripped: string
}

// 260812 cc 流式拦截用：DCP reminder 泄露锚点（processor.ts text-delta 路径每段检查，
// 命中即中断+剥离，防止 GUI 无限刷屏）。泄露是消息尾部复述循环，锚点出现=已泄露。
export function hasLeakAnchor(text: string): boolean {
  return text.includes("compressible ranges") || text.includes("This is a system reminder injected")
}

const EMPTY: string[] = []

// ── A 类：我们自己注入的包装块，整块剥离 ────────────────────────────
// ── A 类：我们自己注入的包装块，整块剥离 ────────────────────────────
const OWN_BLOCKS: Array<[string, RegExp]> = [
  ["system-reminder", /<system-reminder>[\s\S]*?<\/system-reminder>\s*/g],
  ["reasoning-language", /<reasoning-language>[\s\S]*?<\/reasoning-language>\s*/g],
  // 260803 Red DCP 插件的消息元数据标签：有闭合标签，模型复述永远是错的，同 A 类整块剥。
  // 实测（哥哥另一工作区）：正文结尾偶现 `<m0364</m0364>` —— 模型把消息尾部
  // 的 <dcp-message-id> 元数据抄进了可见正文。
  ["dcp-message-id", /<dcp-message-id>[\s\S]*?<\/dcp-message-id>\s*/g],
  ["dcp-system-reminder", /<dcp-system-reminder>[\s\S]*?<\/dcp-system-reminder>\s*/g],
  // [System notice] 是 text-loop-detection 与 reasoning-only 兜底注入的前缀，
  // 没有闭合标签，切到空行为止 —— 那几条注入本身都是单段。
  ["system-notice", /^\s*\[System notice\][^\n]*(?:\n(?!\n)[^\n]*)*\n?/gm],
]

// ── C 类：DCP turn-nudge 指令被复述（260810 哥哥 G:\Game 会话实测）──
// DCP 每轮注入 system prompt 的 nudge（"Evaluate the conversation for
// compressible ranges..."）。deepseek-v4-flash 把它复述进正文，且是
// 转述改写版（cleanly closed→closed、direction has shifted→getting
// long、Do not repeat, quote, or echo→Do not amplify or repeat），所以
// B 类的行级特征匹配不上。锚点句逐字稳定，从锚点剥到块的合理结尾。
// 误切防护：锚点句是 DCP 独有措辞，用户正常讨论压缩不会这么写。
const NUDGE_ANCHOR = /^\s*Evaluate the conversation for compressible ranges\.?\s*$/m
// 块终止：Keep active context uncompressed. 之后还有 NO_REPEAT 变体行
// （"Do not output the reminder text" 等），一起剥掉
const NUDGE_END = /^\s*Keep active context uncompressed\.?\s*$/m
// 260812 cc DCP reminder 复述循环变体：deepseek-v4-flash 把另一种 reminder 措辞
// （"This is a system reminder injected to help you manage context. The conversation
// is running long..."）原样复述且陷入无限重复（哥哥 GUI 实测，同段文本重复 N 次）。
// 与 NUDGE_ANCHOR 一样是 DCP 独有措辞，用户正文不会这么写；命中即剥到文尾——
// 这种形态一旦出现就是模型陷入复述循环，锚点后面只会是更多重复。
const REMINDER_ANCHOR = /^\s*This is a system reminder injected to help you manage context\.?\s*/m

function stripReminderLoop(text: string): { text: string; hit: boolean } {
  const anchor = text.search(REMINDER_ANCHOR)
  if (anchor === -1) return { text, hit: false }
  const lineStart = text.lastIndexOf("\n", anchor) + 1
  return { text: text.slice(0, lineStart).replace(/\s+$/, ""), hit: true }
}

function stripDcpNudge(text: string): { text: string; hit: boolean } {
  const anchor = text.search(NUDGE_ANCHOR)
  if (anchor === -1) return { text, hit: false }
  // 从锚点行行首开始（search 返回行首，但保险起见回退到本行开头）
  const lineStart = text.lastIndexOf("\n", anchor) + 1
  // 260812 cc 统一剥到文尾：DCP nudge 泄露是"消息尾部复述循环"形态——模型输出快结束时
  // 陷入对 reminder 的复述，锚点之后全是改写变体/重复行（NO_REPEAT 变体、execute the
  // compress action 续行、小写 do not 变体…），行级正则永远吞不干净（实测留尾巴）。
  // 正文必然在锚点之前，剥到文尾零误伤；endMatch 分支保留只为兼容旧测试。
  const endMatch = text.search(NUDGE_END)
  if (endMatch !== -1) {
    // 保险：若 END 之后有明显正文段落（\n\n 后非指令行），只剥到 END 后指令行为止
    const after = text.slice(endMatch)
    const body = after.match(/\n\n([A-Z\u4e00-\u9fff][^\n]{10,})/)
    if (body) {
      const end = after.indexOf(body[1])
      if (end > 0) return { text: (text.slice(0, lineStart) + after.slice(0, end)).replace(/\s+$/, ""), hit: true }
    }
  }
  return { text: text.slice(0, lineStart).replace(/\s+$/, ""), hit: true }
}

// ── B 类：工具说明 / schema 的行级特征 ──────────────────────────────
// 单行判定，用于识别"连续成片"的泄漏；单独一行命中不足以判定。
const SCHEMA_LINE = [
  /^\s*"?[A-Za-z_][A-Za-z0-9_]*"?\s*:\s*(string|number|boolean|object|array)\s*,?\s*(\/\/.*)?$/, // "startId": string, // …
  /^\s*[-*]\s+(Do not|Pick|IDs must|Use only|Never|Always)\b/, // - Do not invent IDs.
  /^\s*(RULES|BATCHING|THE FORMAT OF [A-Z ]+|OUTPUT FORMAT|IMPORTANT NOTES)\s*:?\s*$/, // 全大写指令段标题
  /^\s*Rules:\s*$/,
  /^\s*Compressed block description:/, // DCP compress 工具的输出泄漏
  /^\s*Compressed block context:/, // 260812 实测变体：compress 工具说明的 context 段也被复述
]
// 至少要有一条"强特征"才认，避免把普通 JSON 讨论误判
const SCHEMA_STRONG = [
  /^\s*(RULES|BATCHING|THE FORMAT OF [A-Z ]+|OUTPUT FORMAT)\s*:?\s*$/,
  /^\s*[-*]\s+(Do not invent|IDs must exist|Pick startId)/,
  /^\s*Compressed block description:/, // DCP compress 工具的输出泄漏
  /^\s*Compressed block context:/, // 260812 实测变体
]
const MIN_RUN = 3 // 连续 3 行以上才切

function stripSchemaRuns(text: string): { text: string; hit: boolean } {
  const lines = text.split("\n")
  const isSchema = lines.map((l) => SCHEMA_LINE.some((re) => re.test(l)))
  const isStrong = lines.map((l) => SCHEMA_STRONG.some((re) => re.test(l)))
  const drop = new Array(lines.length).fill(false)
  let hit = false

  let i = 0
  while (i < lines.length) {
    if (!isSchema[i]) {
      i++
      continue
    }
    let j = i
    // 允许成片中间夹空行与纯符号行（`{` / `}` / ``` 之类），不打断连续性
    while (j < lines.length && (isSchema[j] || /^\s*([{}[\]`]+|)\s*$/.test(lines[j]))) j++
    const run = lines.slice(i, j)
    const schemaCount = run.filter((_, k) => isSchema[i + k]).length
    const hasStrong = run.some((_, k) => isStrong[i + k])
    if (schemaCount >= MIN_RUN && hasStrong) {
      for (let k = i; k < j; k++) drop[k] = true
      hit = true
    }
    i = j > i ? j : i + 1
  }

  if (!hit) return { text, hit: false }
  return { text: lines.filter((_, k) => !drop[k]).join("\n"), hit: true }
}

/**
 * 检测并剥离模型复述出来的注入指令。
 * 快路径：正文里没有任何可疑标记时直接返回原串，不做逐行扫描。
 */
export function detect(text: string): EchoResult {  if (!text) return { kinds: EMPTY, stripped: text }
  const suspicious =
    text.includes("<system-reminder>") ||
    text.includes("<reasoning-language>") ||
    text.includes("") ||
    text.includes("") ||
    text.includes("[System notice]") ||
    text.includes("Rules:") ||
    text.includes("BATCHING") ||
    text.includes("THE FORMAT OF") ||
    text.includes("Compressed block description:") ||
    text.includes("compressible ranges") || // DCP turn-nudge 复述（260810）
    text.includes("This is a system reminder injected") || // DCP reminder 复述循环（260812）
    /"\w+"\s*:\s*(string|number|boolean)\b/.test(text)

  const kinds: string[] = []
  let out = text
  for (const [kind, re] of OWN_BLOCKS) {
    re.lastIndex = 0
    if (re.test(out)) {
      re.lastIndex = 0
      out = out.replace(re, "")
      kinds.push(kind)
    }
  }
  const reminder = stripReminderLoop(out)
  if (reminder.hit) {
    out = reminder.text
    kinds.push("dcp-reminder")
  }
  const nudge = stripDcpNudge(out)
  if (nudge.hit) {
    out = nudge.text
    kinds.push("dcp-nudge")
  }
  const schema = stripSchemaRuns(out)
  if (schema.hit) {
    out = schema.text
    kinds.push("tool-schema")
  }

  if (kinds.length === 0) return { kinds: EMPTY, stripped: text }
  return { kinds, stripped: out.replace(/\n{3,}/g, "\n\n").trim() }
}
