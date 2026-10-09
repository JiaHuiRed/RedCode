import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import * as Log from "@redcode-ai/core/util/log"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const it = testEffect(SessionNs.defaultLayer)

const model = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test"),
}

afterEach(async () => {
  await disposeAllInstances()
})

const withoutWatcher = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
  if (process.platform !== "win32") return effect
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.REDCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
      process.env.REDCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = "true"
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.REDCODE_EXPERIMENTAL_DISABLE_FILEWATCHER
        else process.env.REDCODE_EXPERIMENTAL_DISABLE_FILEWATCHER = previous
      }),
  )
}

const sessionScoped = Effect.acquireRelease(SessionNs.use.create({}), (session) =>
  SessionNs.use.remove(session.id).pipe(Effect.ignore),
)

const fill = Effect.fn("SessionMessagesTest.fill")(function* (
  sessionID: SessionID,
  count: number,
  time = (i: number) => Date.now() + i,
) {
  const session = yield* SessionNs.Service
  return yield* Effect.forEach(
    Array.from({ length: count }, (_, i) => i),
    (i) =>
      Effect.gen(function* () {
        const id = MessageID.ascending()
        yield* session.updateMessage({
          id,
          sessionID,
          role: "user",
          time: { created: time(i) },
          agent: "test",
          model,
          tools: {},
        } satisfies MessageV2.User)
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: id,
          type: "text",
          text: `m${i}`,
        } satisfies MessageV2.TextPart)
        return id
      }),
  )
})

function request(path: string) {
  return Effect.promise(() => Promise.resolve(Server.Default().app.request(path)))
}

function json<T>(response: Response) {
  return Effect.promise(() => response.json() as Promise<T>)
}

describe("session messages endpoint", () => {
  it.instance(
    "returns cursor headers for older pages",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 5)

        const a = yield* request(`/session/${session.id}/message?limit=2`)
        expect(a.status).toBe(200)
        const aBody = yield* json<MessageV2.WithParts[]>(a)
        expect(aBody.map((item) => item.info.id)).toEqual(ids.slice(-2))
        const cursor = a.headers.get("x-next-cursor")
        expect(cursor).toBeTruthy()
        expect(a.headers.get("link")).toContain('rel="next"')

        const b = yield* request(`/session/${session.id}/message?limit=2&before=${encodeURIComponent(cursor!)}`)
        expect(b.status).toBe(200)
        const bBody = yield* json<MessageV2.WithParts[]>(b)
        expect(bBody.map((item) => item.info.id)).toEqual(ids.slice(-4, -2))
      }),
    ),
    { git: true },
  )

  it.instance(
    "pages newer messages after a cursor without accepting both directions",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 7)
        const first = yield* request(`/session/${session.id}/message?limit=2`)
        const cursor = first.headers.get("x-next-cursor")!
        const older = yield* request(
          `/session/${session.id}/message?limit=2&before=${encodeURIComponent(cursor)}`,
        )
        const olderCursor = older.headers.get("x-next-cursor")!

        const newer = yield* request(
          `/session/${session.id}/message?limit=2&after=${encodeURIComponent(olderCursor)}`,
        )
        expect(newer.status).toBe(200)
        const body = yield* json<MessageV2.WithParts[]>(newer)
        expect(body.map((item) => item.info.id)).toEqual(ids.slice(4, 6))
        expect(newer.headers.get("x-next-cursor")).toBeTruthy()
        const continuation = yield* request(
          `/session/${session.id}/message?limit=2&after=${encodeURIComponent(newer.headers.get("x-next-cursor")!)}`,
        )
        const tail = yield* json<MessageV2.WithParts[]>(continuation)
        expect(tail.map((item) => item.info.id)).toEqual(ids.slice(6))

        const both = yield* request(
          `/session/${session.id}/message?limit=2&before=${encodeURIComponent(cursor)}&after=${encodeURIComponent(cursor)}`,
        )
        expect(both.status).toBe(400)
      }),
    ),
    { git: true },
  )

  it.instance(
    "walks a 1000-message session both ways with time ties and message-id anchors",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 1000, (i: number) => 100_000 + Math.floor(i / 5))
        let olderCursor: string | undefined
        const olderIDs: string[] = []
        for (let page = 0; page < 14; page++) {
          const response = yield* request(
            `/session/${session.id}/message?limit=80${olderCursor ? `&before=${encodeURIComponent(olderCursor)}` : ""}`,
          )
          expect(response.status).toBe(200)
          const body = yield* json<MessageV2.WithParts[]>(response)
          olderIDs.unshift(...body.map((item) => item.info.id))
          olderCursor = response.headers.get("x-next-cursor") ?? undefined
          if (!olderCursor) break
        }
        expect(olderIDs).toEqual(ids)
        let newerCursor: string = ids[0] ?? ""
        const newerIDs = [ids[0]]
        for (let page = 0; page < 14; page++) {
          const response = yield* request(
            `/session/${session.id}/message?limit=80&after=${encodeURIComponent(newerCursor)}`,
          )
          expect(response.status).toBe(200)
          const body = yield* json<MessageV2.WithParts[]>(response)
          newerIDs.push(...body.map((item) => item.info.id))
          expect(response.headers.get("link") ?? "").not.toContain("before=")
          const cursor = response.headers.get("x-next-cursor")
          if (!cursor) break
          newerCursor = cursor
        }
        expect(newerIDs).toEqual(ids)
      }),
    ),
    { git: true },
  )

  it.instance(
    "rejects empty boundaries and mixed direction parameter presence",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 1)
        for (const query of [`limit=2&after=`, `limit=2&before=&after=${ids[0]}`, `limit=0&after=${ids[0]}`]) {
          const response = yield* request(`/session/${session.id}/message?${query}`)
          expect(response.status).toBe(400)
        }
      }),
    ),
    { git: true },
  )

  it.instance(
    "keeps full-history responses when limit is omitted",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        const ids = yield* fill(session.id, 3)

        const res = yield* request(`/session/${session.id}/message`)
        expect(res.status).toBe(200)
        const body = yield* json<MessageV2.WithParts[]>(res)
        expect(body.map((item) => item.info.id)).toEqual(ids)
      }),
    ),
    { git: true },
  )

  it.instance(
    "rejects invalid cursors and missing sessions",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped

        const bad = yield* request(`/session/${session.id}/message?limit=2&before=bad`)
        expect(bad.status).toBe(400)

        const miss = yield* request(`/session/ses_missing/message?limit=2`)
        expect(miss.status).toBe(404)
      }),
    ),
    { git: true },
  )

  it.instance(
    "does not truncate large legacy limit requests",
    withoutWatcher(
      Effect.gen(function* () {
        const session = yield* sessionScoped
        yield* fill(session.id, 520)

        const res = yield* request(`/session/${session.id}/message?limit=510`)
        expect(res.status).toBe(200)
        const body = yield* json<MessageV2.WithParts[]>(res)
        expect(body).toHaveLength(510)
      }),
    ),
    { git: true },
  )

  it.instance(
    "accepts directory query used by workspace routing",
    withoutWatcher(
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const session = yield* sessionScoped
        yield* fill(session.id, 1)

        const res = yield* request(
          `/session/${session.id}/message?limit=80&directory=${encodeURIComponent(tmp.directory)}`,
        )
        expect(res.status).toBe(200)
        const body = yield* json<unknown[]>(res)
        expect(Array.isArray(body)).toBe(true)
        expect(body).toHaveLength(1)
      }),
    ),
    { git: true },
  )
})
