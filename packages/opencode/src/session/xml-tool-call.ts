// 260728 Red 文本态工具调用打捞（step-3.7-flash 偶发退化）
//
// 症状：模型该走原生 tool_calls 通道时，改成把 Qwen/Hermes 式 XML 当普通文本吐出来：
//   <tool_call>
//   <function=bash>
//   <parameter=command>
//   ls -la
//   </parameter>
//   </function>
//   </tool_call>
// 这种调用永远不会被执行，本轮直接白跑，用户只看到一坨标签。
//
// 实测（redcode.db 近 14 天）：14 次泄漏 100% 来自 step-3.7-flash，
// deepseek-v4-flash(4608 条)/gpt-5.6-luna(902 条)/kimi-k3(103 条) 全为 0。
// 落 reasoning part 还是 text part 纯看模型断在哪个通道（6/14 vs 8/14），
// 所以「空回复」和「标签泄漏」是同一个根因的两个面。
//
// 本模块只负责“认出来 + 摘干净”，不负责执行 —— 默认 ai-sdk 运行时里工具是
// streamText 内部执行的，processor 拿到的只是事件流。凭空合成 tool-call 事件
// 会造出永远不会 settle 的 running part，还绕过 permission.ask。
// 正确做法是把解析结果回灌给模型，让它用原生通道重发一次（见 prompt.ts）。

export interface ParsedCall {
  readonly name: string
  readonly params: Record<string, string>
}

export interface DetectResult {
  readonly calls: ParsedCall[]
  /** 摘掉 XML 之后的正文；无命中时与入参同一个字符串 */
  readonly stripped: string
}

const EMPTY: DetectResult["calls"] = []

const FUNCTION_OPEN = /<function=([A-Za-z0-9_.-]{1,64})>/g
const PARAMETER = /<parameter=([A-Za-z0-9_.-]{1,64})>([\s\S]*?)<\/parameter>/g

// 260730 Karina 第二种形状。step-3.7-flash 07-30 实测吐的不是 <function=…>，而是
//   <edit>
//     <args>
//       <filePath>…</filePath>
//       <oldString>…</oldString>
//     </args>
//   </edit>
// 上面那套只认 <function=，快路径第一行就短路返回了 —— 于是既没打捞也没摘除，
// 原始 XML 原样留在正文里，本轮零个 tool part 却是 finish:stop，看起来就像"它自己停了"。
// 实际那一轮：step-start reasoning(778) text(261) step-finish。
//
// 误判防线是双重的：标签名必须是**真实注册的工具名**，而且紧跟着必须是 <args>。
// 只要一个条件（比如通用的 <xxx><yyy> 匹配）就会误伤正文里讨论 XML、粘贴 HTML 片段的情况。
const ARGS_OPEN = /<([A-Za-z0-9_.-]{1,64})>\s*<args>/g
// 反向引用 \1 是关键：参数值里常带别的标签（实测 oldString 里就有 </tr></thead>），
// 靠"闭合标签必须同名"才能非贪婪地切在正确位置。
const ARG_FIELD = /<([A-Za-z0-9_.-]{1,64})>([\s\S]*?)<\/\1>/g

/** 去掉紧贴标签的一对换行，其余空白（缩进、代码块内的空行）原样保留 */
function trimValue(raw: string): string {
  return raw.replace(/^\r?\n/, "").replace(/\r?\n$/, "")
}

/**
 * 从一段文本里认出文本态工具调用。
 *
 * @param known 已注册的工具名集合。只有名字对得上的才算命中 —— 这是主要的误判防线：
 *              讨论这个 bug 本身、或粘贴别处日志时，正文里同样会出现 <tool_call> 字样。
 *              传 undefined 表示不做名字校验（仅供单测用）。
 */
