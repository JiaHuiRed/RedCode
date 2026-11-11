// 261012 Red 配置遮蔽审计：local / jsonc / seed 三层同名键值冲突报告。
//
// 背景：RedCode 配置是多层合并（remeda mergeDeep，叶子级逐键遮蔽，local 层优先）。
// 261012 实测踩坑：`redcode.local.jsonc` 里残留 trigger_tokens 250000，遮蔽了
// `redcode.jsonc` 里新改的 360000，引擎按旧值触发压缩——「明明改了配置却没生效」。
// 本工具把三层配置扁平化后全键对比，列出所有遮蔽点，供人工裁决哪些是本机有意覆盖、
// 哪些是忘了同步的遗留值。
//
// 用法：bun script/check-config-shadowing.ts
// 退出码：0 = 无漂移；1 = jsonc 与 seed 存在未登记的结构差异；2 = 配置文件解析失败。
// 注意：local 遮蔽 jsonc 的冲突不等于错误（本机 venv 路径、私有 provider 都是有意
// 覆盖），local 层不参与判定。判定只针对 jsonc 与 seed：模板只补缺不覆盖已有，
// live 改了不跟，新机器就少一块能力（261111 实测：jcodemunch 白名单少三个工具、
// su-prememory 白名单留空）。确有本机理由的差异登记到 LOCAL_OVERRIDES 并写清原因；
// 不登记就失败——宁可响，不静默跳过。
import { homedir } from "os"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { readFileSync } from "fs"
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")
const home = homedir()

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function flatten(value: unknown, prefix = "", out: Record<string, unknown> = {}) {
  if (!isRecord(value)) return out
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (isRecord(item)) flatten(item, path, out)
    else out[path] = Array.isArray(item) ? JSON.stringify(item) : item
  }
  return out
}

function diffKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return Object.keys(a)
    .filter((k) => k in b && JSON.stringify(a[k]) !== JSON.stringify(b[k]))
    .sort()
}

function display(path: string, value: unknown) {
  return /(?:key|token|secret|password|authorization|credential)/i.test(path.split(".").at(-1) ?? "")
    ? '"[REDACTED]"'
    : JSON.stringify(value)
}

// 261111 Red 允许的本机覆盖：值不同但合法。新增条目必须写清为什么模板不该跟。
const LOCAL_OVERRIDES = new Map<string, string>([
  ["mcp.jcodemunch.command", "本机用 venv 绝对路径启动，模板给通用 uvx"],
  ["disabled_providers", "本机禁用列表按可用账号调整"],
  ["mcp.web-search.environment.HTTP_PROXY", "本机代理端口，模板不能写死"],
])

let failed = false
function load(path: string, optional = false): Record<string, unknown> {
  try {
    const errors: ParseError[] = []
    const value = parseJsonc(readFileSync(path, "utf8"), errors, { allowTrailingComma: true })
    if (errors.length) throw new Error(errors.map((error) => printParseErrorCode(error.error)).join(", "))
    return flatten(value)
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return {}
    console.error(`[check-config-shadowing] failed to parse ${path}: ${error}`)
    failed = true
    return {}
  }
}

const local = load(join(home, ".redcode", "redcode.local.jsonc"), true)
const main = load(join(home, ".redcode", "redcode.jsonc"))
const seed = load(join(root, "seed", "redcode.home.jsonc"))
if (failed) process.exit(2)

console.log("=== local 遮蔽 jsonc（同键不同值，逐条裁决是否有意）===")
const shadowed = diffKeys(local, main)
for (const key of shadowed) {
  console.log(`  ${key}`)
  console.log(`    local: ${display(key, local[key])}`)
  console.log(`    jsonc: ${display(key, main[key])}`)
}
if (shadowed.length === 0) console.log("  (none)")

console.log("=== local 独有（纯本机层，通常无需处理）===")
const localOnly = Object.keys(local).filter((k) => !(k in main)).sort()
for (const key of localOnly) console.log(`  ${key} = ${display(key, local[key])}`)
if (localOnly.length === 0) console.log("  (none)")

console.log("=== jsonc 与 seed 不同（参考：seed 只补缺不覆盖已有）===")
const seedDiff = diffKeys(main, seed)
for (const key of seedDiff) {
  console.log(`  ${key}`)
  console.log(`    jsonc: ${display(key, main[key])}`)
  console.log(`    seed:  ${display(key, seed[key])}`)
}
if (seedDiff.length === 0) console.log("  (none)")

// 261111 Red 判定：key 集合双向相等 + 值逐条一致，未登记即失败。
const jsoncOnly = Object.keys(main)
  .filter((key) => !(key in seed) && !LOCAL_OVERRIDES.has(key))
  .sort()
const seedOnly = Object.keys(seed)
  .filter((key) => !(key in main) && !LOCAL_OVERRIDES.has(key))
  .sort()
const drifted = seedDiff.filter((key) => !LOCAL_OVERRIDES.has(key))
const stale = [...LOCAL_OVERRIDES.keys()].filter((key) => {
  const inMain = key in main
  const inSeed = key in seed
  if (inMain !== inSeed) return false
  return !inMain || main[key] === seed[key]
})

console.log("=== 门禁：jsonc 与 seed 必须同步（本机定制登记在 LOCAL_OVERRIDES）===")
if (jsoncOnly.length === 0 && seedOnly.length === 0 && drifted.length === 0) {
  console.log(`  ✅ 无未登记差异（已登记本机覆盖 ${LOCAL_OVERRIDES.size} 条）`)
} else {
  for (const key of drifted) console.log(`  ❌ 值不同：${key}`)
  for (const key of jsoncOnly) console.log(`  ❌ 只在 jsonc：${key}`)
  for (const key of seedOnly) console.log(`  ❌ 只在 seed：${key}`)
  console.error(
    `[check-config-shadowing] ${jsoncOnly.length + seedOnly.length + drifted.length} 处未登记的漂移：同步另一边，或确有本机理由则登记到 LOCAL_OVERRIDES。`,
  )
  process.exit(1)
}
if (stale.length) console.log(`  ℹ️ 已失效的本机覆盖登记（可删除）：${stale.join(", ")}`)
