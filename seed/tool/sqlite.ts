// 260812 cc 从 mcp-sqlite-query 搬进来的原生工具（in-process，无子进程）。
// 引擎扫描配置目录下的 {tool,tools}/*.{js,ts} 并动态 import（tool/registry.ts:192），
// 文件名做命名空间：本文件导出的 query/schema → 工具名 sqlite_query / sqlite_schema，
// 与原 MCP 暴露的名字一致，历史会话里的调用习惯不用改。
//
// 相对 MCP 版的差别：
// - 没有 stdio JSON-RPC 往返，也不占一个常驻子进程（启动期不再参与"等所有 MCP 起来"）
// - 拿得到 ctx.ask，写操作能弹权限；MCP 版只能靠 readOnly 自律
// - 改完不用重编 RedCode，下次开会话即生效
import { tool } from "@opencode-ai/plugin"
import * as fs from "node:fs"
import * as path from "node:path"

const READ_PREFIXES = ["select", "with", "explain", "pragma", "analyze"]

function isReadStatement(sql: string) {
  const t = sql.trim().toLowerCase()
  return READ_PREFIXES.some((p) => t.startsWith(p))
}

// 260910 Red 语句计数：跳过字符串字面量与注释，只数真正的分号分隔。多语句走 exec ——
// prepare 只执行第一条且**不报错**（实测 `SELECT 1; SELECT 2` 静默丢掉第二条，写事务里
// 就是「假成功」），这正是以前要记住"拆单条"的根因。
function countStatements(sql: string): number {
  let count = 1
  let quote: string | null = null
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!
    if (quote) {
      if (ch !== quote) continue
      if (sql[i + 1] === quote) i++
      else quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch
      continue
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i)
      if (nl === -1) break
      i = nl
      continue
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2)
      if (end === -1) break
      i = end + 1
      continue
    }
    if (ch === ";" && sql.slice(i + 1).trim().length > 0) count++
  }
  return count
}

// 260812 cc 双运行时：TUI 是编译进 Bun 的单文件二进制，而 GUI 的 sidecar 是
// Electron utilityProcess.fork 起的 **Node**（desktop/src/main/server.ts:111）。
// 顶层 `import { Database } from "bun:sqlite"` 在 Node 侧会直接抛
// ERR_UNSUPPORTED_ESM_URL_SCHEME（实测 Node 24.16），而 registry 加载工具文件用的是
// Effect.promise —— 抛出来是**不可恢复的 defect**，会连累整个工具表，不只是少这一个工具。
// 所以改成运行时按需 import：Bun 用 bun:sqlite，Node 用 node:sqlite（24 起内置，
// prepare/all/get/run 形状一致，实测同一个库输出相同）。
type Row = Record<string, unknown>
type Stmt = { all: (...a: unknown[]) => Row[]; get: (...a: unknown[]) => Row; run: (...a: unknown[]) => { changes: number } }
type Db = { prepare: (sql: string) => Stmt; exec: (sql: string) => void; close: () => void }

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"

