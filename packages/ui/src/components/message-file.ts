import type { FilePart } from "@redcode-ai/sdk/v2"

// 261017 Red 用户从输入框附加的文件落盘后是 file:// URL（图片才是 data:）。旧判定
// 只认 data:，于是这类文件既不算附件、又没有 source.text 走 inline，用户消息里
// 只剩文本——看上去像只发了一句话，实际附件已经发给模型了。
// 有 source.text 的引用仍归 inline，避免正文内引用被重复画成附件 chip。
function isInline(part: FilePart) {
  if (part.url.startsWith("data:")) return false
  return part.source?.text?.start !== undefined && part.source?.text?.end !== undefined
}

export function attached(part: FilePart) {
  if (isInline(part)) return false
  return part.url.startsWith("data:") || part.url.startsWith("file:")
}

export function inline(part: FilePart) {
  return isInline(part)
}

export function kind(part: FilePart) {
  return part.mime.startsWith("image/") ? "image" : "file"
}
