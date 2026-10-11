export const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"]

export const ACCEPTED_FILE_TYPES = [
  ...ACCEPTED_IMAGE_TYPES,
  "application/pdf",
  // 261011 Red 压缩包附件：不作二进制 part 进模型，走磁盘路径 + 稳定文本占位；
  // mime 与扩展名双判在 files.ts（Windows 资源管理器常报 x-zip-compressed 这类带前缀的 mime）。
  "application/zip",
  "application/x-zip-compressed",
  "application/x-7z-compressed",
  "application/vnd.rar",
  "application/x-rar-compressed",
  "application/x-tar",
  "application/gzip",
  "application/x-gzip",
  "text/*",
  "application/json",
  "application/ld+json",
  "application/toml",
  "application/x-toml",
  "application/x-yaml",
  "application/xml",
  "application/yaml",
  ".7z",
  ".c",
  ".cc",
  ".cjs",
  ".conf",
  ".cpp",
  ".css",
  ".csv",
  ".cts",
  ".env",
  ".go",
  ".gql",
  ".graphql",
  ".gz",
  ".h",
  ".hh",
  ".hpp",
  ".htm",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".mdx",
  ".mjs",
  ".mts",
  ".py",
  ".rar",
  ".rb",
  ".rs",
  ".sass",
  ".scss",
  ".sh",
  ".sql",
  ".tar",
  ".tgz",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
  ".zip",
  ".zsh",
]

const MIME_EXT = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["application/pdf", "pdf"],
  ["application/json", "json"],
  ["application/ld+json", "jsonld"],
  ["application/toml", "toml"],
  ["application/x-toml", "toml"],
  ["application/x-yaml", "yaml"],
  ["application/xml", "xml"],
  ["application/yaml", "yaml"],
  ["application/zip", "zip"],
  ["application/x-zip-compressed", "zip"],
  ["application/x-7z-compressed", "7z"],
  ["application/vnd.rar", "rar"],
  ["application/x-rar-compressed", "rar"],
  ["application/x-tar", "tar"],
  ["application/gzip", "gz"],
  ["application/x-gzip", "gz"],
])

const TEXT_EXT = ["txt", "text", "md", "markdown", "log", "csv"]

export const ACCEPTED_FILE_EXTENSIONS = Array.from(
  new Set(
    ACCEPTED_FILE_TYPES.flatMap((item) => {
      if (item.startsWith(".")) return [item.slice(1)]
      if (item === "text/*") return TEXT_EXT
      const out = MIME_EXT.get(item)
      return out ? [out] : []
    }),
  ),
).sort()

export function filePickerFilters(ext?: string[]) {
  if (!ext || ext.length === 0) return undefined
  return [{ name: "Files", extensions: ext }]
}
