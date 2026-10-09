import { expect, test } from "bun:test"
import path from "node:path"
import { Process } from "@/util/process"
import { tmpdir } from "../fixture/fixture"

// 261009 Red 新迁移必须保留旧库数据，并能从含 WAL 的一致性快照恢复。
// docs/notes/implemented/feature/2026-10-09-session-change-catchup.md
test("session changes migrate an old database without changing historical data and preserve a rollback snapshot", async () => {
  await using tmp = await tmpdir()
  const result = await Process.run(
    [
      process.execPath,
      "-e",
      `
        import assert from "node:assert/strict"
        import fs from "node:fs/promises"
        import path from "node:path"
        import { Database as SQLite } from "bun:sqlite"
        const folders = (await fs.readdir("./migration", { withFileTypes: true }))
          .filter(item => item.isDirectory()).map(item => item.name).sort()
        const entries = await Promise.all(folders.map(async (name, index) => ({
          name, timestamp: index + 1,
          sql: await fs.readFile(path.join("./migration", name, "migration.sql"), "utf8"),
        })))
        const additions = entries.filter(entry => /CREATE TABLE [\`"]?session_change[\`"]?\\s*\\(/.test(entry.sql))
        assert.equal(additions.length, 1, "expected exactly one generated session_change migration")
        const legacy = entries.filter(entry => !additions.includes(entry))
        Object.defineProperty(globalThis, "REDCODE_MIGRATIONS", { value: legacy })
        const { Database } = await import("./src/storage/db")
        const db = Database.Client().$client
        db.run("PRAGMA wal_autocheckpoint = 0")
        db.run("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('old_project', '/old', 1, 1, '[]')")
        db.run("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, cost, cost_cny, cost_usd, soul, permission) VALUES ('old_session', 'old_project', 'old', '/old', 'Old', 'test', 1, 1, 2, 1.5, 0.5, 'audit-persona', '[]')")
        db.run("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('old_message', 'old_session', 1, 1, '{\\"role\\":\\"assistant\\"}')")
        db.run("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('old_part', 'old_message', 'old_session', 1, 1, '{\\"type\\":\\"text\\",\\"text\\":\\"kept\\"}')")
        const data = client => ({
          session: client.query("SELECT id, soul, cost, cost_cny, cost_usd, permission FROM session ORDER BY id").all(),
          message: client.query("SELECT * FROM message ORDER BY id").all(),
          part: client.query("SELECT * FROM part ORDER BY id").all(),
        })
        const before = data(db)
        const backupPath = path.join(path.dirname(process.env.REDCODE_DB), "rollback.db")
        db.run("VACUUM INTO ?", [backupPath])
        const backup = new SQLite(backupPath, { readonly: true })
        assert.deepEqual(data(backup), before)
        assert.deepEqual(backup.query("PRAGMA integrity_check").get(), { integrity_check: "ok" })
        assert.deepEqual(backup.query("PRAGMA foreign_key_check").all(), [])
        assert.equal(backup.query("SELECT count(*) AS n FROM __drizzle_migrations").get().n, legacy.length)
        assert.equal(backup.query("SELECT name FROM sqlite_master WHERE name = 'session_change'").get(), null)
        backup.close()
        Database.close()
        const upgraded = await import("drizzle-orm/bun-sqlite/migrator")
        const current = Database.Client({ skipMigrations: true }).$client
        upgraded.migrate(Database.Client(), entries)
        assert.deepEqual(data(current), before)
        assert.equal(current.query("SELECT count(*) AS n FROM __drizzle_migrations").get().n, entries.length)
        assert.equal(current.query("SELECT count(*) AS n FROM session_change").get().n, 0)
        assert.deepEqual(current.query("PRAGMA integrity_check").get(), { integrity_check: "ok" })
        assert.deepEqual(current.query("PRAGMA foreign_key_check").all(), [])
        Database.close()
        const restorePath = path.join(path.dirname(process.env.REDCODE_DB), "restored.db")
        await fs.copyFile(backupPath, restorePath)
        const restored = new SQLite(restorePath)
        assert.deepEqual(data(restored), before)
        assert.equal(restored.query("SELECT count(*) AS n FROM __drizzle_migrations").get().n, legacy.length)
        assert.equal(restored.query("SELECT name FROM sqlite_master WHERE name = 'session_change'").get(), null)
        restored.close()
        console.log(JSON.stringify({ legacy: legacy.length, current: entries.length, preserved: before }))
      `,
    ],
    {
      cwd: path.resolve(import.meta.dirname, "../.."),
      env: {
        REDCODE_TEST_HOME: path.join(tmp.path, "home"),
        REDCODE_DB: path.join(tmp.path, "upgrade.db"),
        REDCODE_SKIP_MIGRATIONS: "false",
      },
      timeout: 20_000,
      nothrow: true,
      maxOutputBytes: 20_000,
      maxErrorBytes: 20_000,
    },
  )
  expect(result.code, result.stderr.toString()).toBe(0)
  const output = JSON.parse(result.stdout.toString())
  expect(output.current).toBe(output.legacy + 1)
  expect(output.preserved.session).toEqual([
    { id: "old_session", soul: "audit-persona", cost: 2, cost_cny: 1.5, cost_usd: 0.5, permission: "[]" },
  ])
})
