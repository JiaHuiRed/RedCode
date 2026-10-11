// 261011 Red 记忆编号防撞的权威判据：编号在 INSERT 时即占用（db），MEMORY.md 索引行
// 滞后于库——同机并行会话实测撞号（261011 #320 被同日另一会话的全文占位，两边 MEMORY.md
// 都只见 #319）。本脚本打印本地 db 当前最大编号；跨机条目 db 看不见（库不随仓同步），
// 需另 fetch 私仓比对 origin 的 memory/lessons-backup.*.md 快照（add-memory.mjs 用
// max(db, MEMORY.md) 双数据源，MEMORY.md 兜跨机、db 兜本机滞后）。
import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"

// content 首行格式「#NN 标题」：substr 取 # 与首个空格之间的数字段，项目条目（[标签] 开头）不匹配
export function maxMemoryId(dbPath = join(homedir(), ".redcode", "supermemory.db")) {
  const db = new Database(dbPath, { readwrite: true })
  const row = db
    .query(
      "SELECT MAX(CAST(substr(content, 2, instr(content, ' ') - 2) AS INTEGER)) AS max FROM memories WHERE content LIKE '#%'",
    )
    .get()
  db.close()
  return row.max ?? 0
}

if (import.meta.main) console.log(maxMemoryId(process.argv[2]))
