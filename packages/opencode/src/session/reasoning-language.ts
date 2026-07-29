// 260729 Red 可见思考文本的语言约束。
//
// 背景：DeepSeek / step 等模型即使面对纯中文提问，reasoning_content 也常常整段用英文写
// （本仓会话库里随手就能翻到 "The user wants me to..." 这类）。用户看到的"已思考"因此是英文，
// 而正文是中文，割裂得厉害。
//
// 设计取自 DeepSeek-Reasonix（internal/agent/reasoning_language.go），三条都不是随手决定的：
//
//  1. **命令式，不是"偏好/建议"**。Reasonix 的注释记了实测结论：软措辞（"偏好……请使用"）在
//     "中文提问里嵌了英文日志/代码"时会丢掉**第一个** reasoning 段；而第一段会锚定整轮，
//     因为 provider 会把先前的 reasoning 回传给模型。第一段丢了，整轮就回不来了。
//
//  2. **注入 user turn，不进 system prompt**。这是用户可以随时切换的偏好，放进稳定前缀等于
//     每次改设置都把整个 prefix cache 打掉。RedCode 对前缀稳定性的要求只高不低
//     （见 prompt.ts 的 _caches.system 与 PrefixShape 诊断），更不能碰。
//
//  3. **auto 模式保守**。只在能明确判定用户在说中文时才注入；英文和拿不准的一律不注入，
//     保持原有行为不变。宁可漏，不可错——错误注入会让英文用户的思考链变成中文。

export type Mode = "auto" | "zh" | "en"

export function normalize(value: string | undefined): Mode {
  switch (value?.trim().toLowerCase()) {
    case "zh":
    case "cn":
    case "chinese":
    case "中文":
      return "zh"
    case "en":
    case "english":
      return "en"
    default:
      return "auto"
  }
}

const ZH_BLOCK =
  "<reasoning-language>\n" +
  "必须使用简体中文书写全部可见思考/推理文本：从第一个字开始就用中文，并在整轮内保持中文，" +
  "即使系统提示词、工具说明、工具输出或引用的代码是英文。" +
  "代码、标识符、文件路径、shell 命令和未翻译的技术术语保持原文。" +
  "此要求只约束可见思考文本，不影响最终回答的语言。\n" +
  "</reasoning-language>"

const EN_BLOCK =
  "<reasoning-language>\n" +
  "Write all visible reasoning/thinking text in English, from the first word onward, " +
  "and keep it English for the whole turn. Keep code, identifiers, file paths, shell commands " +
  "and untranslated technical terms as-is. This constrains visible reasoning only; " +
  "it does not affect the language of the final answer.\n" +
  "</reasoning-language>"

/** 返回要注入的块；auto 或无法判定时返回 undefined（不注入） */
export function block(mode: Mode): string | undefined {
  if (mode === "zh") return ZH_BLOCK
  if (mode === "en") return EN_BLOCK
  return undefined
}

// 剥掉不代表"用户在用什么语言说话"的内容：RedCode 注入的包装块、粘贴的文件/代码。
// 不剥的话，一段贴进来的英文日志会稀释判定，或者英文文件里的中文注释会误判。
const STRIP = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<reasoning-language>[\s\S]*?<\/reasoning-language>/g,
  /```[\s\S]*?```/g,
  /`[^`\n]*`/g,
]

const HAN = /\p{Script=Han}/gu
const CJK_PUNCT = /[，。！？；：、“”‘’《》（）【】…—]/gu

/**
 * 保守判定用户这一轮是不是在说中文。
 * 返回 "zh" 或 "auto"——只认中文，不试图判定英文（英文本来就走不注入的老路径）。
 */
export function infer(source: string | undefined): Mode {
  if (!source) return "auto"
  let text = source
  for (const re of STRIP) text = text.replace(re, " ")
  text = text.trim()
  if (!text) return "auto"

  const han = (text.match(HAN) ?? []).length
  if (han >= 4) return "zh"
  const punct = (text.match(CJK_PUNCT) ?? []).length
  if (han >= 2 && punct > 0) return "zh"
  return "auto"
}

/** 显式设置优先；auto 时才看用户这轮说的是什么语言 */
export function resolve(configured: string | undefined, source: string | undefined): Mode {
  const mode = normalize(configured)
  if (mode !== "auto") return mode
  return infer(source)
}

interface MessageLike {
  readonly info: { readonly role: string }
  readonly parts: ReadonlyArray<{
    readonly type: string
    readonly text?: string
    readonly ignored?: boolean
    readonly synthetic?: boolean
  }>
}

/**
 * 从消息列表里取出「用户自己最后写的那段话」，用于语言判定。
 *
 * 260729 修：原先在 prompt.ts 里直接取最后一条 role==="user" 的消息，实测是错的 ——
 * DCP 压缩通知（`▣ DCP | -148.1K removed…`）同样是 user 角色，只是文本 part 标了
 * ignored。取到它、再过滤掉 ignored 的 part，就只剩空串，判定退化成 auto，整条约束
 * 静默失效（会话 ses_0536c…：用户说的是「怎么了敏敏」，思考却整段英文）。
 * 正确做法是从后往前找**第一条真的含用户自撰文本**的消息，跳过纯注入消息。
 */
export function sourceFrom(msgs: ReadonlyArray<MessageLike>): string | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i]
    if (msg.info.role !== "user") continue
    const text = msg.parts
      .filter((p) => p.type === "text" && !p.ignored && !p.synthetic)
      .map((p) => p.text ?? "")
      .join("\n")
      .trim()
    if (text) return text
  }
  return undefined
}
