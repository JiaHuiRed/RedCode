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

import os from "os"

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

const ZH_LANGUAGE =
  "必须使用简体中文书写全部可见思考/推理文本：从第一个字开始就用中文，并在整轮内保持中文，" +
  "即使系统提示词、工具说明、工具输出或引用的代码是英文。" +
  "代码、标识符、文件路径、shell 命令和未翻译的技术术语保持原文。" +
  "此要求只约束可见思考文本，不影响最终回答的语言。"

const EN_LANGUAGE =
  "Write all visible reasoning/thinking text in English, from the first word onward, " +
  "and keep it English for the whole turn. Keep code, identifiers, file paths, shell commands " +
  "and untranslated technical terms as-is. This constrains visible reasoning only; " +
  "it does not affect the language of the final answer."

// 260730 Karina 称呼约束。语气/称呼设定（soul、per-model 提示词）全都只管住了正文 ——
// 模型把"人格"理解成输出风格，一进思考通道就退回默认的第三人称 "the user"/"用户"，
// 正文喊"哥哥"、思考里写 "The user wants me to..."，割裂得很明显。
// 修法跟语言约束同源：必须显式点明"这条也管可见思考文本"，并且用命令式措辞。
const zhAddress = (name: string) =>
  `在可见思考文本里同样称呼用户为「${name}」，与正文保持一致；` +
  `不要用「用户」「the user」「这位用户」之类的第三人称指代，从第一句思考开始就这么称呼。`

const enAddress = (name: string) =>
  `In visible reasoning text, address the user as "${name}", the same as in your reply. ` +
  `Never refer to them as "the user" or any other third-person placeholder — do this from the first sentence of reasoning onward.`

/**
 * 返回要注入的块；语言与称呼两条约束共用一个块，省一个 user turn。
 *
 * 标签沿用历史的 `<reasoning-language>` 而不是改成更贴切的名字：
 * `instruction-echo.ts` 的 A 类剥离和下面 STRIP 都按这个标签匹配，改名要同步三处，
 * 换来的只是名字好看一点，不值得冒漏剥的风险。
 *
 * mode 为 auto（判定不出用户在说什么语言）时不注入语言约束，但称呼约束照样要注入 ——
 * 这两件事的触发条件本来就不同：称呼只取决于用户有没有设过 username。
 */
export function block(mode: Mode, address?: string): string | undefined {
  const rules: string[] = []
  if (mode === "zh") rules.push(ZH_LANGUAGE)
  if (mode === "en") rules.push(EN_LANGUAGE)
  // 正常调用方会先过 addressFrom()，这里再兜一次空白串：注入「称呼用户为『   』」比不注入更糟
  const name = address?.trim()
  if (name) rules.push(mode === "zh" ? zhAddress(name) : enAddress(name))
  if (rules.length === 0) return undefined
  return `<reasoning-language>\n${rules.join("\n")}\n</reasoning-language>`
}

/**
 * 从 config.username 取思考里该用的称呼。
 *
 * config 在读取时会把空缺的 username 填成系统用户名（config.ts 里 `if (!result.username)`），
 * 所以这里必须把"等于系统用户名"当成没设过 —— 否则会注入「称呼用户为 Administrator」，
 * 比不注入更糟。
 */
export function addressFrom(username: string | undefined): string | undefined {
  const name = username?.trim()
  if (!name) return undefined
  try {
    if (name === os.userInfo().username) return undefined
  } catch {}
  return name
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
