import { expect } from "bun:test"
import { SessionID } from "@/session/schema"
import { SessionTable } from "@/session/session.sql"
import { ProjectTable } from "@/project/project.sql"
import { ProjectID } from "@/project/schema"
import { Database } from "@/storage/db"
import { backfillSessionSoul } from "@/data-migration"
import { migrateLegacySouls } from "@/soul/migration"
import fs from "node:fs"
import path from "node:path"
import { Effect, Layer } from "effect"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

it.instance("backfills only unpinned historical sessions and inherits a pinned parent soul", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const project = ProjectID.global
    const now = Date.now()
    const parent = crypto.randomUUID() as SessionID
    const inherited = crypto.randomUUID() as SessionID
    const byClient = crypto.randomUUID() as SessionID
    const pinned = crypto.randomUUID() as SessionID
    yield* Effect.sync(() =>
      Database.use((db) => {
        db.insert(ProjectTable)
          .values({
            id: project,
            worktree: test.directory,
            time_created: now,
            time_updated: now,
            sandboxes: [],
          })
          .onConflictDoNothing()
          .run()
        db.insert(SessionTable)
          .values([
            {
              id: parent,
              project_id: project,
              parent_id: null,
              slug: parent,
              directory: test.directory,
              title: "pinned parent",
              version: "test",
              client: "desktop",
              soul: "chi",
              time_created: now,
              time_updated: now,
            },
            {
              id: inherited,
              project_id: project,
              parent_id: parent,
              slug: inherited,
              directory: test.directory,
              title: "inherits",
              version: "test",
              client: "tui",
              time_created: now,
              time_updated: now,
            },
            {
              id: byClient,
              project_id: project,
              slug: byClient,
              directory: test.directory,
              title: "legacy",
              version: "test",
              client: "tui",
              time_created: now,
              time_updated: now,
            },
            {
              id: pinned,
              project_id: project,
              slug: pinned,
              directory: test.directory,
              title: "already pinned",
              version: "test",
              client: "tui",
              soul: "yuqi",
              time_created: now,
              time_updated: now,
            },
          ])
          .run()
      }),
    )
    const result = yield* Effect.sync(() =>
      Database.transaction((tx) => backfillSessionSoul(tx, { tui: "legacy-tui", desktop: "legacy-desktop" })),
    )
    const rows = Database.use((db) => db.select().from(SessionTable).all())
    const values = new Map(rows.map((row) => [row.id, row.soul]))
    expect(result).toEqual({ assigned: 2, unresolved: 0 })
    expect(values.get(parent)).toBe("chi")
    expect(values.get(inherited)).toBe("chi")
    expect(values.get(byClient)).toBe("legacy-tui")
    expect(values.get(pinned)).toBe("yuqi")
  }),
)

it.instance("uses migrated custom defaults for legacy sessions before DB backfill", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const dir = path.join(test.directory, "souls")
    const body = "# My TUI assistant\n\ncustom legacy body\n"
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "Tsoul.md"), body)
    const migrated = migrateLegacySouls(dir)
    expect(migrated.defaults).toEqual({ tui: "legacy-tui", desktop: "yuqi" })
    expect(fs.readFileSync(path.join(dir, "Tsoul.md"), "utf8")).toBe(body)
    expect(JSON.parse(fs.readFileSync(path.join(dir, ".legacy-defaults.json"), "utf8"))).toEqual({
      version: 1,
      defaults: { tui: "legacy-tui", desktop: "yuqi" },
      copies: { tui: "legacy-tui" },
    })
    const session = crypto.randomUUID() as SessionID
    const now = Date.now()
    yield* Effect.sync(() =>
      Database.use((db) => {
        db.insert(ProjectTable)
          .values({
            id: ProjectID.global,
            worktree: test.directory,
            time_created: now,
            time_updated: now,
            sandboxes: [],
          })
          .onConflictDoNothing()
          .run()
        db.insert(SessionTable)
          .values({
            id: session,
            project_id: ProjectID.global,
            slug: session,
            directory: test.directory,
            title: "custom legacy",
            version: "test",
            client: "tui",
            time_created: now,
            time_updated: now,
          })
          .run()
      }),
    )
    const backfill = yield* Effect.sync(() => Database.transaction((tx) => backfillSessionSoul(tx, migrated.defaults)))
    expect(backfill.assigned).toBe(1)
    expect(
      Database.use(
        (db) =>
          db
            .select()
            .from(SessionTable)
            .all()
            .find((row) => row.id === session)?.soul,
      ),
    ).toBe("legacy-tui")
  }),
)
