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
