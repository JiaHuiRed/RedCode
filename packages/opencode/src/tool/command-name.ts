import path from "path"

const WINDOWS_EXECUTABLE_EXTS = [".exe", ".com", ".cmd", ".bat"]

export function commandName(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return raw
  let text = raw
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) {
    text = text.slice(1, -1)
  }
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
