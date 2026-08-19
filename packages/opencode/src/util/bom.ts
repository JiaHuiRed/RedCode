import { Effect } from "effect"
import { AppFileSystem } from "@redcode-ai/core/filesystem"

const BOM_CODE = 0xfeff
const BOM = String.fromCharCode(BOM_CODE)

export function split(text: string) {
  if (text.charCodeAt(0) !== BOM_CODE) return { bom: false, text }
  return { bom: true, text: text.slice(1) }
}

export function join(text: string, bom: boolean) {
  const stripped = split(text).text
  if (!bom) return stripped
  return BOM + stripped
}

// 260730 Karina 读取侧编码检测。此前无条件按 UTF-8 非 fatal 解码：真 GBK 文件读进来
// 满屏 U+FFFD，模型根本没法干活（靠写入侧 detectGarbled 兜住不写回，不算数据丢失，
// 但也确实读不了）。
//
// 检测只能单向做：「严格 UTF-8 解码成功 → 就是 UTF-8」可靠，UTF-8 有自校验结构，
// 实测 20000 样本里 5 个汉字往上、GBK 字节凑成合法 UTF-8 的次数为 0；反过来「GBK
// 解码成功 → 就是 GBK」毫无价值，GBK 太宽松，8 个汉字的 UTF-8 字节流有 31% 能被它
// 照单全收。所以顺序固定：BOM → 严格 UTF-8 → 才退系统代码页。
const SYSTEM_ENCODING = (() => {
  // 退到哪个遗留代码页只能靠猜，按 locale 挑一个最可能的。猜错了也不会毁文件 ——
  // 非 UTF-8 的原文一律禁止写回（见 detectEncodingChange），最坏情况只是读出来是花的。
  const locale = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase()
    } catch {
      return ""
    }
  })()
  if (/^zh-(tw|hk|mo)\b|hant/.test(locale)) return "big5"
  if (locale.startsWith("zh")) return "gb18030"
  if (locale.startsWith("ja")) return "shift_jis"
  if (locale.startsWith("ko")) return "euc-kr"
  return "windows-1252"
})()

// 判定只看开头这么多字节。**read 和 edit 必须用同一条规则、同一个采样长度** ——
// read 产 [path#TAG]、edit 用全文算 currentHash 校验陈旧度，两边解码方式不一致
// 就会在该类文件上次次 hash mismatch。read 那边是流式的、拿不到全文，所以规则
// 就定成"只看头部"，两边才对得上。
// 只看头部同时也更稳：一个 99.99% 是 UTF-8、末尾混进一个坏字节的文件，全文校验会
// 判成 GBK 然后整个解花，头部校验则判 UTF-8、只有那个坏字节退化成 U+FFFD。
// 与 read.ts 的 SAMPLE_BYTES 必须相等（那边直接拿已有的采样来嗅，省一次开文件），
// bom.test.ts 里有一条测试钉住这个等式，别单改一边。
export const SNIFF_BYTES = 4096

export function sniff(head: Uint8Array): string {
  // UTF-16 的 BOM 必须先认：这类文件按 UTF-8 解是纯粹的垃圾，而 PowerShell 5.1 的
  // Out-File / `>` 默认写出来就是 UTF-16LE，Windows 上并不罕见。
  if (head.length >= 2) {
    if (head[0] === 0xff && head[1] === 0xfe) return "utf-16le"
    if (head[0] === 0xfe && head[1] === 0xff) return "utf-16be"
  }
  try {
    // stream:true 不可省 —— 采样边界很可能切在一个多字节字符中间，不带它会把
    // 被截断的尾巴当成非法序列，好端端的 UTF-8 文件被误判成 GBK。
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true })
    return "utf-8"
  } catch {
    return SYSTEM_ENCODING
  }
}

export type Decoded = { bom: boolean; text: string; encoding: string }

