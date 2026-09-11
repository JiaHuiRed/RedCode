// 260815 重建：原 export-memory-backup.mjs 丢失，按 lessons-backup.Lin.md 格式重写
// 260911 过滤：入库快照只装**该跨机共享**的项目（默认 global）。此前是整库导出，与被共享范围
//   无关的工作项目也一并进了私仓——共享面本该只有跨项目通用的经验教训。全库另导一份到
//   memory/local-backup.<host>.md（.gitignore 内，仅本机防 db 写坏，不入库）。
//   环境变量 REDCODE_BACKUP_PROJECTS 可扩展入库项目（逗号分隔，默认 "global"）。
// 用法：bun ~/.redcode/scripts/export-memory-backup.mjs
import { Database } from "bun:sqlite"
import { hostname, homedir } from "node:os"
import { join } from "node:path"

const db = new Database(join(homedir(), ".redcode", "supermemory.db"), { readonly: true })
const rows = db
  .query("SELECT id, content, project, source, created_at FROM memories ORDER BY id")
  .all()

const sharedProjects = (process.env.REDCODE_BACKUP_PROJECTS ?? "global")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
const shared = rows.filter((row) => sharedProjects.includes(row.project))

const host = hostname()
const now = new Date()
const pad = (n) => String(n).padStart(2, "0")
const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`

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

const dir = join(homedir(), ".redcode", "memory")
const sharedPath = join(dir, `lessons-backup.${host}.md`)
const localPath = join(dir, `local-backup.${host}.md`)

await Bun.write(
  sharedPath,
  render(
    "跨机共享记忆备份",
    `由本机 supermemory.db 导出，仅含 ${sharedProjects.join(" / ")}，共 ${shared.length} 条。**本文件入库推送**——` +
      "跨机共享的唯一通路（db 本身 gitignore），按机器分文件名不冲突。重建方式：逐条 INSERT 回 memories 表" +
      "（project/source 见每条标注），FTS 由触发器自动同步。",
    shared,
  ),
)
await Bun.write(
  localPath,
  render(
    "本机全量记忆备份（不入库）",
    `由本机 supermemory.db 导出，全库 ${rows.length} 条（含工作项目）。**本文件在 .gitignore 内、不推送**——` +
      "只作 db 被写坏/篡改时的本机恢复源。需要跨机的项目请设 REDCODE_BACKUP_PROJECTS。",
    rows,
  ),
)
console.log(`shared ${shared.length} entries -> ${sharedPath}`)
console.log(`local  ${rows.length} entries -> ${localPath}`)
