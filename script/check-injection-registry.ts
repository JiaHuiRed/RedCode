// 261024 Red 注入登记表自检（模型可见四问的机器门禁）
//
// 不变量：
//   ① docs/injection-registry.jsonc 每行的锚点（match）仍能在其 file 里找到——
//      注入代码被改名/搬移/删除而登记表没跟上，commit 时就红（「误配置要响」）。
//   ② prompt.ts 里每个 system.push(...) 上方 3 行内必须有 `// injection-registry: <id>`
//      回链注释，与登记表 push 行双向一一对应——新增注入忘了登记直接被拦。
//   ③ 每行必须声明 cap（具体字节数或 bounded-by:<机制>）——四问第 4 条的断言化。
//
// 两种模式：
//   默认                  校验 ①②③（pre-commit：staged 触及登记面时跑，瞬时）
//   --commit-msg <file>   staged 与登记文件相交时，要求 commit message 含「四问」
//                         （.husky/commit-msg 调用；语义半仍靠人答，机器只管「忘了问」）
//
// 决策与边界见 docs/notes/implemented/process/2026-10-24-injection-registry-gate.md
import { readFileSync } from "fs"
import { join, dirname, resolve } from "path"
import { fileURLToPath } from "url"
import { parse, type ParseError } from "jsonc-parser"

const __dirname = dirname(fileURLToPath(import.meta.url))
// 261024 Red RC-A05 测试钩子：仅 NODE_ENV=test（bun test 默认置位）允许把 root 指到
// 临时 git 仓库做部分暂存负测试；真实钩子环境不受影响。
const root =
  process.env.NODE_ENV === "test" && process.env.RC_GATE_TEST_ROOT
    ? resolve(process.env.RC_GATE_TEST_ROOT)
    : join(__dirname, "..")

const REGISTRY = "docs/injection-registry.jsonc"
const PROMPT_TS = "packages/opencode/src/session/prompt.ts"
const CHANNELS = new Set(["prefix", "per-turn", "conditional", "output", "history"])

interface Row {
  id: string
  file: string
  match: string
  channel: string
  cap: string
  stability: string
  push?: boolean
  note?: string
}

function fail(lines: string[]): never {
  console.log("")
  console.log("=== 注入登记表自检 ===")
  for (const line of lines) console.log(line)
  console.log("")
  console.log(`修复：更新 ${REGISTRY}（锚点/回链/cap），或给新注入补 // injection-registry: <id> 注释`)
  process.exit(1)
}

function loadRegistry(): Row[] {
  const text = contentFor(REGISTRY)
  if (text === undefined) fail([`${REGISTRY} 不在待提交快照（index）中——staged 删除或从未 add`])
  // 261024 Red RC-A01 ParseError[] 才是 parse 的签名；unknown[] 在 CI typecheck 直接红
  const errors: ParseError[] = []
  const parsed = parse(text, errors, { allowTrailingComma: true }) as { items?: Row[] } | undefined
  if (errors.length > 0 || !parsed?.items || !Array.isArray(parsed.items)) fail([`${REGISTRY} 解析失败`])
  return parsed.items
}

// 261024 Red RC-A05 复验补刀：统一从 git index 读。index 就是待提交的完整快照——
// 按 stagedFiles 切来源有反向漏洞：暂存新登记表（新锚点）+ 源码只改工作区不暂存，
// 门禁拿「index 登记表 × 工作区源码」假通过，提交后锚点失效。不在 index 的文件
// （未跟踪/被 staged 删除）同样不进提交树，一律按不存在处理，不留工作区后门。
function contentFor(path: string): string | undefined {
  const shown = Bun.spawnSync(["git", "show", `:${path}`], { cwd: root })
  return shown.exitCode === 0 ? shown.stdout.toString() : undefined
}

