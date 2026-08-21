// 260821 cc OpenAPI 生成物漂移自检
//
// 不变量：packages/sdk/openapi.json 必须与 `redcode generate` 的当前输出逐字节相同。
//
// 由来见 script/generate.ts 的注释 —— 生成路径曾指向不存在的 packages/redcode，
// 于是 openapi.json 长期靠手改维护、悄悄落后于源 schema，没有任何东西会报错。
// 路径 260819 修好了，但"修好"不等于"不会再烂"：CI 三个 workflow 都不跑生成，
// 下一次有人改了 server 的契约却忘记重跑，仍然一个字都不会响。
//
// 这个脚本把"忘记重跑"变成红色测试：重新生成一遍，和仓里的比，不一致就 exit 1，
// 并打印出到底哪些 path / schema 变了 + 一行修复命令。
//
// generate 是纯函数（Server.openapi() → prettier → stdout，不写任何文件），
// 所以这个检查没有副作用，可以放心进 CI 和 pre-push。
import { readFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")

const COMMITTED = "packages/sdk/openapi.json"
const FIX = "bun run gen:openapi"
// 生成要起整个 server 模块图，冷启在慢盘上能到几十秒；给足余量但必须有上限，
// 否则 CI 挂住时和 260821 那批无超时子进程是同一种病 —— 日志一个字都没有。
const TIMEOUT_MS = 180_000

function fail(lines: string[]): never {
  console.log("")
  console.log("=== OpenAPI 生成物漂移自检 ===")
  console.log("")
  for (const l of lines) console.log(`  ${l}`)
  console.log("")
  console.log(`  ❌ ${COMMITTED} 与源 schema 不一致`)
  console.log(`     修复：${FIX}`)
  console.log("")
  process.exit(1)
}

const proc = Bun.spawn(["bun", "run", "--conditions=browser", "./src/index.ts", "generate"], {
  cwd: join(root, "packages", "opencode"),
  stdout: "pipe",
  stderr: "pipe",
  // subprocess-timeout: 显式上限，超时按失败处理而不是静默挂死
  timeout: TIMEOUT_MS,
})

const [fresh, stderr, exitCode] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
])

if (exitCode !== 0 || fresh.length === 0) {
  fail([
    `generate 执行失败（exit=${exitCode}${proc.killed ? "，已超时" : ""}）`,
    ...(stderr.trim() ? stderr.trim().split("\n").slice(0, 15).map((l) => `  ${l}`) : ["  （无 stderr 输出）"]),
  ])
}

let committed: string
try {
  committed = readFileSync(join(root, COMMITTED), "utf-8")
} catch (error) {
  fail([`读不到 ${COMMITTED}：${error instanceof Error ? error.message : String(error)}`])
}

if (fresh === committed) {
  console.log("")
  console.log("=== OpenAPI 生成物漂移自检 ===")
  console.log("")
  console.log(`  ✅ ${COMMITTED} 与源 schema 一致（${fresh.length} 字符）`)
  console.log("")
  process.exit(0)
}

// ---- 以下只在不一致时跑：把 645KB 的差异翻译成人能读的东西 ----

/** 列出 spec 里所有 "METHOD /path" 操作；解析失败返回 undefined，退化成纯文本 diff。 */
function operations(text: string): Set<string> | undefined {
  try {
    const spec: { paths?: Record<string, Record<string, unknown>> } = JSON.parse(text)
    const out = new Set<string>()
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      for (const method of Object.keys(item)) out.add(`${method.toUpperCase()} ${path}`)
    }
    return out
  } catch {
    return undefined
  }
}

function schemaNames(text: string): Set<string> | undefined {
  try {
    const spec: { components?: { schemas?: Record<string, unknown> } } = JSON.parse(text)
    return new Set(Object.keys(spec.components?.schemas ?? {}))
  } catch {
    return undefined
  }
}

function delta(label: string, fresh: Set<string> | undefined, old: Set<string> | undefined): string[] {
  if (!fresh || !old) return []
  const added = [...fresh].filter((k) => !old.has(k)).sort()
  const removed = [...old].filter((k) => !fresh.has(k)).sort()
  const out: string[] = []
  for (const k of added.slice(0, 20)) out.push(`  + ${label} ${k}`)
  if (added.length > 20) out.push(`  + …还有 ${added.length - 20} 个新增${label}`)
  for (const k of removed.slice(0, 20)) out.push(`  - ${label} ${k}`)
  if (removed.length > 20) out.push(`  - …还有 ${removed.length - 20} 个删除${label}`)
  return out
}

const freshLines = fresh.split("\n")
const oldLines = committed.split("\n")
const firstDiff = freshLines.findIndex((l, i) => l !== oldLines[i])

const report: string[] = [
  `字符数  生成=${fresh.length}  仓库=${committed.length}`,
  `首个差异行  ${firstDiff < 0 ? "（仅长度不同）" : `#${firstDiff + 1}`}`,
  "",
]

const opDelta = delta("端点", operations(fresh), operations(committed))
const schemaDelta = delta("schema", schemaNames(fresh), schemaNames(committed))

if (opDelta.length || schemaDelta.length) {
  report.push("结构变化（+ 生成有 / - 仓库有）：", ...opDelta, ...schemaDelta, "")
} else {
  report.push("端点与 schema 名单相同，差异在字段层。前 8 行：", "")
  for (let i = firstDiff < 0 ? 0 : firstDiff, shown = 0; i < freshLines.length && shown < 8; i++) {
    if (freshLines[i] === oldLines[i]) continue
    report.push(`  #${i + 1}  - ${(oldLines[i] ?? "（无此行）").trim().slice(0, 100)}`)
    report.push(`      + ${(freshLines[i] ?? "（无此行）").trim().slice(0, 100)}`)
    shown++
  }
  report.push("")
}

fail(report)
