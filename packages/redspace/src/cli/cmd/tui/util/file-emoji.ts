/**
 * 260831 cc 工具行文件名前的文件类型标记，对齐 GUI 那边刚加的 FileIcon。
 *
 * 为什么用 emoji 而不是 Nerd Font 的 devicons：本 TUI 至今**一个私有区字形都没用过**
 * （现有的 ✎ ⚙ ◉ ⊡ ⌘ ⊞ ⬡ ◎ 全是基本多文种平面的几何符号，任何字体都有），
 * 用 devicons 等于给终端强加一个 Nerd Font 依赖，字体不对就是一片豆腐块。
 * 而 emoji 已有先例——「🧠 已思考」那行（routes/session/index.tsx）。
 *
 * ⚠️ 一律选**不带变体选择符（U+FE0F）**的码位。带 VS16 的 emoji（如 ⚙️ 🖼️）在不同终端
 * 里宽度判定不一致，会把后面的文本推歪；不带的稳定占两格。
 *
 * 分类粒度对齐 GUI 的 chooseIconName：先认整文件名（README/LICENSE 这类没有扩展名或
 * 扩展名不表意的），再认扩展名，都不中就退默认。
 */

/** 整文件名命中（小写比较）。这些要么没扩展名，要么扩展名不表意。 */
const BY_NAME: Record<string, string> = {
  "readme.md": "📖",
  "changelog.md": "📜",
  license: "📜",
  dockerfile: "🐳",
  makefile: "🔨",
  ".gitignore": "🙈",
  ".env": "🔑",
}

/** 扩展名命中（不含点，小写）。 */
const BY_EXT: Record<string, string> = {
  py: "🐍",
  rs: "🦀",
  go: "🐹",
  java: "☕",
  rb: "💎",
  php: "🐘",
  swift: "🦅",
  lua: "🌙",

  ts: "📘",
  tsx: "📘",
  js: "📒",
  jsx: "📒",
  mjs: "📒",
  cjs: "📒",

  md: "📝",
  mdx: "📝",
  txt: "📄",
  pdf: "📕",

  json: "🧾",
  jsonc: "🧾",
  yaml: "🧾",
  yml: "🧾",
  toml: "🧾",
  ini: "🧾",
  conf: "🧾",

  html: "🌐",
  htm: "🌐",
  css: "🎨",
  scss: "🎨",
  sass: "🎨",
  less: "🎨",

  sh: "🐚",
  bash: "🐚",
  zsh: "🐚",
  fish: "🐚",
  ps1: "🔷",

  sql: "🗄",
  db: "🗄",
  sqlite: "🗄",

  png: "📷",
  jpg: "📷",
  jpeg: "📷",
  gif: "📷",
  webp: "📷",
  svg: "📐",

  zip: "📦",
  tar: "📦",
  gz: "📦",

  lock: "🔒",
  log: "📋",
}

const DEFAULT = "📄"

/** 取 basename，同时吃掉 `/` 与 `\`（Windows 路径会两种混用）。 */
function basenameOf(path: string) {
  const parts = path.split("\\").join("/").split("/")
  return parts[parts.length - 1] ?? ""
}

/**
 * 返回该路径的文件类型 emoji。路径为空时返回空串——调用方据此决定要不要留空格，
 * 避免在没有文件名的行上多出一个孤零零的图标。
 */
export function fileEmoji(path?: string): string {
  if (!path) return ""
  const base = basenameOf(path).toLowerCase()
  if (!base) return ""

  const byName = BY_NAME[base]
  if (byName) return byName

  // 从最后一个点取扩展名；`foo.test.ts` 取 ts，与 GUI 那边「最长后缀优先」的差别可接受——
  // 这里只用来选图标，不像那边还要分辨 test/spec 专用图标。
  const dot = base.lastIndexOf(".")
  if (dot > 0) {
    const ext = base.slice(dot + 1)
    const byExt = BY_EXT[ext]
    if (byExt) return byExt
  }

  return DEFAULT
}
