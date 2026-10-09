import { describe, expect, test } from "bun:test"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import {
  catchUpSessionChanges,
  createSessionChangeJournal,
  listenForGlobalReconnect,
  mergeSnapshotWindow,
  reconcileChangedMessages,
  removedMessageIDs,
  type SessionChangesPage,
} from "./session-changes"
import { createOpencodeClient, type Message } from "@redcode-ai/sdk/v2/client"

const page = (changes: SessionChangesPage["changes"], cursor: number, latest = cursor, hasMore = false) => ({
  latest,
  oldest: 0,
  cursor,
  hasMore,
  reset: false,
  changes,
})

const marker = (seq: number, messageID: string): SessionChangesPage["changes"][number] => ({
  id: `change-${seq}`,
  seq,
  kind: "message",
  messageID,
})

describe("session change journal", () => {
  test("newer changes cannot evict a retained old window before being filtered", () => {
    const message = (n: number): Message => ({
      id: `m${n}`,
      sessionID: "s",
      role: "user",
      time: { created: n },
      agent: "agent",
      model: { providerID: "p", modelID: "m" },
    })
    const current = Array.from({ length: 400 }, (_, n) => message(n))
    const fresh = Array.from({ length: 600 }, (_, n) => message(n + 400))
    const result = reconcileChangedMessages({
      current,
      ids: fresh.map((item) => item.id),
      staged: new Map(fresh.map((item) => [item.id, { message: item, parts: [] }])),
      limit: 400,
      allowInsert: false,
    })
    expect(result.messages).toEqual(current)
    expect(result.parts.size).toBe(0)
    expect(result.userChanged).toBe(true)
  })

  test("empty-session windows cannot loop indefinitely when their cached size is zero", () => {
    const message: Message = {
      id: "first",
      sessionID: "s",
      role: "user",
      time: { created: 1 },
      agent: "agent",
      model: { providerID: "p", modelID: "m" },
    }
    expect(
      reconcileChangedMessages({
        current: [],
        ids: ["first"],
        staged: new Map([["first", { message, parts: [] }]]),
        limit: 0,
      }).messages,
    ).toEqual([message])
  })

  test("the real SDK's wrapped 404 uses the old-server snapshot fallback", async () => {
    const client = createOpencodeClient({
      baseUrl: "http://session-changes.test",
      fetch: Object.assign(
        async () => Response.json({ name: "NotFoundError", data: { message: "old server" } }, { status: 404 }),
        { preconnect: () => {} },
      ),
    })
    let snapshots = 0
    const result = await catchUpSessionChanges({
      after: -1,
      active: () => true,
      changes: async (query) =>
        (
          await client.session.changes(
            { sessionID: "s", after: String(query.after), limit: String(query.limit) },
            { throwOnError: true },
          )
        ).data,
      messageIDs: async () => {},
      snapshot: async () => void snapshots++,
      apply: async () => {},
    })
    expect(result.status).toBe("unsupported")
    expect(snapshots).toBe(1)
  })

  test("exceeding the paging budget refreshes a snapshot without fetching unbounded bodies", async () => {
    let requests = 0
    let snapshots = 0
    const result = await catchUpSessionChanges({
      after: 0,
      active: () => true,
      changes: async (query) => {
        requests++
        return page([marker(query.after + 1, `m-${query.after}`)], query.after + 1, 100, true)
      },
      messageIDs: async () => {
        throw new Error("the bounded fallback must not fetch marker bodies")
      },
      snapshot: async () => void snapshots++,
      apply: async () => {},
    })
    expect(requests).toBe(32)
    expect(snapshots).toBe(1)
    expect(result).toEqual({ status: "fallback", cursor: 100 })
  })

  test("applies full authoritative messages, clears removed multipart state, and leaves window bounded", () => {
    const old: Message = {
      id: "old",
      sessionID: "s",
      role: "user",
      time: { created: 1 },
      agent: "agent",
      model: { providerID: "p", modelID: "m" },
    }
    const edited: Message = { ...old, summary: { title: "edited", diffs: [] } }
    const removed: Message = { ...old, id: "removed", time: { created: 2 } }
    const current: Message[] = [old, removed]
    const reconciled = reconcileChangedMessages({
      current,
      ids: ["old", "removed", "new"],
      staged: new Map([
        ["old", { message: edited, parts: [] }],
        ["removed", undefined],
        ["new", { message: { ...old, id: "new", time: { created: 3 } }, parts: [] }],
      ]),
      limit: 2,
    })
    expect(reconciled.messages).toEqual([edited, { ...old, id: "new", time: { created: 3 } }])
    expect(reconciled.parts.get("old")).toEqual([])
    expect(reconciled.parts.get("removed")).toBeUndefined()
    expect(reconciled.userChanged).toBe(true)
    expect(removedMessageIDs(current, reconciled.messages)).toEqual(["removed"])
  })

  test("pins the first target, pages contiguously and deduplicates message IDs", async () => {
    const requests: { after: number; until?: number; limit: number }[] = []
    const fetched: string[] = []
    const applied: string[][] = []
    const result = await catchUpSessionChanges({
      after: 0,
      active: () => true,
      changes: async (query) => {
        requests.push(query)
        if (query.after === 0) return page([marker(1, "old"), marker(2, "new")], 2, 4, true)
        return page([marker(3, "old"), marker(4, "new")], 4, 4)
      },
      messageIDs: async (id) => void fetched.push(id),
      snapshot: async () => {},
      apply: async (ids) => void applied.push(ids),
    })
    expect(requests).toEqual([
      { after: 0, limit: 256 },
      { after: 2, until: 4, limit: 256 },
    ])
    expect(fetched).toEqual(["old", "new"])
    expect(applied).toEqual([["old", "new"]])
    expect(result).toEqual({ status: "applied", cursor: 4, messages: ["old", "new"] })
  })

  test("initial checkpoint snapshots before acknowledging its captured head", async () => {
    const order: string[] = []
    const result = await catchUpSessionChanges({
      after: -1,
      active: () => true,
      changes: async () => {
        order.push("head")
        return page([], 8)
      },
      messageIDs: async () => {},
      snapshot: async () => void order.push("snapshot"),
      apply: async () => {},
    })
    expect(order).toEqual(["head", "snapshot"])
    expect(result).toEqual({ status: "applied", cursor: 8, messages: [] })
  })

  test("refreshes authoritative session totals even when only a session marker changed", async () => {
    let applied = false
    const result = await catchUpSessionChanges({
      after: 0,
      active: () => true,
      changes: async () => page([{ id: "session-change", seq: 1, kind: "session" }], 1),
      messageIDs: async () => {},
      snapshot: async () => {},
      apply: async (ids) => {
        expect(ids).toEqual([])
        applied = true
      },
    })
    expect(applied).toBe(true)
    expect(result.status).toBe("applied")
  })

  test("reset and old-server 404 use snapshot fallback", async () => {
    let snapshots = 0
    const reset = await catchUpSessionChanges({
      after: 2,
      active: () => true,
      changes: async () => ({ ...page([], 10), reset: true }),
      messageIDs: async () => {},
      snapshot: async () => void snapshots++,
      apply: async () => {},
    })
    const unsupported = await catchUpSessionChanges({
      after: -1,
      active: () => true,
      changes: async () => {
        throw { status: 404 }
      },
      messageIDs: async () => {},
      snapshot: async () => void snapshots++,
      apply: async () => {},
    })
    expect(reset).toEqual({ status: "fallback", cursor: 10 })
    expect(unsupported.status).toBe("unsupported")
    expect(snapshots).toBe(2)
  })

  test("failed requests and stale navigation never acknowledge", async () => {
    const journal = createSessionChangeJournal({
      fetch: async () => {
        throw new Error("offline")
      },
      refreshSnapshot: async () => {},
      fetchMessage: async () => {},
      apply: async () => {},
    })
    await expect(journal.catchup(() => true)).rejects.toThrow("offline")
    expect(journal.cursor()).toBeUndefined()

    let active = true
    const result = await catchUpSessionChanges({
      after: 0,
      active: () => active,
      changes: async () => {
        active = false
        return page([marker(1, "m")], 1)
      },
      messageIDs: async () => {
        throw new Error("must not fetch after navigation")
      },
      snapshot: async () => {},
      apply: async () => {},
    })
    expect(result.status).toBe("cancelled")
  })

  test("live invalidation cancels fetched work without advancing the cursor", async () => {
    let release: (() => void) | undefined
    let started: (() => void) | undefined
    const ready = new Promise<void>((resolve) => (started = resolve))
    let applied = 0
    const journal = createSessionChangeJournal({
      fetch: async (query) => (query.after === -1 ? page([], 0) : page([marker(1, "m")], 1)),
      refreshSnapshot: async () => {},
      fetchMessage: async () =>
        new Promise<void>((resolve) => {
          release = resolve
          started?.()
        }),
      apply: async () => void applied++,
    })
    await journal.catchup(() => true)
    const pending = journal.catchup(() => true)
    await ready
    journal.invalidate()
    release?.()
    expect((await pending).status).toBe("cancelled")
    expect(journal.cursor()).toBe(0)
    expect(applied).toBe(0)
  })

  test("rejects duplicate/out-of-order markers rather than advancing", async () => {
    await expect(
      catchUpSessionChanges({
        after: 0,
        active: () => true,
        changes: async () => page([marker(2, "m"), marker(1, "m")], 2),
        messageIDs: async () => {},
        snapshot: async () => {},
        apply: async () => {},
      }),
    ).rejects.toThrow("non-contiguous")
  })

  test("subscribes to server.connected on global channel only", () => {
    const emitter = createGlobalEmitter<{ global: { type: string }; directoryA: { type: string } }>()
    let requests = 0
    const stop = listenForGlobalReconnect(
      (listener) => emitter.listen(listener),
      () => requests++,
    )
    emitter.emit("directoryA", { type: "server.connected" })
    emitter.emit("global", { type: "message.updated" })
    emitter.emit("global", { type: "server.connected" })
    expect(requests).toBe(1)
    stop()
    emitter.emit("global", { type: "server.connected" })
    expect(requests).toBe(1)
  })
})