export function detect(text: string, known?: ReadonlySet<string>): DetectResult {
  // 快路径：绝大多数轮次不含这些标签，不要为此扫全文
  const hasFunctionForm = text.includes("<function=")
  const hasArgsForm = text.includes("<args>")
  if (!hasFunctionForm && !hasArgsForm) return { calls: EMPTY, stripped: text }

  const calls: ParsedCall[] = []
  const cuts: Array<[number, number]> = []

  FUNCTION_OPEN.lastIndex = 0
  for (let open = hasFunctionForm ? FUNCTION_OPEN.exec(text) : null; open !== null; open = FUNCTION_OPEN.exec(text)) {
    const name = open[1]
    if (known && !known.has(name)) continue

    // 函数体到 </function> 为止；模型被截断时可能根本没有闭合标签，此时吃到末尾
    const bodyStart = open.index + open[0].length
    const closeAt = text.indexOf("</function>", bodyStart)
    const bodyEnd = closeAt === -1 ? text.length : closeAt
    const body = text.slice(bodyStart, bodyEnd)

    const params: Record<string, string> = {}
    PARAMETER.lastIndex = 0
    for (let p = PARAMETER.exec(body); p !== null; p = PARAMETER.exec(body)) {
      params[p[1]] = trimValue(p[2])
    }

    calls.push({ name, params })

    // 摘除范围：连同外层 <tool_call>/</tool_call> 包裹一起摘掉，不然会剩下孤儿标签。
    // 外层包裹是可选的 —— 实测两种形态都出现过。
    let cutStart = open.index
    const before = text.slice(0, open.index)
    const wrapOpen = before.lastIndexOf("<tool_call>")
    // 只有紧邻（中间除空白外没有别的内容）才认作本次调用的包裹
    if (wrapOpen !== -1 && before.slice(wrapOpen + "<tool_call>".length).trim() === "") cutStart = wrapOpen

    let cutEnd = closeAt === -1 ? text.length : closeAt + "</function>".length
    const after = text.slice(cutEnd)
    const wrapClose = after.indexOf("</tool_call>")
    if (wrapClose !== -1 && after.slice(0, wrapClose).trim() === "") cutEnd += wrapClose + "</tool_call>".length

    cuts.push([cutStart, cutEnd])
    FUNCTION_OPEN.lastIndex = cutEnd
  }

  ARGS_OPEN.lastIndex = 0
  for (let open = hasArgsForm ? ARGS_OPEN.exec(text) : null; open !== null; open = ARGS_OPEN.exec(text)) {
    const name = open[1]
    if (known && !known.has(name)) continue

    // 同上：模型被截断时可能没有闭合标签，此时吃到末尾
    const bodyStart = open.index + open[0].length
    const closeAt = text.indexOf("</args>", bodyStart)
    const bodyEnd = closeAt === -1 ? text.length : closeAt
    const body = text.slice(bodyStart, bodyEnd)

    const params: Record<string, string> = {}
    ARG_FIELD.lastIndex = 0
    for (let field = ARG_FIELD.exec(body); field !== null; field = ARG_FIELD.exec(body)) {
      params[field[1]] = trimValue(field[2])
    }

    calls.push({ name, params })

    let cutEnd = closeAt === -1 ? text.length : closeAt + "</args>".length
    // 顺带吃掉紧邻的 </工具名>，不然会剩个孤儿闭合标签
    const closeTag = `</${name}>`
    const after = text.slice(cutEnd)
    const closeAtTag = after.indexOf(closeTag)
    if (closeAtTag !== -1 && after.slice(0, closeAtTag).trim() === "") cutEnd += closeAtTag + closeTag.length

    cuts.push([open.index, cutEnd])
    ARGS_OPEN.lastIndex = cutEnd
  }

  if (calls.length === 0) return { calls: EMPTY, stripped: text }

  // 两种形状各自扫了一遍全文，cuts 不再天然有序，摘除前必须排序并跳过重叠区间
  cuts.sort((a, b) => a[0] - b[0])

  let stripped = ""
  let cursor = 0
  for (const [start, end] of cuts) {
    if (start < cursor) {
      cursor = Math.max(cursor, end)
      continue
    }
    stripped += text.slice(cursor, start)
    cursor = end
  }
  stripped += text.slice(cursor)

  return { calls, stripped: stripped.replace(/\n{3,}/g, "\n\n").trim() }
}

/** 回灌给模型的纠正提示：告诉它刚才那次调用没生效，并把解析结果原样还给它 */
export function recoveryPrompt(calls: readonly ParsedCall[]): string {
  const rendered = calls
    .map((call) => {
      const args = Object.entries(call.params)
        .map(([key, value]) => `  ${key}: ${value.length > 200 ? value.slice(0, 200) + "…(truncated)" : value}`)
        .join("\n")
      return `- ${call.name}\n${args || "  (no parameters)"}`
    })
    .join("\n")
  return [
    "[System notice] Your previous turn emitted tool call(s) as literal XML text instead of using the native tool-call channel.",
    "Text-form tool calls are NOT executed — that turn had no effect.",
    "",
    "Parsed from your output:",
    rendered,
    "",
    "Re-issue these call(s) now using the native tool-call mechanism. Do not write tool calls as XML in your message text — neither <tool_call>/<function=...>/<parameter=...> nor <toolname><args>...</args></toolname>.",
  ].join("\n")
}

/** 本轮只产出了思考、没有正文也没有工具调用时的纠正提示 */
export const REASONING_ONLY_PROMPT = [
  "[System notice] Your previous turn produced reasoning only — no user-visible message and no tool call, so the user saw an empty response.",
  "Write your answer in the normal response channel now. If you intended to call a tool, call it.",
].join("\n")

/**
 * 本轮**什么都没产出**（无思考、无正文、无工具调用）时的纠正提示。
 *
 * 260808 Red：与 REASONING_ONLY 是两回事。那个至少还有思考可以提升成正文；这个连思考
 * 都没有，分片只剩 `step-start → text(长度 0) → step-finish`，finish 却是 "stop"、无报错。
 * 循环把它当正常收尾直接 break，用户看到的就是"跑着跑着莫名其妙停了"（实测
 * ses_020e2ecaaffe…，deepseek-v4-flash，18 个输出 token、3.9s）。
 */
export const EMPTY_TURN_PROMPT = [
  "[System notice] Your previous turn produced nothing at all — no message, no reasoning, no tool call. The user saw the session stop with no output.",
  "Continue now: either answer in the normal response channel, or call the tool you intended to call.",
].join("\n")
