import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync } from "node:fs"
import { fileURLToPath } from "node:url"
import os from "node:os"
import path from "node:path"

// 260913 Red 隔离库核对召回脚本自身的查询路径，不碰 live 记忆库。
const SCRIPT = fileURLToPath(new URL("../../../../seed/scripts/recall-memory.mjs", import.meta.url))

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "recall-memory-"))
  const db = path.join(dir, "supermemory.db")
  const sqlite = new Database(db)
  sqlite.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY, project TEXT, content TEXT)")
  sqlite.exec(
    "CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='id', tokenize='trigram')",
  )
  sqlite.run(
    "INSERT INTO memories (id, project, content) VALUES (20, 'global', '#20 代理配置（260901）' || char(10) || '按需代理三件套')",
  )
  sqlite.run("INSERT INTO memories_fts (rowid, content) SELECT id, content FROM memories")
  sqlite.close()
  return db
}

function recall(db: string, args: string[]) {
  const proc = Bun.spawnSync(["bun", SCRIPT, ...args], {
    env: { ...process.env, REDCODE_MEMORY_DB: db },
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
  const result = recall(fixture(), ["--all", "代理"])

  expect(result.stdout).toContain("代理配置")
  expect(result.stdout).not.toContain("没搜到")
})
