import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync } from "node:fs"
import { fileURLToPath } from "node:url"
import os from "node:os"
import path from "node:path"

// 260913 Red 隔离库核对召回脚本自身的查询路径，不碰 live 记忆库。
const SCRIPT = fileURLToPath(new URL("../../../../seed/scripts/recall-memory.mjs", import.meta.url))
const NEWLINE = String.fromCharCode(10)

function fixture(entries: Array<{ id: number; project: string; content: string }>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "recall-memory-"))
  const db = path.join(dir, "supermemory.db")
  const sqlite = new Database(db)
  sqlite.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY, project TEXT, content TEXT)")
  sqlite.exec(
    "CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='id', tokenize='trigram')",
  )
  for (const entry of entries) {
    sqlite.run("INSERT INTO memories (id, project, content) VALUES (?, ?, ?)", [entry.id, entry.project, entry.content])
  }
  sqlite.run("INSERT INTO memories_fts (rowid, content) SELECT id, content FROM memories")
  sqlite.close()
  return { dir, db }
}

function recall(db: string, args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(["bun", SCRIPT, ...args], {
    env: { ...process.env, REDCODE_MEMORY_DB: db, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    exitCode: proc.exitCode ?? 1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  }
}

test("两字中文查询在 --all 下走子串分支并能命中", () => {
  const { db } = fixture([{ id: 20, project: "global", content: `#20 代理配置（260901）${NEWLINE}按需代理三件套` }])
  const result = recall(db, ["--all", "代理"])

  expect(result.stdout).toContain("代理配置")
  expect(result.stdout).not.toContain("没搜到")
})

test("REDCODE_PROJECT_ROOT 决定召回作用域而不是 cwd", () => {
  const { dir, db } = fixture([
    { id: 20, project: "global", content: `#20 代理配置（260901）${NEWLINE}按需代理三件套` },
    { id: 21, project: "ProjectX", content: `#21 项目专属（260901）${NEWLINE}代理相关项目记忆` },
  ])
  const projectRoot = path.join(dir, "ProjectX")
  mkdirSync(projectRoot)

  const result = recall(db, ["代理"], { REDCODE_PROJECT_ROOT: projectRoot })

  expect(result.stdout).toContain("ProjectX")
})