describe("mergeSnapshotWindow", () => {
  const msg = (id: string, created: number): Message => ({
    id,
    sessionID: "s",
    role: "user",
    time: { created },
    agent: "agent",
    model: { providerID: "p", modelID: "m" },
  })

  test("keeps history older than the fetched window and holds the cursor", () => {
    const current = [msg("m1", 1), msg("m2", 2), msg("m3", 3), msg("m5", 5)]
    const result = mergeSnapshotWindow({ current, fetched: [msg("m3", 3), msg("m4", 4)] })
    expect(result.messages.map((message) => message.id)).toEqual(["m1", "m2", "m3", "m4"])
    expect(result.removed).toEqual(["m5"])
    expect(result.keepCursor).toBeTrue()
  })

  test("advances the cursor once the fetched window covers the store", () => {
    const current = [msg("m2", 2), msg("m3", 3), msg("mX", 4)]
    const result = mergeSnapshotWindow({ current, fetched: [msg("m2", 2), msg("m3", 3), msg("m4", 4)] })
    expect(result.messages.map((message) => message.id)).toEqual(["m2", "m3", "m4"])
    expect(result.removed).toEqual(["mX"])
    expect(result.keepCursor).toBeFalse()
  })

  test("an empty fetched window clears everything and follows the returned cursor", () => {
    const current = [msg("m1", 1), msg("m2", 2)]
    const result = mergeSnapshotWindow({ current, fetched: [] })
    expect(result.messages).toEqual([])
    expect(result.removed).toEqual(["m1", "m2"])
    expect(result.keepCursor).toBeFalse()
  })
})
