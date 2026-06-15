#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import * as path from "node:path"
import * as fs from "node:fs"

// ── helpers ──────────────────────────────────────────────────────

function openDb(dbPath: string, readOnly = true) {
  const abs = path.resolve(dbPath)
  if (!fs.existsSync(abs)) throw new Error(`Database not found: ${abs}`)
  const { Database } = require("bun:sqlite")
  const db = new Database(abs, { create: false, strict: true })
  db.exec("PRAGMA query_only = " + (readOnly ? "1" : "0"))
  return db as import("bun:sqlite").Database
}

function isReadStatement(sql: string): boolean {
  const trimmed = sql.trim().toLowerCase()
  return (
    trimmed.startsWith("select") ||
    trimmed.startsWith("with") ||
    trimmed.startsWith("explain") ||
    trimmed.startsWith("pragma") ||
    trimmed.startsWith("analyze")
  )
}

/** Format query results as a text column-width table. */
function formatTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(empty result set)"
  const cols = Object.keys(rows[0])

  // Compute max width per column (clamped at 60 to avoid overflow)
  const widths = cols.map((c) =>
    Math.min(
      60,
      Math.max(
        c.length,
        ...rows.map((r) => {
          const v = r[c]
          return v == null ? 4 : String(v).length
        }),
      ),
    ),
  )

  // ── header row ────────────────────────────────────────────
  const sep = `+${widths.map((w) => "-".repeat(w + 2)).join("+")}+`
  const head = `| ${cols.map((c, i) => c.padEnd(widths[i])).join(" | ")} |`

  // ── body rows ─────────────────────────────────────────────
  const body = rows.map((r) => {
    // Some values may be BigInt (PRAGMA etc.) — stringify them.
    const vals = cols.map((c) => {
      const v = r[c] as unknown
      if (v === null || v === undefined) return "NULL"
      if (typeof v === "bigint") return v.toString()
      const s = String(v)
      return s.length > widths[cols.indexOf(c)] ? s.slice(0, widths[cols.indexOf(c)] - 1) + "…" : s
    })
    return `| ${vals.map((v, i) => v.padEnd(widths[i])).join(" | ")} |`
  })

  return [sep, head, sep, ...body, sep, `(${rows.length} row${rows.length !== 1 ? "s" : ""})`].join(
    "\n",
  )
}

// ── server ──────────────────────────────────────────────────────

const server = new McpServer({
  name: "mcp-sqlite-query",
  version: "0.1.0",
  description: "SQLite query tool — execute read-only SQL against any .db file",
})

// ── sqlite_query tool ───────────────────────────────────────────

