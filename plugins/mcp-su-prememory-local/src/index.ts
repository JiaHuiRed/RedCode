#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { Database } from "bun:sqlite"
import { z } from "zod"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"

// 260607 Red 本地记忆 MCP — 纯本地 SQLite+FTS5，无需注册账号

const DB_DIR = process.env.SUPERMEMORY_DIR || path.join(os.homedir(), ".redcode")
const DB_PATH = path.join(DB_DIR, "supermemory.db")

// ensure db dir exists
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })

const db = new Database(DB_PATH)
db.exec("PRAGMA journal_mode=WAL;")
db.exec("PRAGMA foreign_keys=ON;")

// main storage table
db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    project TEXT NOT NULL DEFAULT 'default',
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
`)

// FTS5 full-text index on content
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    content='memories',
    content_rowid='id'
  );
`)

// triggers to keep FTS in sync
db.exec(`
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
  END;
`)
db.exec(`
  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
  END;
`)
db.exec(`
  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
    INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
  END;
`)

// rebuild FTS index for any existing data
db.exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild');")

const server = new McpServer({
  name: "su-prememory-local",
  version: "0.1.0",
  description: "Local semantic memory — save and recall facts from SQLite+FTS5",
})

// ── memory tool ──────────────────────────────────────────────────
server.tool(
  "memory",
  "Save or forget information. Use 'save' when user shares facts, preferences, or anything worth remembering. Use 'forget' to remove outdated info.",
  {
    content: z
      .string()
      .max(200000, "Content too long")
      .describe("The memory content to save or forget"),
    action: z.enum(["save", "forget"]).optional().default("save"),
    project: z
      .string()
      .max(128)
      .optional()
      .describe("Optional project scope (e.g. 'redcode', 'personal')"),
  },
  async ({ content, action, project }) => {
    try {
      if (action === "forget") {
        // search across all projects unless specified
        const exactSql = project
          ? `SELECT id, content FROM memories WHERE content = ? AND project = ? LIMIT 1`
          : `SELECT id, content FROM memories WHERE content = ? LIMIT 1`
        const exactParams = project ? [content, project] : [content]
        const existing = db.prepare(exactSql).get(...exactParams) as { id: number; content: string } | null

        if (existing) {
          db.query("DELETE FROM memories WHERE id = ?").run(existing.id)
          return {
            content: [
              { type: "text" as const, text: `Forgot: "${existing.content.slice(0, 100)}"` },
            ],
          }
        }

        // LIKE fallback across all projects unless specified
        const likeSql = project
          ? `SELECT id, content FROM memories WHERE content LIKE ? AND project = ? LIMIT 1`
          : `SELECT id, content FROM memories WHERE content LIKE ? LIMIT 1`
        const likeParams = project ? [`%${content}%`, project] : [`%${content}%`]
        const likeMatch = db.prepare(likeSql).get(...likeParams) as { id: number; content: string } | null

        if (likeMatch) {
          db.query("DELETE FROM memories WHERE id = ?").run(likeMatch.id)
          return {
            content: [
              {
                type: "text" as const,
                text: `Forgot (partial match): "${likeMatch.content.slice(0, 100)}"`,
              },
            ],
          }
        }

        return {
          content: [{ type: "text" as const, text: "No matching memory found to forget." }],
        }
      }

      // save (default to "default" project)
      const saveProject = project || "default"
      const result = db
        .query(
          "INSERT INTO memories (content, project, source) VALUES ($content, $project, 'mcp') RETURNING id",
        )
        .get({ $content: content, $project: saveProject }) as { id: number }

      return {
        content: [
          {
            type: "text" as const,
            text: `Saved memory (id: ${result.id}) in project "${saveProject}"`,
          },
        ],
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true }
    }
  },
)

// ── recall tool ──────────────────────────────────────────────────
server.tool(
  "recall",
  "Search saved memories by query. Returns relevant memories with similarity scores.",
  {
    query: z
      .string()
      .max(1000)
      .describe("The search query to find relevant memories"),
    limit: z.number().min(1).max(50).optional().default(10),
    project: z
      .string()
      .max(128)
      .optional()
      .describe("Optional: scope search to a specific project"),
  },
  async ({ query, limit = 10, project }) => {
    try {
      const projectFilter = project ? `AND m.project = '${project.replace(/'/g, "''")}'` : ""
      // FTS5 default tokenizer doesn't handle CJK — use LIKE for all queries
      const likeSql = `SELECT id, content, project, created_at FROM memories
       WHERE content LIKE $like ${projectFilter}
       ORDER BY created_at DESC
       LIMIT $limit`
      const rows = db.query(likeSql).all({
        $like: `%${query}%`,
        $limit: limit,
      }) as Array<{
        id: number
        content: string
        project: string
        created_at: string
      }>

      if (rows.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No memories found." }],
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `## Memories (${rows.length} results)\n`,
              ...rows.map(
                (r, i) =>
                  `### ${i + 1}\n**Project:** ${r.project}\n**When:** ${r.created_at}\n${r.content}`,
              ),
            ].join("\n\n"),
          },
        ],
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true }
    }
  },
)

// ── stats tool ───────────────────────────────────────────────────
server.tool(
  "stats",
  "Get memory statistics — total count, per-project breakdown.",
  async () => {
    try {
      const total = db.query("SELECT COUNT(*) as c FROM memories").get() as { c: number }
      const byProject = db
        .query("SELECT project, COUNT(*) as c FROM memories GROUP BY project ORDER BY c DESC")
        .all() as Array<{ project: string; c: number }>

      const lines = [`**Total memories:** ${total.c}`, ""]
      if (byProject.length > 0) {
        lines.push("**By project:**")
        for (const p of byProject) {
          lines.push(`- ${p.project}: ${p.c}`)
        }
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true }
    }
  },
)

// ── start ────────────────────────────────────────────────────────
const transport = new StdioServerTransport()
await server.connect(transport)
