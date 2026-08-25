#!/usr/bin/env bun
// 260825 Karina 记忆双写核对：MEMORY.md 索引行（#NN）↔ supermemory.db 全文一一对应
// 安全带第一档：只检查能被确定性判定的部分——全局编号条目（MEMORY.md 里的 "#NN " 索引行）
// 项目条目（[项目名·踩坑] 标题（YYMMDD））不编号、无严格契约，暂不硬查（宁漏勿误）。
// 用法：bun ~/.redcode/scripts/check-memory-dualwrite.mjs
//       退出码 0 = 全部对应；1 = 有索引行缺全文（挂 hook 时可阻断）
// 只读打开 db，避免与 MCP 服务的 supermemory.db 进程锁冲突
import { readFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"

const MEMORY_PATH = process.env.REDCODE_MEMORY || path.join(homedir(), ".redcode", "MEMORY.md")
const DB_PATH = path.join(homedir(), ".redcode", "supermemory.db")

if (!existsSync(MEMORY_PATH)) {
  console.log(`(未找到 ${MEMORY_PATH})`)
  process.exit(1)
}
if (!existsSync(DB_PATH)) {
  console.log(`(未找到 ${DB_PATH}——记忆库未初始化，跳过核对；初始化后 hook 自动恢复监督)`)
  process.exit(0)
}

// ── 解析 MEMORY.md 的全局编号索引行：抓所有 "#数字" 后跟空格/行尾的模式 ──
const md = readFileSync(MEMORY_PATH, "utf-8")
const nums = new Set()
for (const m of md.matchAll(/#(\d+)(?=\s|$|[|/])/g)) nums.add(m[1])

// ── 查库：project='global' 的 content 首行格式为 "#NN 标题（YYMMDD）" ──
const db = new Database(DB_PATH, { readonly: true })
const rows = db.query("SELECT content FROM memories WHERE project = ?").all("global")
const have = new Set() // db 里已存在全文的 #NN
const dbAll = new Set() // db 里全部以 #NN 开头的编号（含 history）
for (const { content } of rows) {
  const m = content.match(/^#(\d+)\s/)
  if (m) {
    dbAll.add(m[1])
    have.add(m[1])
  }
}
db.close()

// ── 正向：索引行缺全文（这是硬伤——删除唯一入口） ──
const missing = [...nums].filter((n) => !have.has(n)).sort((a, b) => Number(a) - Number(b))
// ── 反向：db 有全文但索引没了（可能是合法归档——consolidate 删索引前先入库的条目） ──
const orphan = [...dbAll].filter((n) => !nums.has(n)).sort((a, b) => Number(a) - Number(b))

const ok = missing.length === 0
if (ok) {
  console.log(`✓ 记忆双写核对通过：MEMORY.md ${nums.size} 个索引行全部有全文（${rows.length} 条 global 记录）`)
} else {
  console.error(`✗ 记忆双写核对失败：${missing.length}/${nums.size} 个索引行缺全文`)
  for (const n of missing) {
    console.error(`  #${n}  在 MEMORY.md 有索引，但 supermemory.db（project='global'）无 content LIKE '#${n} %' 全文——请双写补齐（INSERT memories）`)
  }
}
if (orphan.length > 0) {
  console.log(`(提示：db 有 ${orphan.length} 条全文但索引已不在 MEMORY.md——多为 consolidate 删索引前的合法归档${orphan.length <= 20 ? "：" + orphan.map((n) => "#" + n).join(" ") : ""})`)
}
process.exit(ok ? 0 : 1)