server.tool(
  "sqlite_query",
  "Run SQL against a SQLite database. Defaults to read-only (only SELECT/PRAGMA/WITH/EXPLAIN/ANALYZE). " +
    "Set readOnly=false to allow INSERT/UPDATE/DELETE (use with caution).",
  {
    dbPath: z.string().describe("Absolute or relative path to the SQLite .db file"),
    sql: z.string().describe("SQL statement to execute"),
    params: z
      .array(z.union([z.string(), z.number(), z.null()]))
      .optional()
      .describe("Optional positional parameters for the query (? placeholders). Use 0/1 for booleans."),
    maxRows: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .optional()
      .default(200)
      .describe("Maximum rows to return (default 200, max 10000)"),
    readOnly: z
      .boolean()
      .optional()
      .default(true)
      .describe("When true, only SELECT/PRAGMA/WITH/EXPLAIN/ANALYZE are allowed"),
    bigInt: z
      .boolean()
      .optional()
      .default(false)
      .describe("When true, read 64-bit integers as BigInt (preserves full precision in results)"),
  },
  async ({ dbPath, sql, params, maxRows = 200, readOnly = true, bigInt = false }) => {
    try {
      if (readOnly && !isReadStatement(sql)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Only read statements are allowed (readOnly=true).\nGot: ${sql.trim().slice(0, 100)}`,
            },
          ],
          isError: true,
        }
      }

      const db = openDb(dbPath, readOnly)

      let result: { rows: Record<string, unknown>[]; rowCount: number }

      if (isReadStatement(sql)) {
        const stmt = db.prepare(sql)
        const rows = (params && params.length > 0 ? stmt.all(...params) : stmt.all()) as Record<string, unknown>[]
        const limited = rows.slice(0, maxRows)

        const output = formatTable(limited)
        const truncated = rows.length > maxRows ? `\n⚠️ Showing ${maxRows} of ${rows.length} rows. Use a more specific query or increase maxRows.` : ""

        db.close()
        return {
          content: [{ type: "text", text: output + truncated }],
        }
      } else {
        // write statement (only reached if readOnly=false)
        const stmt = db.prepare(sql)
        const result = (params && params.length > 0 ? stmt.run(...params) : stmt.run()) as {
          changes: number
          lastInsertRowid: number | bigint
        }
        db.close()
        return {
          content: [{ type: "text", text: `✅ ${result.changes} row${result.changes !== 1 ? "s" : ""} affected` }],
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true }
    }
  },
)

// ── sqlite_schema tool ──────────────────────────────────────────

server.tool(
  "sqlite_schema",
  "List all tables and their column definitions in a SQLite database.",
  {
    dbPath: z.string().describe("Absolute or relative path to the SQLite .db file"),
  },
  async ({ dbPath }) => {
    try {
      const db = openDb(dbPath, true)

      // get tables
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all() as { name: string }[]

      if (tables.length === 0) {
        db.close()
        return { content: [{ type: "text", text: "No user tables found in the database." }] }
      }

      const lines: string[] = [`Database: ${path.resolve(dbPath)}`, `Tables: ${tables.length}`, ""]

      for (const t of tables) {
        const cols = db.prepare(`PRAGMA table_info("${t.name.replace(/"/g, '""')}")`).all() as {
          cid: number
          name: string
          type: string
          notnull: number
          dflt_value: string | null
          pk: number
        }[]

        // Get row count
        const count = db.prepare(`SELECT COUNT(*) as c FROM "${t.name.replace(/"/g, '""')}"`).get() as { c: number }

        lines.push(`## ${t.name}  (${count.c} rows)`)

        if (cols.length === 0) {
          lines.push("  (no columns)")
        } else {
          lines.push(
            `  ${"Name".padEnd(24)} ${"Type".padEnd(16)} Nullable Default${"PK".padStart(4)}`,
          )
          lines.push(`  ${"-".repeat(24)} ${"-".repeat(16)} ${"-".repeat(7)} ${"-".repeat(4)}`)
          for (const c of cols) {
            const name = c.name.length > 24 ? c.name.slice(0, 21) + "…" : c.name
            const type = (c.type || "").length > 16 ? (c.type || "").slice(0, 13) + "…" : c.type || ""
            const nullable = c.notnull === 1 ? "NO" : "YES"
            const dflt = c.dflt_value ?? "—"
            const pk = c.pk > 0 ? "✓" : ""
            lines.push(`  ${name.padEnd(24)} ${type.padEnd(16)} ${nullable.padEnd(7)} ${pk.padEnd(4)} ${dflt}`)
          }
        }

        // Get indexes for this table
        const indexes = db.prepare(`PRAGMA index_list("${t.name.replace(/"/g, '""')}")`).all() as {
          name: string
          unique: number
          origin: string
        }[]
        if (indexes.length > 0) {
          for (const idx of indexes) {
            const cols2 = db.prepare(`PRAGMA index_info("${idx.name.replace(/"/g, '""')}")`).all() as {
              name: string
            }[]
            const colNames = cols2.map((c) => c.name).join(", ")
            const tag = idx.unique ? "UNIQUE" : idx.origin === "pk" ? "PK" : ""
            lines.push(`  📎 ${idx.name} (${colNames}) ${tag ? `[${tag}]` : ""}`)
          }
        }
        lines.push("")
      }

      db.close()
      return { content: [{ type: "text", text: lines.join("\n") }] }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true }
    }
  },
)

// ── start ───────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
