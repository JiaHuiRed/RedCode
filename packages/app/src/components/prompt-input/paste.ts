const LARGE_PASTE_CHARS = 8000
const LARGE_PASTE_BREAKS = 120

function largePaste(text: string) {
  if (text.length >= LARGE_PASTE_CHARS) return true
  let breaks = 0
  for (const char of text) {
    if (char !== "\n") continue
    breaks += 1
    if (breaks >= LARGE_PASTE_BREAKS) return true
  }
  return false
}

export function normalizePaste(text: string) {
  if (!text.includes("\r")) return text
  return text.replace(/\r\n?/g, "\n")
}

export function pasteMode(text: string) {
  if (largePaste(text)) return "manual"
  if (text.includes("\n") || text.includes("\r")) return "manual"
  return "native"
}

// 261121 Red 方案①：剪贴板分类统一入口。文件列表与 text/plain 必须在事件回调的同步段
// 一次取全——Chromium 的 DataTransfer 在事件返回后可能被清成保护态，await 之后再读会拿到
// 空。首页 textarea 与富文本编辑器共享这一层分类，插入与撤销各用各的实现。
export function classifyClipboard(data: DataTransfer): { files: File[]; text: string } {
  const files = Array.from(data.items).flatMap((item) => {
    if (item.kind !== "file") return []
    const file = item.getAsFile()
    return file ? [file] : []
  })
  return { files, text: data.getData("text/plain") ?? "" }
}
