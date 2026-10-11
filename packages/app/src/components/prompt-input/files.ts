import { ACCEPTED_FILE_TYPES, ACCEPTED_IMAGE_TYPES } from "@/constants/file-picker"

export { ACCEPTED_FILE_TYPES }

const IMAGE_MIMES = new Set(ACCEPTED_IMAGE_TYPES)
const IMAGE_EXTS = new Map([
  ["gif", "image/gif"],
  ["jpeg", "image/jpeg"],
  ["jpg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
])
const TEXT_MIMES = new Set([
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/x-toml",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
])

// 261011 Red 压缩包：mime 与扩展名双判。Windows 资源管理器/浏览器对同一格式报的 mime 不一
// （zip 有 application/zip 和 x-zip-compressed 两种），只看 mime 会漏；只看扩展名又会被
// 改了后缀的假压缩包骗过——两者命中其一即认。
const ARCHIVE_MIMES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/x-7z-compressed",
  "application/vnd.rar",
  "application/x-rar-compressed",
  "application/x-tar",
  "application/gzip",
  "application/x-gzip",
])
const ARCHIVE_EXTS = new Set(["zip", "7z", "rar", "tar", "gz", "tgz"])

const SAMPLE = 4096

function kind(type: string) {
  return type.split(";", 1)[0]?.trim().toLowerCase() ?? ""
}

export function extName(name: string) {
  const idx = name.lastIndexOf(".")
  if (idx === -1) return ""
  return name.slice(idx + 1).toLowerCase()
}

const ext = extName

// 261011 Red 压缩包判定与规范 mime：attachmentMime 放行、attachments 落盘分支、
// toast 文案共用这一个判定入口，避免多处各写一套集合后漂移。
export function isArchiveFile(file: { name: string; type: string }) {
  return ARCHIVE_MIMES.has(kind(file.type)) || ARCHIVE_EXTS.has(extName(file.name))
}

function archiveMime(file: { name: string; type: string }) {
  const type = kind(file.type)
  if (ARCHIVE_MIMES.has(type)) return type
  switch (extName(file.name)) {
    case "zip":
      return "application/zip"
    case "7z":
      return "application/x-7z-compressed"
    case "rar":
      return "application/vnd.rar"
    case "tar":
      return "application/x-tar"
    case "gz":
    case "tgz":
      return "application/gzip"
    default:
      return type || "application/octet-stream"
  }
}

function textMime(type: string) {
  if (!type) return false
  if (type.startsWith("text/")) return true
  if (TEXT_MIMES.has(type)) return true
  if (type.endsWith("+json")) return true
  return type.endsWith("+xml")
}

function textBytes(bytes: Uint8Array) {
  if (bytes.length === 0) return true
  let count = 0
  for (const byte of bytes) {
    if (byte === 0) return false
    if (byte < 9 || (byte > 13 && byte < 32)) count += 1
  }
  return count / bytes.length <= 0.3
}

export async function attachmentMime(file: File) {
  const type = kind(file.type)
  if (IMAGE_MIMES.has(type)) return type
  if (type === "application/pdf") return type
  // 261011 Red 压缩包放行：不做文本嗅探（内容是二进制，textBytes 必拒），
  // mime 归一化后交给 attachments 的落盘分支。
  if (ARCHIVE_MIMES.has(type) || ARCHIVE_EXTS.has(ext(file.name))) return archiveMime(file)

  const suffix = ext(file.name)
  const fallback = IMAGE_EXTS.get(suffix) ?? (suffix === "pdf" ? "application/pdf" : undefined)
  if ((!type || type === "application/octet-stream") && fallback) return fallback

  if (textMime(type)) return "text/plain"
  const bytes = new Uint8Array(await file.slice(0, SAMPLE).arrayBuffer())
  if (!textBytes(bytes)) return
  return "text/plain"
}
