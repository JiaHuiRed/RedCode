import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "bun:sqlite"
import { query } from "../../../../seed/tool/sqlite"

function makeDb(dir: string): string {
  const file = join(dir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const db = new Database(file)
  db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
  db.run("INSERT INTO t (v) VALUES ('x')")
  db.close()
  return file
}

const baseCtx = {
  sessionID: "ses_test-sqlite",
  messageID: "msg_test",
  callID: "",
  agent: "build",
  directory: tmpdir(),
  worktree: tmpdir(),
  abort: AbortSignal.any([]),
  messages: [] as unknown[],
  metadata: () => Promise.resolve(undefined),
  ask: () => Promise.resolve(undefined),
}

describe("tool.sqlite write permission", () => {
  test("readOnly=false WITH ... UPDATE asks for sqlite_write permission", async () => {
    const dir = tmpdir()
    const dbFile = makeDb(dir)

    const asks: unknown[] = []
    const result = await query.execute(
      { dbPath: dbFile, sql: "WITH upd AS (SELECT 1) UPDATE t SET v = 'y' WHERE id = 1", readOnly: false },
      {
        ...baseCtx,
        ask: (p: { permission: string }) => {
          asks.push(p)
          return Promise.resolve(undefined)
        },
      },
    )

    expect(asks.length).toBe(1)
    expect((asks[0] as { permission: string }).permission).toBe("sqlite_write")
    expect(result).toHaveProperty("title")
  })

  test("readOnly=false SELECT ...; DELETE ... asks for sqlite_write permission", async () => {
    const dir = tmpdir()
    const dbFile = makeDb(dir)

    const asks: unknown[] = []
    const result = await query.execute(
      { dbPath: dbFile, sql: "SELECT * FROM t; DELETE FROM t WHERE id = 1", readOnly: false },
      {
        ...baseCtx,
        ask: (p: { permission: string }) => {
          asks.push(p)
          return Promise.resolve(undefined)
        },
      },
    )

    expect(asks.length).toBe(1)
    expect((asks[0] as { permission: string }).permission).toBe("sqlite_write")
    expect(result).toHaveProperty("title", "executed 2 statements")
  })

  test("readOnly=true UPDATE returns error", async () => {
    const dir = tmpdir()
    const dbFile = makeDb(dir)

    const result = await query.execute(
      { dbPath: dbFile, sql: "UPDATE t SET v = 'y' WHERE id = 1", readOnly: true },
      baseCtx,
    )

    expect(typeof result).toBe("string")
    expect(result).toContain("Error")
  })

  test("readOnly=true SELECT succeeds without permission prompt", async () => {
    const dir = tmpdir()
    const dbFile = makeDb(dir)

    const asks: unknown[] = []
    const result = await query.execute(
      { dbPath: dbFile, sql: "SELECT * FROM t", readOnly: true },
      {
        ...baseCtx,
        ask: (p: { permission: string }) => {
          asks.push(p)
          return Promise.resolve(undefined)
        },
      },
    )

    expect(asks.length).toBe(0)
    expect(result).toHaveProperty("title")
  })
})

function makeRows(dir: string, count: number, text = "x"): string {
  const file = join(dir, `rows-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const db = new Database(file)
  db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
  const insert = db.prepare("INSERT INTO t (v) VALUES (?)")
  for (let index = 0; index < count; index++) insert.run(text)
  db.close()
  return file
}

describe("tool.sqlite read output", () => {
  test("paginates with rowOffset and points at the next page", async () => {
    const dbFile = makeRows(tmpdir(), 5)

    const first = (await query.execute(
      { dbPath: dbFile, sql: "SELECT id, v FROM t ORDER BY id", maxRows: 2 },
      baseCtx,
    )) as { output: string }
    expect(first.output).toContain("#1 id=1")
    expect(first.output).toContain("rowOffset=2")

    const second = (await query.execute(
      { dbPath: dbFile, sql: "SELECT id, v FROM t ORDER BY id", maxRows: 2, rowOffset: 2 },
      baseCtx,
    )) as { output: string }
    expect(second.output).toContain("#3 id=3")
    expect(second.output).not.toContain("#1 id=1")
  })

  test("keeps long values instead of clipping them to 60 chars", async () => {
    const dbFile = makeRows(tmpdir(), 1, "y".repeat(500))

    const result = (await query.execute({ dbPath: dbFile, sql: "SELECT v FROM t" }, baseCtx)) as { output: string }
    expect(result.output).toContain("y".repeat(500))
  })

  test("caps a single cell and reports how much was dropped", async () => {
    const dbFile = makeRows(tmpdir(), 1, "z".repeat(2500))

    const result = (await query.execute({ dbPath: dbFile, sql: "SELECT v FROM t" }, baseCtx)) as { output: string }
    expect(result.output).toContain("(truncated 500 chars)")
  })
})
