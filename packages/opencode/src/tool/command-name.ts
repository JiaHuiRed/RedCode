import path from "path"

const WINDOWS_EXECUTABLE_EXTS = [".exe", ".com", ".cmd", ".bat"]

// 260913 Red 先剥掉包裹引号再判：带引号的 "cd.exe" 也必须认出是外部可执行文件，
// 否则会被当成 CWD 内建命令享受豁免。commandName 与本判定共用这一步。
function unquote(raw: string) {
  const text = raw
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

export function isWindowsExecutable(raw: string | undefined): boolean {
  if (raw === undefined || raw === "") return false
  return WINDOWS_EXECUTABLE_EXTS.includes(path.extname(unquote(raw)).toLowerCase())
}

export function commandName(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return raw
  const text = unquote(raw)
  if (process.platform === "win32") {
    const base = path.basename(text)
    const ext = path.extname(base).toLowerCase()
    if (WINDOWS_EXECUTABLE_EXTS.includes(ext)) {
      return base.slice(0, -ext.length)
    }
    return base
  }
  return text
}
