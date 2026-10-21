// 260815 重建：原 export-memory-backup.mjs 丢失，按 lessons-backup.Lin.md 格式重写
// 260911 过滤：入库快照只装**该跨机共享**的项目（默认 global）
// 261021 Red 由「跨机快照」改为「本机滚动备份」。长期记忆不再跨机同步（两台机各自独立维护），
//   快照链路的唯一用途只剩「db 被写坏/误删时的本机恢复源」，于是落点从随仓的
//   memory/lessons-backup.<host>.md 改成 ~/.redcode/backup/memory/ 下按日期滚动的副本：
//   每天一份（同日重跑覆盖）、保留最近 7 份、不进 git。入仓载荷只剩 soul / skill / plugin / 配置。
// 用法：bun ~/.redcode/scripts/export-memory-backup.mjs
import { Database } from "bun:sqlite"
import { mkdirSync, readdirSync, unlinkSync } from "node:fs"
import { hostname, homedir } from "node:os"
import { join } from "node:path"

const KEEP = 7

const db = new Database(join(homedir(), ".redcode", "supermemory.db"), { readonly: true })
const rows = db.query("SELECT id, content, project, source, created_at FROM memories ORDER BY id").all()

const host = hostname()
const now = new Date()
const pad = (n) => String(n).padStart(2, "0")
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
const dateStr = `${stamp} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`

const render = (title, note, list) => {
  const head = [`# ${title}（${host}）`, "", `> ${note}`, `> 导出时间：${dateStr}`, "", "---", ""]
  const body = list.flatMap((row) => [
    `## [${row.source}] id=${row.id} project=${row.project}`,
    "",
    `<!-- created_at: ${row.created_at} -->`,
    "",
    row.content,
    "",
    "---",
    "",
  ])
  return [...head, ...body].join("\n")
}

const dir = join(homedir(), ".redcode", "backup", "memory")
mkdirSync(dir, { recursive: true })
const target = join(dir, `memory-${stamp}.md`)

await Bun.write(
  target,
  render(
    "本机记忆滚动备份",
    `由本机 supermemory.db 导出，全库 ${rows.length} 条。**不进 git、不跨机**——只作 db 写坏/误删时的` +
      "本机恢复源，保留最近 " +
      `${KEEP} 份。重建方式：逐条 INSERT 回 memories 表（project/source 见每条标注），FTS 由触发器自动同步。`,
    rows,
  ),
)

// 滚动清理：文件名带 ISO 日期，字典序即时间序
const stale = readdirSync(dir)
  .filter((name) => /^memory-\d{4}-\d{2}-\d{2}\.md$/.test(name))
  .sort()
  .slice(0, -KEEP)
for (const name of stale) unlinkSync(join(dir, name))

console.log(`backup ${rows.length} entries -> ${target}`)
if (stale.length > 0) console.log(`pruned ${stale.length}: ${stale.join(", ")}`)
