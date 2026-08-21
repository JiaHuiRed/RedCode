// 260821 cc 子进程超时不变量自检
//
// 不变量：每一处 appProcess.run(...) 都必须显式声明 timeout。
// 由来见 docs/notes/implemented/bug-fix/2026-08-21-subprocess-timeout-git.md ——
// 支线 B 的八个调用点全线无超时躺了近一个月，靠的是人记得，而人不记得。
// 唯一豁免方式是在调用行上方写一行显式理由，让例外可见而不是静默：
//   // subprocess-timeout: none — <为什么这里不能有上限>
//
// 检测方式是文本扫描而非类型分析：先找出绑定到 AppProcess.Service 的变量名
// （所以调用方改名不会让检查失效），再抓这些名字上的 .run( 调用。
import { readdirSync, readFileSync, statSync } from "fs"
import { join, dirname, relative, sep } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, "..")

const EXEMPT = /\/\/\s*subprocess-timeout:\s*none\s*[—-]\s*\S/
const WORD = /[A-Za-z0-9_$]/
const SPACE = /\s/
const TIMEOUT = /\btimeout\b/
const BINDING = /const\s+(\w+)\s*=\s*yield\*\s*AppProcess\.Service/g

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full)
  }
  return out
}

/** 从 "(" 起做括号配平，返回参数原文；字符串与模板串里的括号不计入。 */
function callArgs(text: string, openParen: number): string {
  let depth = 0
  let quote: string | undefined
  for (let i = openParen; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === "\\") i++
      else if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch
    else if (ch === "(") depth++
    else if (ch === ")") {
      depth--
      if (depth === 0) return text.slice(openParen + 1, i)
    }
  }
  return text.slice(openParen + 1)
}

const roots = readdirSync(join(root, "packages"))
  .map((pkg) => join(root, "packages", pkg, "src"))
  .filter((dir) => {
    try {
      return statSync(dir).isDirectory()
    } catch {
      return false
    }
  })

const files = roots.flatMap((dir) => walk(dir))
const violations: string[] = []
const blind: string[] = []
let bindings = 0
let checked = 0

for (const file of files) {
  const text = readFileSync(file, "utf-8")
  const bound = new Set([...text.matchAll(BINDING)].map((m) => m[1]))
  if (!bound.size) continue
  bindings += bound.size
  const rel = relative(root, file).split(sep).join("/")
  let attributed = 0

  // 从 ".run" 往前跳空白再取接收者标识符：调用可能被 prettier 折成
  // appProcess 换行再 .run( ——直接找 "appProcess.run(" 会漏掉它。
  // 第一版就是这么漏掉 format/index.ts 那处的，下面的盲区断言就是为它加的。
  for (let from = 0; ; ) {
    const dot = text.indexOf(".run", from)
    if (dot < 0) break
    from = dot + 4
    let after = dot + 4
    while (after < text.length && SPACE.test(text[after]!)) after++
    if (text[after] !== "(") continue
    let end = dot
    while (end > 0 && SPACE.test(text[end - 1]!)) end--
    let start = end
    while (start > 0 && WORD.test(text[start - 1]!)) start--
    const receiver = text.slice(start, end)
    if (!bound.has(receiver)) continue
    attributed++
    checked++
    if (TIMEOUT.test(callArgs(text, after))) continue
    const line = text.slice(0, dot).split("\n").length
    const prev = text.split("\n")[line - 2] ?? ""
    if (EXEMPT.test(prev)) continue
    violations.push(rel + ":" + line + "  " + receiver + ".run(...) 没有声明 timeout")
  }

  // 绑定了服务、文本里也有 ".run("，却一处都没归因上——是检测漏了，不是这个文件干净。
  if (attributed === 0 && text.includes(".run(")) blind.push(rel)
}

// 检测失效时必须吵：静默通过比漏检更坏（help 快照那次就是测试从没比对过基线）。
if (bindings === 0) {
  console.error("check-subprocess-timeout: 一个 AppProcess.Service 绑定都没找到——检测失效了，不是仓库干净")
  process.exit(1)
}

if (blind.length) {
  console.error("check-subprocess-timeout: 下列文件绑定了 AppProcess.Service、文本里有 .run( ，却一处都没归因上。")
  console.error("这是检测的盲区，先修检测再谈通过：")
  for (const f of blind) console.error("  " + f)
  process.exit(1)
}

if (violations.length) {
  console.error("check-subprocess-timeout: " + checked + " 处调用中有 " + violations.length + " 处没有超时上限：")
  for (const v of violations) console.error("  " + v)
  console.error("")
  console.error("  无界的子进程等待不会触发 evloop drift 探针，挂起时日志里一个字都没有，用户只能杀进程。")
  console.error("  加 { timeout: ... }，或在调用行上方写 // subprocess-timeout: none — <理由>")
  process.exit(1)
}

console.log("check-subprocess-timeout: " + checked + " 处 appProcess.run 调用全部声明了超时（" + bindings + " 个服务绑定）")