export function decode(bytes: Uint8Array): Decoded {
  const encoding = sniff(bytes.length > SNIFF_BYTES ? bytes.subarray(0, SNIFF_BYTES) : bytes)
  // UTF-8 走 ignoreBOM=true，把 BOM 留给 split() 处理，与原来的行为一致；
  // UTF-16 的 BOM 则由 TextDecoder 默认的 ignoreBOM=false 自己吃掉。
  if (encoding !== "utf-8") return { bom: false, text: new TextDecoder(encoding).decode(bytes), encoding }
  return { ...split(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)), encoding }
}

export const readFile = Effect.fn("Bom.readFile")(function* (fs: AppFileSystem.Interface, filePath: string) {
  return decode(yield* fs.readFile(filePath))
})

// 检测出非 UTF-8 之后必须配一道写回护栏，否则就成了「悄悄把用户的 GBK 文件转成
// UTF-8」—— 检测之前这件事由 detectGarbled 顺带挡着（GBK 读成 UTF-8 满屏 FFFD，
// 占比 83% 远超阈值，直接拒写），检测之后文本干净了，那道墙就自动失效了。
// 我们只有解码能力没有编码能力（TextEncoder 只出 UTF-8，仓库里也没有 iconv），
// 所以不做往回转，而是明确拒绝并告诉模型该怎么办。
export function detectEncodingChange(encoding: string): string | undefined {
  if (encoding === "utf-8") return undefined
  return `原文件是 ${encoding} 编码，不是 UTF-8。直接写回会把它悄悄转成 UTF-8`
}

// 260616 Red 乱码护栏：GBK 错解 UTF-8 会产出私用区字符(PUA E000-F8FF)/替换符(U+FFFD)，
// 正常文本几乎不含。写入前检测，拦住"把文件写成乱码"（今天 SKILL.md 被写成 72 个 PUA）。
// 返回非空字符串 = 判定为乱码的原因；返回 undefined = 正常。阈值偏保守，只拦高置信乱码。
export function detectGarbled(text: string): string | undefined {
  let pua = 0
  let repl = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c === 0xfffd) repl++
    else if (c >= 0xe000 && c <= 0xf8ff) pua++
  }
  const total = text.length || 1
  // U+FFFD 只在解码失败时产生，正常内容绝不含 —— 密集出现即乱码
  if (repl > 0 && repl / total > 0.005) return `内容含 ${repl} 个 Unicode 替换符(U+FFFD)，疑似编码解码失败的乱码`
  // PUA 多用于 Nerd Font 图标，正常文档占比极低；高占比+高绝对数 = GBK 错解 UTF-8
  if (pua > 30 && pua / total > 0.02) return `内容含 ${pua} 个私用区字符(PUA)，疑似 GBK 错解 UTF-8 产生的乱码`
  return undefined
}

// 260730 Karina 行尾回车膨胀护栏：CRLF 文件被二次做 LF→CRLF 转换会产出 `\r\r\n`。
// 这类损坏对工具自己完全隐形 —— read 和 hashline 都只按 `\n` 切行，行数不变；
// Hash.fileTag 又把行尾 `[ \t\r]+` 洗掉，tag 也不变。但 .NET/Get-Content/编辑器/
// 浏览器都把裸 `\r` 当换行，于是每行后面凭空多一个空行，编辑一次翻一倍。
// （edit.ts hashline 路径就这么把一个 6905 行的 index.html 连翻到 27707 行。）
// 只在"新内容比原内容多"时拦截，否则已经损坏的文件连用 edit 修都修不了。
export function detectCrBloat(next: string, prev = ""): string | undefined {
  const count = (text: string) => text.match(/\r\r+\n/g)?.length ?? 0
  const after = count(next)
  if (after === 0) return undefined
  const before = count(prev)
  if (after <= before) return undefined
  return `内容含 ${after} 处行尾多余回车符(\\r\\r\\n，原文 ${before} 处)，写入后每行后面会多出一个空行`
}

export const syncFile = Effect.fn("Bom.syncFile")(function* (
  fs: AppFileSystem.Interface,
  filePath: string,
  bom: boolean,
) {
  const current = yield* readFile(fs, filePath)
  if (current.bom === bom) return current.text
  yield* fs.writeWithDirs(filePath, join(current.text, bom))
  return current.text
})