async function openDb(dbPath: string, readOnly: boolean): Promise<Db> {
  const abs = path.resolve(dbPath)
  if (!fs.existsSync(abs)) throw new Error(`Database not found: ${abs}`)
  if (isBun) {
    const { Database } = await import("bun:sqlite")
    const db = new Database(abs, { create: false, strict: true })
    db.exec(`PRAGMA query_only = ${readOnly ? 1 : 0}`)
    return db as unknown as Db
  }
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(abs, { readOnly })
  return db as unknown as Db
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`

/** 定宽文本表格；单列宽度上限 60，避免长文本撑破终端 */
function formatTable(rows: Record<string, unknown>[]) {
  if (rows.length === 0) return "(empty result set)"
  const cols = Object.keys(rows[0]!)
  const cell = (v: unknown) => (v === null || v === undefined ? "NULL" : typeof v === "bigint" ? v.toString() : String(v))
  const widths = cols.map((c, i) =>
    Math.min(60, Math.max(c.length, ...rows.map((r) => cell(r[cols[i]!]).length))),
  )
  const clip = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + "…" : s)
  const sep = `+${widths.map((w) => "-".repeat(w + 2)).join("+")}+`
  const head = `| ${cols.map((c, i) => c.padEnd(widths[i]!)).join(" | ")} |`
  const body = rows.map(
    (r) => `| ${cols.map((c, i) => clip(cell(r[c]), widths[i]!).padEnd(widths[i]!)).join(" | ")} |`,
  )
  return [sep, head, sep, ...body, sep, `(${rows.length} row${rows.length !== 1 ? "s" : ""})`].join("\n")
}

export const query = tool({
  description:
    "Run SQL against a SQLite database. Defaults to read-only (only SELECT/PRAGMA/WITH/EXPLAIN/ANALYZE). " +
    "Set readOnly=false to allow INSERT/UPDATE/DELETE — that path asks the user for permission first. " +
    "Multiple statements separated by ';' run as one batch via exec (no rows returned, params not accepted).",
  args: {
    dbPath: tool.schema.string().describe("Absolute or relative path to the SQLite .db file"),
    sql: tool.schema.string().describe("SQL statement to execute"),
    params: tool.schema
      .array(tool.schema.union([tool.schema.string(), tool.schema.number(), tool.schema.null()]))
      .optional()
      .describe("Positional parameters for ? placeholders. Use 0/1 for booleans."),
    maxRows: tool.schema.number().int().min(1).max(10000).optional().describe("Max rows to return (default 200)"),
    readOnly: tool.schema.boolean().optional().describe("Default true; false allows writes (asks permission)"),
  },
  async execute({ dbPath, sql, params, maxRows, readOnly }, ctx) {
    const limit = maxRows ?? 200
    const ro = readOnly ?? true
    const read = isReadStatement(sql)

    if (ro && !read) {
      return `Error: only read statements are allowed while readOnly=true.\nGot: ${sql.trim().slice(0, 120)}`
    }
    // 写操作要用户点头。MCP 版没有这道闸门——这是搬进来之后白拿的。
    if (!read) {
      await ctx.ask({
        permission: "sqlite_write",
        patterns: [path.resolve(dbPath)],
        always: [],
        metadata: { sql: sql.trim().slice(0, 200), db: path.resolve(dbPath) },
      })
    }

    const db = await openDb(dbPath, ro)
    try {
      // 260910 Red 多语句走 exec：prepare 静默只跑第一条，事务会假装成功。
      const count = countStatements(sql)
      if (count > 1) {
        if (params?.length) return "Error: multi-statement SQL cannot take parameters — split it or use a single statement."
        db.exec(sql)
        return {
          title: `executed ${count} statements`,
          output: `✅ executed ${count} statements${read ? " (no rows returned in multi-statement mode)" : ""}`,
          metadata: { statements: count, db: path.resolve(dbPath) },
        }
      }
      const stmt = db.prepare(sql)
      if (read) {
        const rows = (params?.length ? stmt.all(...(params as any[])) : stmt.all()) as Record<string, unknown>[]
        const shown = rows.slice(0, limit)
        const note =
          rows.length > limit
            ? `\n⚠️ Showing ${limit} of ${rows.length} rows — narrow the query or raise maxRows.`
            : ""
        return {
          title: `${rows.length} row${rows.length !== 1 ? "s" : ""}`,
          output: formatTable(shown) + note,
          metadata: { rows: rows.length, shown: shown.length, db: path.resolve(dbPath) },
        }
      }
      const res = (params?.length ? stmt.run(...(params as any[])) : stmt.run()) as { changes: number }
      // 260910 Red run().changes 把触发器内部语句也算进去（实测带 trigger 的 3 行 UPDATE 报 6），
      // 而 su-permemory 那三个 FTS5 触发器能让一次单行 UPDATE 报出几百——SQL 的 changes() 只算顶层。
      const written = (db.prepare("SELECT changes() AS c").get() as { c: number }).c
      return {
        title: `${written} row${written !== 1 ? "s" : ""} affected`,
        output: `✅ ${written} row${written !== 1 ? "s" : ""} affected`,
        metadata: { changes: written, db: path.resolve(dbPath) },
      }
    } finally {
      db.close()
    }
  },
})

export const schema = tool({
  description: "List all tables, columns, row counts and indexes in a SQLite database.",
  args: {
    dbPath: tool.schema.string().describe("Absolute or relative path to the SQLite .db file"),
  },
  async execute({ dbPath }) {
    const db = await openDb(dbPath, true)
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[]
      if (tables.length === 0) return "No user tables found in the database."

      const lines: string[] = [`Database: ${path.resolve(dbPath)}`, `Tables: ${tables.length}`, ""]
      for (const t of tables) {
        const cols = db.prepare(`PRAGMA table_info(${quote(t.name)})`).all() as {
          name: string
          type: string
          notnull: number
          dflt_value: string | null
          pk: number
        }[]
        const count = db.prepare(`SELECT COUNT(*) AS c FROM ${quote(t.name)}`).get() as { c: number }
        lines.push(`## ${t.name}  (${count.c} rows)`)
        if (cols.length === 0) lines.push("  (no columns)")
        else {
          lines.push(`  ${"Name".padEnd(24)} ${"Type".padEnd(16)} ${"Null".padEnd(5)} ${"PK".padEnd(3)} Default`)
          lines.push(`  ${"-".repeat(24)} ${"-".repeat(16)} ${"-".repeat(5)} ${"-".repeat(3)} -------`)
          for (const c of cols) {
            const clip = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + "…" : s)
            lines.push(
              `  ${clip(c.name, 24).padEnd(24)} ${clip(c.type ?? "", 16).padEnd(16)} ${(c.notnull === 1 ? "NO" : "YES").padEnd(5)} ${(c.pk > 0 ? "✓" : "").padEnd(3)} ${c.dflt_value ?? "—"}`,
            )
          }
        }
        for (const idx of db.prepare(`PRAGMA index_list(${quote(t.name)})`).all() as {
          name: string
          unique: number
          origin: string
        }[]) {
          const on = (db.prepare(`PRAGMA index_info(${quote(idx.name)})`).all() as { name: string }[])
            .map((c) => c.name)
            .join(", ")
          const tag = idx.unique ? "UNIQUE" : idx.origin === "pk" ? "PK" : ""
          lines.push(`  📎 ${idx.name} (${on})${tag ? ` [${tag}]` : ""}`)
        }
        lines.push("")
      }
      return { title: `${tables.length} tables`, output: lines.join("\n"), metadata: { tables: tables.length } }
    } finally {
      db.close()
    }
  },
})
