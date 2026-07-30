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

export const readFile = Effect.fn("Bom.readFile")(function* (fs: AppFileSystem.Interface, filePath: string) {
  return split(new TextDecoder("utf-8", { ignoreBOM: true }).decode(yield* fs.readFile(filePath)))
})

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
  if (repl > 0 && repl / total > 0.005)
    return `内容含 ${repl} 个 Unicode 替换符(U+FFFD)，疑似编码解码失败的乱码`
  // PUA 多用于 Nerd Font 图标，正常文档占比极低；高占比+高绝对数 = GBK 错解 UTF-8
  if (pua > 30 && pua / total > 0.02)
    return `内容含 ${pua} 个私用区字符(PUA)，疑似 GBK 错解 UTF-8 产生的乱码`
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
