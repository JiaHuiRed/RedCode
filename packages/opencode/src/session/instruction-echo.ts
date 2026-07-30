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

const EMPTY: string[] = []

// ── A 类：我们自己注入的包装块，整块剥离 ────────────────────────────
const OWN_BLOCKS: Array<[string, RegExp]> = [
  ["system-reminder", /<system-reminder>[\s\S]*?<\/system-reminder>\s*/g],
  ["reasoning-language", /<reasoning-language>[\s\S]*?<\/reasoning-language>\s*/g],
  // [System notice] 是 text-loop-detection 与 reasoning-only 兜底注入的前缀，
  // 没有闭合标签，切到空行为止 —— 那几条注入本身都是单段。
  ["system-notice", /^\s*\[System notice\][^\n]*(?:\n(?!\n)[^\n]*)*\n?/gm],
]

// ── B 类：工具说明 / schema 的行级特征 ──────────────────────────────
// 单行判定，用于识别"连续成片"的泄漏；单独一行命中不足以判定。
const SCHEMA_LINE = [
  /^\s*"?[A-Za-z_][A-Za-z0-9_]*"?\s*:\s*(string|number|boolean|object|array)\s*,?\s*(\/\/.*)?$/, // "startId": string, // …
  /^\s*[-*]\s+(Do not|Pick|IDs must|Use only|Never|Always)\b/, // - Do not invent IDs.
  /^\s*(RULES|BATCHING|THE FORMAT OF [A-Z ]+|OUTPUT FORMAT|IMPORTANT NOTES)\s*:?\s*$/, // 全大写指令段标题
  /^\s*Rules:\s*$/,
]
// 至少要有一条"强特征"才认，避免把普通 JSON 讨论误判
const SCHEMA_STRONG = [
  /^\s*(RULES|BATCHING|THE FORMAT OF [A-Z ]+|OUTPUT FORMAT)\s*:?\s*$/,
  /^\s*[-*]\s+(Do not invent|IDs must exist|Pick startId)/,
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
export function detect(text: string): EchoResult {
  if (!text) return { kinds: EMPTY, stripped: text }
  const suspicious =
    text.includes("<system-reminder>") ||
    text.includes("<reasoning-language>") ||
    text.includes("[System notice]") ||
    text.includes("Rules:") ||
    text.includes("BATCHING") ||
    text.includes("THE FORMAT OF") ||
    /"\w+"\s*:\s*(string|number|boolean)\b/.test(text)
  if (!suspicious) return { kinds: EMPTY, stripped: text }

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
  const schema = stripSchemaRuns(out)
  if (schema.hit) {
    out = schema.text
    kinds.push("tool-schema")
  }

  if (kinds.length === 0) return { kinds: EMPTY, stripped: text }
  return { kinds, stripped: out.replace(/\n{3,}/g, "\n\n").trim() }
}
