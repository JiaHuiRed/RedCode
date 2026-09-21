// 260921 Red 记忆写入 helper——把「db 全文 + MEMORY.md 索引」双写从纪律变成工具。
// 背景：#192 漏写库被 pre-commit 门禁抓现行；写一条记忆原本要 3-4 个工具调用。
// 用法：
//   bun add-memory.mjs "<全文>"                      # 全局记忆，自动分配编号 #N
//   bun add-memory.mjs --project redcode "<全文>"    # 项目记忆，不自动编号
//   bun add-memory.mjs --index "主题：关键词" "<全文>" # 同时往 MEMORY.md 新增暂存区追加索引行
//   bun add-memory.mjs --dry-run --index "测试" "测试全文"   # 演练，不落库
//   bun add-memory.mjs --db <path> ...               # 自定义库路径（测试用）
// 编号数据源是 ~/.redcode/MEMORY.md 的索引行（随仓同步、含两机条目），不是本机 db——两机撞号防护。
import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"
import { readFileSync, existsSync } from "node:fs"

const args = process.argv.slice(2)
let project = "global"
let indexLine = null
let dryRun = false
let dbPath = join(homedir(), ".redcode", "supermemory.db")
let memoryPath = join(homedir(), ".redcode", "MEMORY.md")
const rest = []

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--project") project = args[++i]
  else if (args[i] === "--index") indexLine = args[++i]
  else if (args[i] === "--dry-run") dryRun = true
  else if (args[i] === "--db") dbPath = args[++i]
  else if (args[i] === "--memory") memoryPath = args[++i]
  else rest.push(args[i])
}

const content = rest.join(" ").trim()
if (!content) {
  console.error("用法: bun add-memory.mjs [--project <name>] [--index <索引行>] [--dry-run] \"<全文>\"")
  process.exit(1)
}

// --- 编号：扫 MEMORY.md 索引行取最大号（仅 global）---
let nextNum = null
let memoryText = ""
if (existsSync(memoryPath)) {
  memoryText = readFileSync(memoryPath, "utf8")
} else if (project === "global") {
  console.error(`MEMORY.md 不存在: ${memoryPath}`)
  process.exit(1)
}
if (project === "global") {
  const nums = [...memoryText.matchAll(/#(\d{1,3})\b/g)].map((m) => parseInt(m[1], 10))
  nextNum = (nums.length ? Math.max(...nums) : 0) + 1
}

const fullText = project === "global" && nextNum !== null ? `#${nextNum} ${content}` : content
const indexText = project === "global" && nextNum !== null && indexLine ? `#${nextNum} ${indexLine}` : indexLine

// --- 索引行落点：「## 新增暂存」节末尾 ---
function buildNewMemory(text) {
  if (!indexText) return { text, appended: false }
  const lines = text.split("\n")
  const head = lines.findIndex((l) => l.trimStart().startsWith("## ") && l.includes("新增暂存"))
  if (head === -1) {
    console.error("未找到「新增暂存」节，索引行未写入——请手动追加")
    return { text, appended: false }
  }
  let tail = head + 1
  while (tail < lines.length && !lines[tail].startsWith("## ")) tail++
  let insertAt = tail
  while (insertAt > head + 1 && lines[insertAt - 1].trim() === "") insertAt--
  lines.splice(insertAt, 0, "", `- ${indexText}`)
  return { text: lines.join("\n"), appended: true }
}

if (dryRun) {
  console.log(`[dry-run] db=${dbPath} project=${project}`)
  console.log(`[dry-run] INSERT 全文: ${fullText.slice(0, 80)}${fullText.length > 80 ? "…" : ""}`)
  if (indexText) {
    const { text } = buildNewMemory(memoryText)
    console.log(`[dry-run] MEMORY.md 索引行: - ${indexText}`)
    console.log(`[dry-run] MEMORY.md 尾部预览:\n${text.split("\n").slice(-4).join("\n")}`)
  }
  process.exit(0)
}

// --- 落库 ---
const db = new Database(dbPath)
db.exec(
  "CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, project TEXT NOT NULL DEFAULT 'default', source TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))"
)
db.run("INSERT INTO memories (project, content, source) VALUES (?, ?, 'manual')", [project, fullText])
const row = db.query("SELECT id, content FROM memories WHERE id = last_insert_rowid()").get()
db.close()

// --- 落索引 ---
let appended = false
if (indexText) {
  const { text, appended: ok } = buildNewMemory(memoryText)
  if (ok) {
    const { writeFileSync } = await import("node:fs")
    writeFileSync(memoryPath, text, "utf8")
    appended = true
  }
}

console.log(`✅ 已写入 db #${row.id} (project=${project}): ${row.content.slice(0, 60)}${row.content.length > 60 ? "…" : ""}`)
if (indexText) {
  console.log(appended ? `✅ 索引行已追加 MEMORY.md 暂存区: ${indexText}` : `⚠️ 索引行未自动写入，请手动补`)
}
console.log(`提醒: 收工前跑 export-memory-backup.mjs 导快照；MEMORY.md 超阈值先剪再写。`)
