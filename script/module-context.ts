// 260929 Red 模块阅读包：一条命令产出某模块的有界上下文，替代「进场先翻几十个文件」。
// 设计学自 ZCode 的 `pnpm architecture:context <module-id>`（scripts/architecture/index.mjs）：
// 只读、不猜实现，输出 package 身份 / 公开入口 / 源码地图 / 依赖与反向依赖 / spec 与测试清单。
// 用法：bun run script/module-context.ts <packages/app | packages/opencode/src/session | ...>
import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import { join, relative, resolve } from "path"

const root = resolve(import.meta.dir, "..")

function read(path: string): string {
  try {
    return readFileSync(path, "utf-8")
  } catch {
    // 文件不存在或不可读时按空处理：调用方各自判空，这里不区分原因
    return ""
  }
}

// 260929 Red 刻意不用 any：A3 那个 bug（workspace globs 读目标包自己的 package.json）
// 之所以静默，正是因为 readJson 返回 any —— 读错字段编译器一声不响，运行时拿到
// undefined 就走 ?? [] 兜底，输出恒为「(none)」而没有任何东西报错。
interface PackageJson {
  name?: string
  version?: string
  main?: string
  module?: string
  types?: string
  scripts?: Record<string, string>
  exports?: Record<string, unknown>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  workspaces?: { packages?: string[] } | string[]
}

function readJson(path: string): PackageJson | undefined {
  const text = read(path)
  if (!text) return undefined
  try {
    return JSON.parse(text) as PackageJson
  } catch {
    return undefined
  }
}

function countLines(path: string): number {
  const text = read(path)
  if (!text) return 0
  // 末行无换行符时 split 会少算一段，用结尾判断补回
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length
}

// 260929 Red 构建产物不进源码地图。SKIP_DIR 原先只被 notes 遍历用着，walk 这边另写了
// 一份「node_modules + 点开头」——于是 dist / coverage 被当成源码统计（实测 packages/app
// 一个包的 Source map 里 698 files / 4008 lines 全是 dist/assets）。点开头的目录
// （.artifacts / .git / .vscode）统一在这里判，不再依赖调用方各自记得。
const SKIP_DIR = new Set(["node_modules", "dist", ".artifacts", "coverage"])

function walk(dir: string, depth: number, out: string[] = [], skip: ReadonlySet<string> = SKIP_DIR): string[] {
  if (depth < 0) return out
  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (skip.has(entry.name) || entry.name.startsWith(".")) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(`${full}/`)
      walk(full, depth - 1, out, skip)
    } else {
      out.push(full)
    }
  }
  return out
}

// ---------------------------------------------------------------- 参数与定位
const target = process.argv[2]
if (!target) {
  console.error("usage: bun run script/module-context.ts <package-dir | subdir>")
  console.error("  e.g. packages/app   packages/opencode/src/session   packages/ui/src/components")
  process.exit(1)
}

const modulePath = resolve(root, target)
if (!existsSync(modulePath) || !statSync(modulePath).isDirectory()) {
  console.error(`not a directory under repo root: ${target}`)
  process.exit(1)
}
// 向上找拥有 package.json 的包根；模块 = 包内的子路径（包自身则为 "."）
let pkgRoot = modulePath
const gitHead = () => {
 const head = read(join(root, ".git/HEAD")).trim()
 if (!head.startsWith("ref: ")) return head
 return read(join(root, ".git", head.slice(5).trim())).trim()
}

// Windows 下 path 模块给反斜杠，输出统一成正斜杠，方便直接粘进对话
const posix = (path: string) => path.replace(/\\/g, "/")
while (pkgRoot !== root && !existsSync(join(pkgRoot, "package.json"))) pkgRoot = resolve(pkgRoot, "..")
const pkg = readJson(join(pkgRoot, "package.json"))
if (!pkg?.name) {
 console.error(`no package.json with a name found above ${target}`)
 process.exit(1)
}
const moduleRel = posix(relative(pkgRoot, modulePath)) || "."

