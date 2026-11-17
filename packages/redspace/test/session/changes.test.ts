import { afterAll, beforeEach, describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { Bus } from "@/bus"
import { Database, eq } from "@/storage/db"
import { EventSequenceTable, EventTable } from "@/sync/event.sql"
import { SessionChangeTable } from "@/session/changes.sql"
import { SessionChanges } from "@/session/changes"
import { Session as SessionNS } from "@/session/session"
import { Config } from "@/config/config"
import { Storage } from "@/storage/storage"
import { Soul } from "@/soul"
import { BackgroundJob } from "@/background/job"
import { SessionTable, MessageTable, PartTable } from "@/session/session.sql"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { initProjectors } from "@/server/projectors"
import { testEffect } from "../lib/effect"
import { provideTmpdirInstance } from "../fixture/fixture"

const dependencies = Layer.mergeAll(
  Bus.layer,
  Storage.defaultLayer,
  RuntimeFlags.layer({ experimentalWorkspaces: false }),
  BackgroundJob.defaultLayer,
  Config.defaultLayer,
)
const syncLayer = SyncEvent.layer.pipe(Layer.provide(dependencies))
const it = testEffect(
  Layer.mergeAll(
    Soul.defaultLayer,
    dependencies,
    syncLayer,
    SessionNS.layer.pipe(Layer.provide(dependencies), Layer.provide(syncLayer)),
    CrossSpawnSpawner.defaultLayer,
  ),
)

const now = () => Date.now() + 60_000

beforeEach(() => {
  Database.close()
  SyncEvent.reset()
  initProjectors()
})

afterAll(() => {
  SyncEvent.reset()
  initProjectors()
})

const rows = (sessionID: string) =>
  Database.use((db) =>
    db
      .select()
      .from(SessionChangeTable)
      .where(eq(SessionChangeTable.session_id, sessionID as SessionID))
      .orderBy(SessionChangeTable.seq)
      .all(),
  )

const createSession = Effect.gen(function* () {
  const session = yield* SessionNS.Service
  return yield* session.create({})
})

const seedMarkers = (sessionID: string, entries: Array<{ seq: number; id: string; time: number }>) =>
  Database.transaction((tx) => {
    for (const entry of entries) {
      SessionChanges.record({
        tx,
        sessionID,
        seq: entry.seq,
        id: entry.id,
        kind: "session",
        time: entry.time,
        config: SessionChanges.resolve(),
      })
    }
    if (entries.length) {
      tx.insert(EventSequenceTable)
        .values({ aggregate_id: sessionID as SessionID, seq: entries.at(-1)!.seq })
        .onConflictDoUpdate({
          target: EventSequenceTable.aggregate_id,
          set: { seq: entries.at(-1)!.seq },
        })
        .run()
    }
  })

describe("session change journal", () => {
  it.instance("commits markers with projectors and sequence while full events stay disabled", () =>
    Effect.gen(function* () {
      const session = yield* createSession
      const changes = rows(session.id)
      const sequence = Database.use((db) =>
        db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, session.id))
          .get(),
      )
      const fullEvents = Database.use((db) =>
        db.select().from(EventTable).where(eq(EventTable.aggregate_id, session.id)).all(),
      )

      expect(changes).toHaveLength(1)
      expect(changes[0]).toMatchObject({ seq: 0, kind: "session" })
      expect(sequence?.seq).toBe(0)
      expect(fullEvents).toEqual([])
      expect(
        Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get()),
      ).toBeDefined()
    }),
  )

  it.instance("does not record a replayed event twice", () =>
    Effect.gen(function* () {
      const session = yield* createSession
      const event = {
        id: "replay-once",
        type: SyncEvent.versionedType(SessionNS.Event.Updated.type, SessionNS.Event.Updated.version),
        seq: 1,
        aggregateID: session.id,
        data: { sessionID: session.id, info: { title: "replayed" } },
      }

      yield* SyncEvent.use.replay(event, { publish: false })
      yield* SyncEvent.use.replay(event, { publish: false })

      expect(rows(session.id).filter((row) => row.id === event.id)).toHaveLength(1)
      expect(rows(session.id).map((row) => row.seq)).toEqual([0, 1])
    }),
  )

  it.instance("rolls back projection, sequence, and marker when a projector fails", () =>
    Effect.gen(function* () {
      const session = yield* createSession
      SyncEvent.reset()
      const Broken = SyncEvent.define({
        type: "session.test.projector.failure",
        version: 1,
        aggregate: "sessionID",
        schema: Schema.Struct({
          sessionID: SessionID,
          title: Schema.String,
        }),
      })
      SyncEvent.init({
        projectors: [
          SyncEvent.project(Broken, (tx, data) => {
            tx.update(SessionTable).set({ title: data.title }).where(eq(SessionTable.id, data.sessionID)).run()
            throw new Error("projector failure")
          }),
        ],
      })

      const before = rows(session.id)
      const exit = yield* Effect.exit(
        SyncEvent.use.run(Broken, { sessionID: session.id, title: "must roll back" }, { publish: false }),
      )
      const after = rows(session.id)
      const sessionRow = Database.use((db) =>
        db.select({ title: SessionTable.title }).from(SessionTable).where(eq(SessionTable.id, session.id)).get(),
      )
      const sequence = Database.use((db) =>
        db
          .select({ seq: EventSequenceTable.seq })
          .from(EventSequenceTable)
          .where(eq(EventSequenceTable.aggregate_id, session.id))
          .get(),
      )

      expect(exit._tag).toBe("Failure")
      expect(after).toEqual(before)
      expect(sessionRow?.title).not.toBe("must roll back")
      expect(sequence?.seq).toBe(before.at(-1)?.seq)
    }),
  )

  it.instance("records message and part changes by message ID and safely omits invalid IDs", () =>
    Effect.gen(function* () {
      const session = yield* createSession
      const messageID = MessageID.ascending()
      const message = {
        id: messageID,
        sessionID: session.id,
        role: "user" as const,
        time: { created: now() },
        agent: "user",
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        tools: {},
        mode: "",
      } as MessageV2.Info
      yield* SyncEvent.use.run(MessageV2.Event.Updated, { sessionID: session.id, info: message }, { publish: false })

      const partID = PartID.ascending()
      yield* SyncEvent.use.run(
        MessageV2.Event.PartUpdated,
        {
          part: {
            id: partID,
            messageID,
            sessionID: session.id,
            type: "text",
            text: "journal marker",
          },
          sessionID: session.id,
          time: now(),
        },
        { publish: false },
      )
      yield* SyncEvent.use.run(
        MessageV2.Event.PartRemoved,
        { sessionID: session.id, messageID, partID },
        { publish: false },
      )
      yield* SyncEvent.use.run(MessageV2.Event.Removed, { sessionID: session.id, messageID }, { publish: false })

      const badID = "x".repeat(129)
      yield* SyncEvent.use.run(
        MessageV2.Event.Updated,
        { sessionID: session.id, info: { ...message, id: badID as MessageID } },
        { publish: false },
      )
      const journal = rows(session.id)

      expect(journal.slice(-4).map((item) => item.kind)).toEqual(["message", "message", "message", "session"])
      expect(journal.slice(-4).map((item) => item.message_id)).toEqual([messageID, messageID, messageID, null])
    }),
  )

  it.instance("keeps large attachment metadata out of journal marker rows", () =>
    Effect.gen(function* () {
      const session = yield* createSession
      const messageID = MessageID.ascending()
      yield* SyncEvent.use.run(
        MessageV2.Event.Updated,
        {
          sessionID: session.id,
          info: {
            id: messageID,
            sessionID: session.id,
            role: "user",
            time: { created: now() },
            agent: "user",
            model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
            tools: {},
            mode: "",
          } as MessageV2.Info,
        },
        { publish: false },
      )
      const payload = "base64-attachment-".repeat(50_000)
      const partID = PartID.ascending()
      yield* SyncEvent.use.run(
        MessageV2.Event.PartUpdated,
        {
          part: {
            id: partID,
            messageID,
            sessionID: session.id,
            type: "file",
            mime: "image/png",
            url: `data:image/png;base64,${payload}`,
            filename: "large.png",
          },
          sessionID: session.id,
          time: now(),
        },
        { publish: false },
      )

      const part = Database.use((db) => db.select().from(PartTable).where(eq(PartTable.id, partID)).get())
      const journalEntry = rows(session.id).at(-1)
      expect(part?.data).toHaveProperty("url")
      expect(journalEntry).toMatchObject({ kind: "message", message_id: messageID })
      expect(JSON.stringify(journalEntry)).not.toContain(payload)
      expect(Object.keys(journalEntry ?? {}).sort()).toEqual(
        ["id", "kind", "message_id", "seq", "session_id", "time_created"].sort(),
      )
    }),
  )

  it.instance(
    "pages without changing cost or token accounting and honors limit, page-size, and until",
    () =>
      Effect.gen(function* () {
        const session = yield* createSession
        const config = SessionChanges.resolve((yield* Config.use.get()).session_changes)
        for (let i = 0; i < 4; i++) {
          yield* SyncEvent.use.run(
            SessionNS.Event.Updated,
            {
              sessionID: session.id,
              info: { title: `page-${i}` },
            },
            { publish: false },
          )
        }
        const before = Database.use((db) =>
          db
            .select({
              cost: SessionTable.cost,
              costCny: SessionTable.cost_cny,
              costUsd: SessionTable.cost_usd,
              input: SessionTable.tokens_input,
              output: SessionTable.tokens_output,
              reasoning: SessionTable.tokens_reasoning,
              cacheRead: SessionTable.tokens_cache_read,
              cacheWrite: SessionTable.tokens_cache_write,
            })
            .from(SessionTable)
            .where(eq(SessionTable.id, session.id))
            .get(),
        )

        const first = SessionChanges.page({
          sessionID: session.id,
          after: -1,
          limit: 1,
          now: now(),
          until: 2,
          config,
        })
        const second = SessionChanges.page({
          sessionID: session.id,
          after: first.cursor,
          limit: 10,
          now: now(),
          until: 2,
          config,
        })
        const after = Database.use((db) =>
          db
            .select({
              cost: SessionTable.cost,
              costCny: SessionTable.cost_cny,
              costUsd: SessionTable.cost_usd,
              input: SessionTable.tokens_input,
              output: SessionTable.tokens_output,
              reasoning: SessionTable.tokens_reasoning,
              cacheRead: SessionTable.tokens_cache_read,
              cacheWrite: SessionTable.tokens_cache_write,
            })
            .from(SessionTable)
            .where(eq(SessionTable.id, session.id))
            .get(),
        )

        expect(first.changes).toHaveLength(1)
        expect(first.cursor).toBe(0)
        expect(first.hasMore).toBe(true)
        expect(second.changes).toHaveLength(2)
        expect(second.cursor).toBeGreaterThan(first.cursor)
        expect(second.cursor).toBe(2)
        expect(second.hasMore).toBe(false)
        expect(second.reset).toBe(false)
        expect(after).toEqual(before)
      }),
    { config: { session_changes: { page_size: 2 } } },
  )

  it.instance(
    "applies configured retention and event limits in the real Config service",
    () =>
      Effect.gen(function* () {
        const session = yield* createSession
        for (let i = 0; i < 3; i++) {
          yield* SyncEvent.use.run(
            SessionNS.Event.Updated,
            {
              sessionID: session.id,
              info: { title: `bounded-${i}` },
            },
            { publish: false },
          )
        }
        expect(rows(session.id).map((item) => item.seq)).toEqual([2, 3])
        expect(
          SessionChanges.page({
            sessionID: session.id,
            after: -1,
            limit: 10,
            now: now(),
            config: SessionChanges.resolve({ page_size: 10 }),
          }).reset,
        ).toBe(true)
      }),
    {
      config: {
        session_changes: {
          max_events_per_session: 2,
          max_total_events: 100,
          retention_ms: 10_000,
          page_size: 1,
        },
      },
    },
  )

  it.live("returns reset for legacy cursors, pruned heads, and ahead cursors", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* createSession
        const query = (after: number) =>
          SessionChanges.page({
            sessionID: session.id,
            after,
            limit: 10,
            now: now(),
            config: SessionChanges.resolve(),
          })

        expect(query(-1).reset).toBe(false)
        expect(query(0).reset).toBe(false)

        Database.transaction((tx) => {
          tx.delete(SessionChangeTable).where(eq(SessionChangeTable.session_id, session.id)).run()
        })
        seedMarkers(session.id, [
          { seq: 2, id: "pruned-head", time: now() },
          { seq: 3, id: "tail", time: now() },
        ])
        expect(query(-1).reset).toBe(true)
        expect(query(0).reset).toBe(true)
        expect(query(1).reset).toBe(false)
        expect(query(4).reset).toBe(true)

        Database.transaction((tx) => {
          tx.delete(SessionChangeTable).where(eq(SessionChangeTable.seq, 2)).run()
        })
        expect(query(1).reset).toBe(true)

        Database.transaction((tx) => {
          tx.delete(SessionChangeTable).where(eq(SessionChangeTable.seq, 3)).run()
        })
        expect(query(2).reset).toBe(true)
      }),
    ),
  )

  it.live("returns reset for internal and tail gaps after recording was interrupted", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* createSession
        Database.transaction((tx) => {
          tx.delete(SessionChangeTable).where(eq(SessionChangeTable.session_id, session.id)).run()
        })
        seedMarkers(session.id, [
          { seq: 0, id: "before-gap", time: now() },
          { seq: 2, id: "after-gap", time: now() },
          { seq: 3, id: "tail", time: now() },
        ])
        const page = (after: number) =>
          SessionChanges.page({
            sessionID: session.id,
            after,
            limit: 10,
            now: now(),
            config: SessionChanges.resolve(),
          })

        expect(page(0).reset).toBe(true)
        Database.transaction((tx) => {
          tx.delete(SessionChangeTable).where(eq(SessionChangeTable.seq, 2)).run()
          tx.delete(SessionChangeTable).where(eq(SessionChangeTable.seq, 3)).run()
        })
        expect(page(0).reset).toBe(true)
      }),
    ),
  )

  it.live("prunes strictly older markers but keeps the equal-time retention boundary", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const session = yield* createSession
        const at = now()
        Database.transaction((tx) => {
          for (const marker of [
            { seq: 50, id: "old", time: at - 11 },
            { seq: 51, id: "boundary", time: at - 10 },
            { seq: 52, id: "fresh", time: at },
          ]) {
            SessionChanges.record({
              tx,
              sessionID: session.id,
              ...marker,
              kind: "session",
              config: SessionChanges.resolve({ retention_ms: 10 }),
            })
          }
        })
        expect(rows(session.id).map((row) => row.id)).toEqual(["boundary", "fresh"])
        const result = SessionChanges.page({
          sessionID: session.id,
          after: 49,
          limit: 10,
          now: at,
          config: SessionChanges.resolve({ retention_ms: 10 }),
        })
        expect(result.reset).toBe(true)
      }),
    ),
  )

  it.live("uses event IDs as retention tie-breaks and leaves equal-time global aggregates intact", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const first = yield* createSession
        const second = yield* createSession
        const third = yield* createSession
        const at = now()
        Database.transaction((tx) => {
          tx.delete(SessionChangeTable).run()
          SessionChanges.record({
            tx,
            sessionID: first.id,
            seq: 50,
            id: "shared-event-id",
            kind: "session",
            time: at,
            config: SessionChanges.resolve({ max_total_events: 2 }),
          })
          SessionChanges.record({
            tx,
            sessionID: second.id,
            seq: 50,
            id: "shared-event-id",
            kind: "session",
            time: at,
            config: SessionChanges.resolve({ max_total_events: 2 }),
          })
          SessionChanges.record({
            tx,
            sessionID: third.id,
            seq: 50,
            id: "zzz-new-event",
            kind: "session",
            time: at,
            config: SessionChanges.resolve({ max_total_events: 2 }),
          })
        })
        expect(rows(first.id).length + rows(second.id).length).toBe(1)
        expect(rows(third.id)).toHaveLength(1)
      }),
    ),
  )

  it.instance(
    "disables recording and safely ignores late writes after session deletion",
    () =>
      Effect.gen(function* () {
        const session = yield* createSession
        expect(rows(session.id)).toEqual([])
        const config = SessionChanges.resolve((yield* Config.use.get()).session_changes)
        expect(
          SessionChanges.page({
            sessionID: session.id,
            after: -1,
            limit: 10,
            now: now(),
            config,
          }).reset,
        ).toBe(true)
        const sessionService = yield* SessionNS.Service
        yield* sessionService.remove(session.id)
        Database.transaction((tx) =>
          SessionChanges.record({
            tx,
            sessionID: session.id,
            seq: 100,
            id: "late-after-delete",
            kind: "session",
            time: now(),
            config: SessionChanges.resolve(),
          }),
        )
        expect(rows(session.id)).toEqual([])
        expect(
          Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get()),
        ).toBeUndefined()
        expect(
          Database.use((db) =>
            db.select().from(SessionChangeTable).where(eq(SessionChangeTable.session_id, session.id)).all(),
          ),
        ).toEqual([])
        expect(
          Database.use((db) => db.select().from(MessageTable).where(eq(MessageTable.session_id, session.id)).all()),
        ).toEqual([])
      }),
    { config: { session_changes: { enabled: false } } },
  )

  it.instance("cascades existing markers on session deletion without resurrecting the session", () =>
    Effect.gen(function* () {
      const session = yield* createSession
      expect(rows(session.id)).toHaveLength(1)
      const sessionService = yield* SessionNS.Service
      yield* sessionService.remove(session.id)

      Database.transaction((tx) =>
        SessionChanges.record({
          tx,
          sessionID: session.id,
          seq: 100,
          id: "late-after-cascade",
          kind: "session",
          time: now(),
          config: SessionChanges.resolve(),
        }),
      )

      expect(rows(session.id)).toEqual([])
      expect(
        Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get()),
      ).toBeUndefined()
    }),
  )
})
