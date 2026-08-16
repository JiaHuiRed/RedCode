// 260815 重建：原 export-memory-backup.mjs 丢失，按 lessons-backup.Lin.md 格式重写
// 用法：bun ~/.redcode/scripts/export-memory-backup.mjs
// 导出 supermemory.db 全部条目 → memory/lessons-backup.<hostname>.md（入库推送，跨机可见）
import { Database } from "bun:sqlite"
import { hostname, homedir } from "node:os"
import { join } from "node:path"

const db = new Database(join(homedir(), ".redcode", "supermemory.db"), { readonly: true })
const rows = db
  .query("SELECT id, content, project, source, created_at FROM memories ORDER BY id")
  .all()

const host = hostname()
const now = new Date()
const pad = (n) => String(n).padStart(2, "0")
const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`

const parts = [
  `# 长期记忆全文备份（${host}）`,
  "",
  `> 由本机 supermemory.db 导出，共 ${rows.length} 条。**本文件入库推送**——全文的版本化与`,
  "> 跨机可见靠它（db 本身 gitignore：二进制冲突/进程锁/WAL 撕裂）。按机器分文件名，",
  "> 两台各写各的，不会冲突。",
  "> 重建方式：把下面各条 content 逐条 INSERT 回 memories 表（project/source 见每条标注），",
  "> FTS 由触发器自动同步。",
  `> 重导命令：\`bun ~/.redcode/scripts/export-memory-backup.mjs\`（node 也行）`,
  `> 导出时间：${dateStr}`,
  "",
  "---",
  "",
]

for (const row of rows) {
  parts.push(`## [${row.source}] id=${row.id} project=${row.project}`, "")
  parts.push(`<!-- created_at: ${row.created_at} -->`, "")
  parts.push(row.content, "", "---", "")
}

const outPath = join(homedir(), ".redcode", "memory", `lessons-backup.${host}.md`)
await Bun.write(outPath, parts.join("\n"))
console.log(`exported ${rows.length} entries -> ${outPath}`)
