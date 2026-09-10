#!/usr/bin/env node
// 260910 Red 改走 supermemory.db —— MEMORY.md 自 260812 起只剩索引行（全文在库），旧的
// 「### 教训块」解析器从此恒空，/recall 静默失效（实测「MCP」召不回任何条目）。
// 数据源换成 ~/.redcode/supermemory.db（FTS5 trigram），查询口径与自动召回插件
// memory-recall.js 对齐：分句 → 中英文查询词 → FTS 命中 + 子串校验 → 按票数排序。
// trigram 索引最小 3 字，2 字查询物理上搜不到（实测 MATCH '"代理"' 恒 0 行，'"代理三件套"' 命中）
// → 该长度直接走 LIKE；库只有几百条，全表扫毫秒级。
// 纯 JS(.mjs)：node 与 bun 都能跑，两边 sqlite 模块名/只读选项名不同，按运行时分支。
// 用法：node recall-memory.mjs <关键词...>        搜 global + 当前项目
//       node recall-memory.mjs --all <关键词...>  搜全库（含其他项目）
// 决策记录：docs/notes/implemented/bug-fix/2026-09-10-recall-supermemory-db.md
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import * as fs from "node:fs"

const DB_PATH = process.env.REDCODE_MEMORY_DB || join(homedir(), ".redcode", "supermemory.db")
const LIMIT = Number(process.env.RECALL_LIMIT) || 5
const MAX_CHARS = Number(process.env.RECALL_MAX_CHARS) || 4500 // 注入上限，超出截断，避免召回反而撑爆上下文
const MAX_QUERIES = 24 // 与 memory-recall.js 同上限：查询词再多只是票数噪声
const isBun = typeof globalThis.Bun !== "undefined"

// 260907 Red 项目记忆只对所属工作区可见（同 memory-recall.js）：linked worktree 的 basename
// 是临时分支名，需沿 .git 指针回到主 worktree 名称。
function projectFromWorktree(worktree) {
  if (!worktree) return ""
  const fallback = basename(worktree)
  try {
    const dotGit = join(worktree, ".git")
    if (!fs.statSync(dotGit).isFile()) return fallback
    const target = fs.readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)\s*$/m)?.[1]
    if (!target) return fallback
    const gitdir = resolve(worktree, target)
    if (basename(dirname(gitdir)).toLowerCase() !== "worktrees") return fallback
    return basename(dirname(dirname(dirname(gitdir)))) || fallback
  } catch {
    return fallback
  }
}

let db = null
async function getDb() {
  if (db) return db
  const mod = isBun ? await import("bun:sqlite") : await import("node:sqlite")
  // 双运行时导出名不同：bun:sqlite 是 Database，node:sqlite 是 DatabaseSync
  const Ctor = isBun ? mod.Database : mod.DatabaseSync
  // 只读选项名两边不一样：bun 认小写 readonly，node:sqlite 认驼峰 readOnly。传错 bun 直接抛
  // TypeError，传错 node 会被静默忽略、以读写方式打开（memory-recall.js 260813 踩过）
  db = new Ctor(DB_PATH, isBun ? { readonly: true } : { readOnly: true })
  return db
}