// ---------------------------------------------------------------- workspace 包表
// 260929 Red globs 必须取**根** package.json。原先读的是 pkg（目标包自己的），而 workspace
// 包自己不定义 workspaces 字段 → globs 恒为 [] → byName 是空 Map → internalDeps 与
// internalConsumers **恒为空**。实测 packages/app 明明依赖 @redcode-ai/core，输出却是
// (none)。rootPkg 读不到时退化成空表（脚本仍可跑，只是没有依赖分析）。
const rootPkg = readJson(join(root, "package.json"))
const globs: string[] = Array.isArray(rootPkg?.workspaces)
  ? rootPkg.workspaces
  : (rootPkg?.workspaces?.packages ?? [])
const pkgDirs: string[] = []
for (const pattern of globs) {
  const star = pattern.indexOf("*")
  if (star < 0) {
    const dir = resolve(root, pattern)
    if (existsSync(join(dir, "package.json"))) pkgDirs.push(dir)
    continue
  }
  const base = resolve(root, pattern.slice(0, star).replace(/\/$/, ""))
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(base, entry.name)
    if (existsSync(join(dir, "package.json"))) pkgDirs.push(dir)
  }
}
const byName = new Map<string, string>()
for (const dir of pkgDirs) {
  const p = readJson(join(dir, "package.json"))
  if (p?.name) byName.set(p.name, dir)
}

// ---------------------------------------------------------------- 源码地图
const files = walk(modulePath, 6).filter((f) => !f.endsWith("/"))
const codeFiles = files.filter((f) => /\.(ts|tsx|js|jsx|mjs|cjs|css)$/.test(f))
const byDir = new Map<string, { files: number; lines: number }>()
let totalLines = 0
for (const file of codeFiles) {
  const lines = countLines(file)
  totalLines += lines
  const dir = resolve(file, "..")
  const bucket = byDir.get(dir) ?? { files: 0, lines: 0 }
  bucket.files += 1
  bucket.lines += lines
  byDir.set(dir, bucket)
}
const biggest = codeFiles
  .map((f) => ({ file: f, lines: countLines(f) }))
  .sort((a, b) => b.lines - a.lines)
  .slice(0, 8)

// ---------------------------------------------------------------- 依赖与反向依赖
const depFields = ["dependencies", "devDependencies", "peerDependencies"] as const
const ownDeps = new Set<string>()
for (const field of depFields) for (const name of Object.keys(pkg[field] ?? {})) ownDeps.add(name)
const internalDeps = [...ownDeps].filter((name) => byName.has(name)).sort()
const internalConsumers: string[] = []
for (const [name, dir] of byName) {
  if (dir === pkgRoot) continue
  const p = readJson(join(dir, "package.json"))
  const flat = depFields.flatMap((field) => Object.keys(p?.[field] ?? {}))
  if (flat.includes(pkg.name)) internalConsumers.push(name)
}

// ---------------------------------------------------------------- spec 与测试
const noteDir = join(root, "docs/notes")
const notes: string[] = []
if (existsSync(noteDir)) {
  const stack = [noteDir]
  while (stack.length) {
    const dir = stack.pop()!
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        // 与 walk 同一套跳过规则：notes 遍历漏跳 dist 会让产物里的 md 也进清单
        if (!SKIP_DIR.has(entry.name) && !entry.name.startsWith(".")) stack.push(full)
        continue
      }
      if (!entry.name.endsWith(".md")) continue
      // 模块路径出现在正文或文件名里即算相关（notes 单篇都有界，命中就值得读）
      if (read(full).includes(moduleRel === "." ? pkg.name : moduleRel) || entry.name.includes(moduleRel)) {
        notes.push(posix(relative(root, full)))
      }
    }
  }
}
const tests = files.filter((f) => /\.(test|spec)\.(ts|tsx)$/.test(f)).map((f) => posix(relative(root, f)))
// 模块内没有测试时，找包级 test/ 下与模块同名的目录（本仓惯例：src/session ↔ test/session）
const lastSegment = moduleRel.split("/").at(-1)!
const mirroredTests = tests.length
 ? []
 : walk(join(pkgRoot, "test"), 4)
     .filter((f) => /\.(test|spec)\.(ts|tsx)$/.test(f))
     .filter((f) => posix(relative(pkgRoot, f)).split("/").includes(lastSegment))
     .map((f) => posix(relative(root, f)))

