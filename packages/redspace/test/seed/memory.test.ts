import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import os from "node:os"
import path from "node:path"

// 260913 Red 隔离 fixture 覆盖缺失/重复/冲突/归档四档；直接 spawn 脚本，不碰 live 记忆库。
const SCRIPT = fileURLToPath(new URL("../../../../seed/scripts/check-memory-dualwrite.mjs", import.meta.url))

function spawnScript(env: Record<string, string>) {
  const proc = Bun.spawnSync(["bun", SCRIPT], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    exitCode: proc.exitCode ?? 1,
    output: new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr),
  }
}

function makeFixture(entries: Array<{ id: string; content: string }>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "memory-dualwrite-"))
  const md = path.join(dir, "MEMORY.md")
  const db = path.join(dir, "supermemory.db")

  const numbers = [...new Set(entries.map((entry) => entry.content.match(/^#(\d+)/)![1]))]
  writeFileSync(md, numbers.map((number) => `#${number} 测试条目（260913）`).join("\n") + "\n", "utf-8")

  const sqlite = new Database(db)
  sqlite.exec("CREATE TABLE memories (id TEXT PRIMARY KEY, project TEXT, content TEXT)")
  for (const entry of entries) {
    sqlite.run("INSERT INTO memories (id, project, content) VALUES (?, ?, ?)", [entry.id, "global", entry.content])
  }
  sqlite.close()
  return { md, db }
}

describe("check-memory-dualwrite · 同号冲突/重复漏检修复", () => {
  test("正常：每个编号唯一对应，退出码 0", () => {
    const { md, db } = makeFixture([
      { id: "1", content: `#1 条目一（260913）\n正文一` },
      { id: "2", content: `#2 条目二（260913）\n正文二` },
    ])
    const result = spawnScript({ REDCODE_MEMORY: md, REDCODE_MEMORY_DB: db })

    expect(result.exitCode).toBe(0)
  })

  test("缺失：索引有 #3 但库无全文，退出码 1", () => {
    const { md, db } = makeFixture([{ id: "1", content: `#1 条目一（260913）\n正文一` }])
    writeFileSync(md, "#1 条目一（260913）\n#2 条目二（260913）\n#3 条目三（260913）\n", "utf-8")
    const result = spawnScript({ REDCODE_MEMORY: md, REDCODE_MEMORY_DB: db })

    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("#3")
  })

  test("冲突：同编号两条不同正文，必须失败", () => {
    const { md, db } = makeFixture([
      { id: "a", content: `#100 条目A（260913）\n旧正文` },
      { id: "b", content: `#100 条目B（260913）\n新正文` },
    ])
    const result = spawnScript({ REDCODE_MEMORY: md, REDCODE_MEMORY_DB: db })

    expect(result.exitCode).toBe(1)
    expect(result.output).toMatch(/冲突|重复/)
  })

  test("重复：同编号两条相同正文，也必须失败", () => {
    const { md, db } = makeFixture([
      { id: "a", content: `#200 条目（260913）\n完全相同` },
      { id: "b", content: `#200 条目（260913）\n完全相同` },
    ])
    const result = spawnScript({ REDCODE_MEMORY: md, REDCODE_MEMORY_DB: db })

    expect(result.exitCode).toBe(1)
    expect(result.output).toMatch(/冲突|重复/)
  })

  test("孤儿：库有 #300 但索引已删，仅提示不阻断", () => {
    const { md, db } = makeFixture([
      { id: "1", content: `#1 条目一（260913）\n正文一` },
      { id: "300", content: `#300 归档条目（260913）\n正文` },
    ])
    writeFileSync(md, "#1 条目一（260913）\n", "utf-8")
    const result = spawnScript({ REDCODE_MEMORY: md, REDCODE_MEMORY_DB: db })

    expect(result.exitCode).toBe(0)
    expect(result.output).toMatch(/归档|orphan|提示/)
  })
})