// 分句：中英文标点/换行切分
function splitSentences(text) {
  return text
    .split(/[。；！？!?\n\r]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
}

// 关键词提取：中文段滑 3/4 字窗口（trigram 短语匹配对长句必 miss，必须把粒度降到 3-6 字），
// 2 字段整段（交给 LIKE），英文整词。与 memory-recall.js 的 extractQueries 同口径。
function extractQueries(sentence) {
  const queries = []
  for (const seg of sentence.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    if (seg.length >= 5) {
      for (let i = 0; i + 4 <= seg.length; i += 2) queries.push(seg.slice(i, i + 4))
      for (let i = 0; i + 3 <= seg.length; i += 1) queries.push(seg.slice(i, i + 3))
    } else {
      queries.push(seg)
    }
  }
  queries.push(...(sentence.match(/[a-zA-Z][a-zA-Z0-9._-]{2,}/g) || []))
  return [...new Set(queries)]
}

// project 为空串 = 搜全库（--all，或 cwd 推断不出项目名）
function scopeSql(project, fts) {
  const from = fts
    ? "FROM memories_fts f JOIN memories m ON m.id = f.rowid WHERE memories_fts MATCH ?"
    : "FROM memories m WHERE m.content LIKE ?"
  if (!project) return `SELECT m.id, m.content, m.project ${from} ORDER BY bm25(memories_fts) LIMIT ?`
  return (
    `SELECT m.id, m.content, m.project ${from} AND (m.project = 'global' COLLATE NOCASE OR m.project = ? COLLATE NOCASE)` +
    (fts ? " ORDER BY bm25(memories_fts) LIMIT ?" : " LIMIT ?")
  )
}

function ftsQuery(d, match, limit, project) {
  const stmt = isBun ? d.query(scopeSql(project, true)) : d.prepare(scopeSql(project, true))
  return stmt.all(`"${match.replace(/"/g, '""')}"`, ...(project ? [project] : []), limit)
}

function likeQuery(d, term, limit, project) {
  const stmt = isBun ? d.query(scopeSql(project, false)) : d.prepare(scopeSql(project, false))
  return stmt.all(`%${term}%`, ...(project ? [project] : []), limit)
}

// 260813 cc trigram 是 3 字滑窗索引，"AB C" 与 "A BC" 共享 trigram 就会互相命中，bm25 只排序
// 不设下限 → 只要返回任何行就注入（前车：「写个插件要注意什么」命中的是一条无关旧 MCP 笔记）。
// 这里要求查询词真的出现在正文里；LIKE 分支本身就是子串匹配，天然满足。
function verify(rows, q) {
  const needle = q.toLowerCase()
  return rows.filter((r) => String(r.content ?? "").toLowerCase().includes(needle))
}

const HITS_PER_QUERY = 3

async function recall(d, userText, project) {
  const sentences = splitSentences(userText).slice(0, 6)
  // memory id -> { row, votes } —— 被多个不同查询词命中的条目更可能真相关，用票数排序
  const scored = new Map()
  let queried = 0
  for (const s of sentences) {
    for (const q of extractQueries(s)) {
      if (queried >= MAX_QUERIES) break
      queried++
      let rows = []
      if (q.length >= 3) {
        try {
          rows = verify(ftsQuery(d, q, HITS_PER_QUERY, project), q)
        } catch {
          rows = [] // FTS 语法/索引异常都不该打断召回
        }
      }
      if (rows.length === 0) {
        try {
          rows = verify(likeQuery(d, q, HITS_PER_QUERY, project), q)
        } catch {
          rows = []
        }
      }
      for (const r of rows) {
        const cur = scored.get(r.id)
        if (cur) cur.votes++
        else scored.set(r.id, { ...r, votes: 1 })
      }
    }
    if (queried >= MAX_QUERIES) break
  }
  // 同票按 id 降序：编号只增，新的记忆更可能是当下要找的
  const ranked = [...scored.values()].sort((a, b) => b.votes - a.votes || b.id - a.id).slice(0, LIMIT)
  return { ranked, queried }
}

// ── 主流程 ────────────────────────────────────────────
const args = process.argv.slice(2)

if (args[0] === "--index") {
  console.log("(--index 已废弃：记忆全文存于 supermemory.db，检索走 FTS5，无需预计算 embedding)")
  process.exit(0)
}

const all = args.includes("--all")
const query = args.filter((a) => a !== "--all").join(" ").trim()
if (!query) {
  console.log(
    "用法：/recall <关键词>　例：/recall 代理 / /recall MCP 进程泄漏\n      --all　连其他项目的记忆一起搜",
  )
  process.exit(0)
}
if (!fs.existsSync(DB_PATH)) {
  console.log(`(未找到记忆库 ${DB_PATH}，无记忆可召回)`)
  process.exit(0)
}

const project = all ? "" : projectFromWorktree(process.cwd())
const d = await getDb()
const { ranked } = await recall(d, query, project)

if (ranked.length === 0) {
  console.log(`(没搜到与「${query}」相关的记忆。换个关键词，或直接查库：${DB_PATH})`)
  process.exit(0)
}

const scope = all ? "全库" : `global + ${project || "（项目名未识别，仅 global）"}`
const parts = [`## 召回「${query}」相关记忆（${ranked.length} 条，${scope}）`]
for (const [i, r] of ranked.entries()) {
  const [head, ...rest] = String(r.content).split("\n")
  parts.push(`### ${i + 1}. [${r.project}] ${head.trim()}\n${rest.join("\n").trim()}`)
}
const text = parts.join("\n\n")
console.log(text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + "\n…(已截断)" : text)