// ---------------------------------------------------------------- 输出
const out: string[] = []
const line = (text = "") => out.push(text)

line(`# Module reading pack: ${posix(relative(root, modulePath))}`)
line(`repo ${posix(root)} @ ${gitHead().slice(0, 8) || "unknown"} · ${new Date().toISOString()}`)
line()

line("## Package")
line(`${pkg.name} · ${pkg.version ?? "no version"} · ${posix(relative(root, pkgRoot))}`)
const scripts = Object.keys(pkg.scripts ?? {}).filter((s) => /^(dev|build|typecheck|test|lint)/.test(s))
if (scripts.length) line(`scripts: ${scripts.join(" · ")}`)
line()

line("## Public entrypoints")
const exportMap = pkg.exports
if (exportMap && typeof exportMap === "object") {
  for (const [key, value] of Object.entries(exportMap)) {
    const nested = typeof value === "string" ? undefined : (value as { import?: unknown; default?: unknown })
    const target =
      typeof value === "string" ? value : typeof nested?.import === "string" ? nested.import : typeof nested?.default === "string" ? nested.default : undefined
    if (typeof target !== "string") continue
    const resolved = resolve(pkgRoot, target.replace(/^\.\//, ""))
    line(`- ${key} → ${posix(relative(root, resolved))}${existsSync(resolved) ? "" : "  (missing)"}`)
  }
} else {
  // as const 让 field 收窄成字面量联合，pkg[field] 才有确定类型——写成 string[] 会撞
  // TS7053（PackageJson 没有索引签名），而那正是 any 时代被静默吞掉的一类错。
  for (const field of ["main", "module", "types"] as const) {
    const target = pkg[field]
    if (typeof target === "string") line(`- ${field} → ${target}`)
  }
}
const moduleIndex = ["index.ts", "index.tsx", "index.js"].map((f) => join(modulePath, f)).find(existsSync)
if (moduleIndex) line(`- module index → ${posix(relative(root, moduleIndex))}`)
line()

line("## Source map")
line(`${codeFiles.length} code files · ${totalLines} lines · module "${moduleRel}"`)
for (const [dir, bucket] of [...byDir.entries()].sort((a, b) => b[1].lines - a[1].lines)) {
  line(`- ${posix(relative(root, dir))}/  ${bucket.files} files · ${bucket.lines} lines`)
}
if (biggest.length) {
  line()
  line("largest files (read these first):")
  for (const item of biggest) line(`- ${posix(relative(root, item.file))}  ${item.lines}`)
}
line()

line("## Internal dependencies")
line(internalDeps.length ? internalDeps.map((n) => `${n} (${posix(relative(root, byName.get(n)!))})`).join("\n") : "(none)")
line()
line("## Consumed by (package level)")
line(internalConsumers.length ? internalConsumers.map((n) => `${n} (${posix(relative(root, byName.get(n)!))})`).join("\n") : "(no workspace package depends on it)")
line()

line("## Specs & decision notes")
line(notes.length ? notes.map((n) => `- ${n}`).join("\n") : "(none matched)")
line()
line("## Tests")
if (tests.length) line(tests.map((t) => `- ${t}`).join("\n"))
else if (mirroredTests.length) {
 line(`(模块内无测试，包级 test/ 下同名目录 ${mirroredTests.length} 个)`)
 line(mirroredTests.map((t) => `- ${t}`).join("\n"))
} else line("(none in this module)")

console.log(out.join("\n"))
