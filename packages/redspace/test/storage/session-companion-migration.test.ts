import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

test("upgrades existing sessions to Code without altering their Soul, permissions or messages", () => {
  const root = path.join(import.meta.dirname, "../../migration")
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      timestamp: Number(entry.name.split("_")[0]),
      sql: readFileSync(path.join(root, entry.name, "migration.sql"), "utf8"),
    }))
    .sort((a, b) => a.timestamp - b.timestamp)
  const index = entries.findIndex((entry) => entry.name.endsWith("_session_companion_mode"))
  expect(index).toBeGreaterThan(0)
  const sqlite = new Database(":memory:")
  try {
    const db = drizzle({ client: sqlite })
    migrate(db, entries.slice(0, index))
    sqlite.run(
      "INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('legacy-project', '/legacy', 1, 1, '[]')",
    )
    sqlite.run(
      "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, soul, permission) VALUES ('legacy-session', 'legacy-project', 'legacy', '/legacy', 'Existing work', '0.18.6', 1, 2, 'coder', '[]')",
    )
    sqlite.run(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('legacy-message', 'legacy-session', 1, 2, '{\"role\":\"user\"}')",
    )
    const previous = sqlite.query("SELECT id, soul, permission, title, time_created, time_updated FROM session").all()
    const messages = sqlite.query("SELECT * FROM message").all()
    migrate(db, entries.slice(index))
    expect(sqlite.query("SELECT id, soul, permission, title, time_created, time_updated FROM session").all()).toEqual(
      previous,
    )
    expect(sqlite.query("SELECT mode, companion_id FROM session WHERE id = 'legacy-session'").get()).toEqual({
      mode: "code",
      companion_id: null,
    })
    expect(sqlite.query("SELECT * FROM message").all()).toEqual(messages)
    expect(sqlite.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
    expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([])
  } finally {
    sqlite.close()
  }
})