// --- 默认模式：登记表静态校验 ---
function validate() {
  const items = loadRegistry()
  const problems: string[] = []
  const seen = new Set<string>()

  for (const row of items) {
    const head = `[${row.id ?? "?"}]`
    if (!row.id || !row.file || !row.match || !row.cap || !row.stability) {
      problems.push(`${head} 字段缺失（id/file/match/cap/stability 必填）`)
      continue
    }
    if (seen.has(row.id)) problems.push(`${head} id 重复`)
    seen.add(row.id)
    if (!CHANNELS.has(row.channel)) problems.push(`${head} channel 非法：${row.channel}`)
    // ① 锚点有效（staged 文件验 index 版本，防「工作区修好、暂存还是坏的」假通过）
    const source = contentFor(row.file)
    if (source === undefined) {
      problems.push(`${head} file 不存在：${row.file}`)
      continue
    }
    if (!source.includes(row.match)) problems.push(`${head} 锚点失效：${row.file} 中找不到 match 子串`)
  }

  // ② prompt.ts 的 system.push 回链双向核对
  const promptText = contentFor(PROMPT_TS)
  if (promptText === undefined) fail([`${PROMPT_TS} 读取失败（staged 删除或工作区缺失）——登记面文件不能没有它`])
  const promptLines = promptText.split(/\r?\n/)
  const backlinks = new Set<string>()
  promptLines.forEach((line, i) => {
    if (!/\bsystem\.push\(/.test(line)) return
    const id = findBacklink(promptLines, i)
    if (id === undefined) {
      problems.push(`prompt.ts:${i + 1} system.push 无 injection-registry 回链注释（上方 3 行内）`)
      return
    }
    backlinks.add(id)
  })
  const pushRows = new Set(items.filter((row) => row.push === true).map((row) => row.id))
  for (const id of backlinks) if (!pushRows.has(id)) problems.push(`回链 ${id} 不在登记表（或未标 push:true）`)
  for (const id of pushRows) if (!backlinks.has(id)) problems.push(`登记行 ${id} 标了 push:true 但 prompt.ts 无回链`)

  // ③ cap 是必填字段，缺失已在字段检查里拦；这里再拦空串
  for (const row of items) if (row.id && typeof row.cap === "string" && row.cap.trim() === "")
    problems.push(`[${row.id}] cap 为空——没有上限就是缺陷不是待办（AGENTS.md 四问第 4 条）`)

  console.log(`=== 注入登记表自检 ===`)
  if (problems.length > 0) {
    console.log(`  ✗ ${problems.length} 个问题：`)
    for (const p of problems) console.log(`    - ${p}`)
    console.log("")
    console.log(`修复：更新 ${REGISTRY}，或给新注入补回链注释`)
    process.exit(1)
  }
  console.log(`  ✅ ${items.length} 个登记项锚点/回链/cap 全部有效（system.push 回链 ${backlinks.size} 处）`)
}

function findBacklink(lines: string[], pushLine: number): string | undefined {
  for (let i = pushLine; i >= Math.max(0, pushLine - 3); i--) {
    const m = lines[i]?.match(/injection-registry:\s*([\w-]+)/)
    if (m) return m[1]
  }
  return undefined
}

// --- commit-msg 模式：登记面改动必须带「四问」 ---
function commitMsg(msgFile: string) {
  const staged = Bun.spawnSync(["git", "diff", "--cached", "--name-only"], { cwd: root }).stdout.toString().split(/\r?\n/)
  const registryFiles = new Set(loadRegistry().map((row) => row.file))
  registryFiles.add(REGISTRY)
  registryFiles.add(PROMPT_TS)
  const hit = staged.filter((f) => registryFiles.has(f))
  if (hit.length === 0) process.exit(0)
  const msg = readFileSync(msgFile, "utf8")
  if (!msg.includes("四问")) {
    console.log("=== 注入面改动需答模型可见四问 ===")
    console.log(`  本次 staged 触及登记项文件：${hit.join(", ")}`)
    console.log(`  commit message 必须含「四问」并在正文逐条回答（改了什么/token 增减/KV cache 影响/上限）。`)
    console.log(`  登记表：${REGISTRY}`)
    process.exit(1)
  }
  process.exit(0)
}

const msgFlag = process.argv.indexOf("--commit-msg")
if (msgFlag !== -1 && process.argv[msgFlag + 1]) commitMsg(process.argv[msgFlag + 1])
else validate()
