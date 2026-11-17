import { describe, expect, it } from "bun:test"
import path from "path"
import { Global } from "@redcode-ai/core/global"
import { Database } from "@/storage/db"
import { Process } from "@/util/process"
import { tmpdir } from "../fixture/fixture"

const root = path.resolve(import.meta.dirname, "../..")

async function probe(dir: string, script: string, env: NodeJS.ProcessEnv = {}) {
  return Process.run([process.execPath, "-e", script], {
    cwd: root,
    env: {
      REDCODE_TEST_HOME: path.join(dir, "home"),
      REDCODE_DB: path.join(dir, "test.db"),
      REDCODE_SKIP_MIGRATIONS: "false",
      ...env,
    },
    timeout: 20_000,
    nothrow: true,
    maxOutputBytes: 20_000,
    maxErrorBytes: 20_000,
  })
}

describe("Database.getChannelPath", () => {
  it("returns the shared redcode.db path", () => {
    expect(Database.getChannelPath()).toBe(path.join(Global.Path.data, "redcode.db"))
  })
})

describe("Database migrations", () => {
  it("does not record skipped migrations and applies them on a later normal startup", async () => {
    await using tmp = await tmpdir()
    const skipped = await probe(
      tmp.path,
      `
        const { Database } = await import("./src/storage/db")
        const db = Database.Client()
        const tables = db.$client.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
        Database.close()
        console.log(JSON.stringify(tables))
      `,
      { REDCODE_SKIP_MIGRATIONS: "true" },
    )
    expect(skipped.code, skipped.stderr.toString()).toBe(0)
    expect(JSON.parse(skipped.stdout.toString())).toEqual([])

    const normal = await probe(
      tmp.path,
      `
        const { Database } = await import("./src/storage/db")
        const db = Database.Client()
        const tables = db.$client.query("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name)
        const count = () => Database.Client().$client.query("SELECT count(*) AS count FROM __drizzle_migrations").get().count
        const applied = count()
        db.$client.run("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('project_probe', '/probe', 1, 1, '[]')")
        db.$client.run("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, cost, cost_cny, cost_usd, soul, permission) VALUES ('session_probe', 'project_probe', 'probe', '/probe', 'Probe', 'test', 1, 1, 2, 1.5, 0.5, 'audit-persona', '[]')")
        const read = () => Database.Client().$client.query("SELECT id, soul, cost_cny, cost_usd, permission FROM session").all()
        const before = read()
        Database.close()
        Database.Client({ skipMigrations: true })
        const skippedCount = count()
        Database.close()
        Database.Client({ skipMigrations: false })
        const after = read()
        const reopened = count()
        Database.close()
        console.log(JSON.stringify({ tables, applied, skippedCount, reopened, before, after }))
      `,
    )
    expect(normal.code, normal.stderr.toString()).toBe(0)
    const result = JSON.parse(normal.stdout.toString())
    for (const table of ["project", "session", "message", "part", "goal", "soul_version"]) {
      expect(result.tables).toContain(table)
    }
    expect(result.applied).toBeGreaterThan(0)
    expect(result.skippedCount).toBe(result.applied)
    expect(result.reopened).toBe(result.applied)
    expect(result.before).toEqual([
      { id: "session_probe", soul: "audit-persona", cost_cny: 1.5, cost_usd: 0.5, permission: "[]" },
    ])
    expect(result.after).toEqual(result.before)
  })

  it("does not mutate bundled migration entries when skipping", async () => {
    await using tmp = await tmpdir()
    const result = await probe(
      tmp.path,
      `
        const entries = Object.freeze([Object.freeze({
          name: "20261009000000_probe",
          timestamp: 1791504000000,
          sql: "CREATE TABLE migration_probe (id TEXT PRIMARY KEY);",
        })])
        Object.defineProperty(globalThis, "REDCODE_MIGRATIONS", { value: entries })
        const { Database } = await import("./src/storage/db")
        const db = Database.Client({ skipMigrations: true })
        const skipped = db.$client.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
        Database.close()
        const normal = Database.Client({ skipMigrations: false })
        const table = normal.$client.query("SELECT name FROM sqlite_master WHERE name = 'migration_probe'").get()
        const journal = normal.$client.query("SELECT name FROM __drizzle_migrations").all()
        Database.close()
        console.log(JSON.stringify({ skipped, table, journal, sql: entries[0].sql }))
      `,
    )
    expect(result.code, result.stderr.toString()).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toEqual({
      skipped: [],
      table: { name: "migration_probe" },
      journal: [{ name: "20261009000000_probe" }],
      sql: "CREATE TABLE migration_probe (id TEXT PRIMARY KEY);",
    })
  })
})

describe("drizzle-kit database target", () => {
  it("has no database target unless explicitly configured", async () => {
    await using tmp = await tmpdir()
    const result = await probe(
      tmp.path,
      `
        delete process.env.REDCODE_DRIZZLE_DB
        const { default: config } = await import("./drizzle.config")
        console.log(JSON.stringify({ dialect: config.dialect, credentials: config.dbCredentials ?? null }))
      `,
    )
    expect(result.code, result.stderr.toString()).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toEqual({ dialect: "sqlite", credentials: null })
  })

  it("uses a dedicated absolute target independently of the runtime database", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "development.db")
    const result = await probe(
      tmp.path,
      `
        const { default: config } = await import("./drizzle.config")
        console.log(JSON.stringify(config.dbCredentials))
      `,
      { REDCODE_DRIZZLE_DB: target },
    )
    expect(result.code, result.stderr.toString()).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toEqual({ url: target })
  })

  it("rejects relative and empty targets", async () => {
    await using tmp = await tmpdir()
    for (const target of ["relative.db", ""]) {
      const result = await probe(tmp.path, 'await import("./drizzle.config")', { REDCODE_DRIZZLE_DB: target })
      expect(result.code).not.toBe(0)
      expect(result.stderr.toString()).toContain("REDCODE_DRIZZLE_DB must be an absolute filesystem path")
    }
  })
})
