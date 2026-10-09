import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Schema, Stream } from "effect"
import { GlobalBus } from "@/bus/global"
import { ConfigServer } from "@/config/server"
import { Server } from "@/server/server"
import { globalEventStream } from "@/server/routes/instance/httpapi/handlers/global-event-stream"
import { eventData } from "@/server/routes/instance/httpapi/handlers/sse-encode"
import { it, pollWithTimeout } from "../lib/effect"

function paused(limits: ReturnType<typeof ConfigServer.resolveEventBuffer>) {
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>()
    const resume = yield* Deferred.make<void>()
    const received = yield* Deferred.make<void>()
    const data: string[] = []
    const fiber = yield* globalEventStream(limits).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          data.push(event.data)
          if (!event.data.includes("server.connected")) return yield* Deferred.succeed(received, undefined)
          yield* Deferred.succeed(ready, undefined)
          yield* Deferred.await(resume)
        }),
      ),
      Effect.forkScoped,
    )
    yield* Deferred.await(ready)
    return { fiber, data, resume, received }
  })
}

describe("global SSE buffer", () => {
  test("resolves defaults and validates explicit budgets", () => {
    expect(ConfigServer.resolveEventBuffer()).toEqual({ maxEvents: 256, maxBytes: 8388608 })
    const config = Schema.decodeUnknownSync(ConfigServer.Server)({ sse: { max_events: 3, max_bytes: 1024 } })
    expect(ConfigServer.resolveEventBuffer(config)).toEqual({ maxEvents: 3, maxBytes: 1024 })
    for (const value of [0, -1, 1.5, Infinity]) {
      expect(() => Schema.decodeUnknownSync(ConfigServer.Server)({ sse: { max_events: value } })).toThrow()
      expect(() => Schema.decodeUnknownSync(ConfigServer.Server)({ sse: { max_bytes: value } })).toThrow()
    }
  })

  it.effect("fails explicitly at the event budget without blocking the publisher", () =>
    Effect.gen(function* () {
      const listeners = GlobalBus.listenerCount("event")
      const consumer = yield* paused({ maxEvents: 2, maxBytes: 4096 })
      yield* Effect.sync(() => {
        for (let index = 0; index < 4; index++) {
          GlobalBus.emit("event", { payload: { type: "server.heartbeat", properties: { index } } })
        }
      })
      expect(GlobalBus.listenerCount("event")).toBe(listeners)
      yield* Deferred.succeed(consumer.resume, undefined)
      const error = yield* Fiber.join(consumer.fiber).pipe(Effect.flip)
      expect(error._tag).toBe("GlobalEventStreamError")
      expect(error.reason).toBe("events")
      expect(consumer.data).toHaveLength(3)
    }),
  )

  it.effect("counts cumulative UTF-8 bytes, not JavaScript string length", () =>
    Effect.gen(function* () {
      const event = { payload: { id: "evt_bytes", type: "probe", properties: { text: "界".repeat(80) } } }
      const bytes = Buffer.byteLength(eventData(event).data, "utf8")
      const consumer = yield* paused({ maxEvents: 10, maxBytes: bytes * 2 })
      yield* Effect.sync(() => {
        GlobalBus.emit("event", event)
        GlobalBus.emit("event", event)
        GlobalBus.emit("event", event)
      })
      yield* Deferred.succeed(consumer.resume, undefined)
      const error = yield* Fiber.join(consumer.fiber).pipe(Effect.flip)
      expect(error.reason).toBe("bytes")
      expect(consumer.data).toHaveLength(3)
    }),
  )

  it.effect("rejects one oversized event and releases listeners on cancellation", () =>
    Effect.gen(function* () {
      const listeners = GlobalBus.listenerCount("event")
      const consumer = yield* paused({ maxEvents: 10, maxBytes: 512 })
      yield* Effect.sync(() =>
        GlobalBus.emit("event", { payload: { type: "probe", properties: { text: "x".repeat(1024) } } }),
      )
      yield* Deferred.succeed(consumer.resume, undefined)
      expect((yield* Fiber.join(consumer.fiber).pipe(Effect.flip)).reason).toBe("bytes")
      expect(consumer.data).toHaveLength(1)
      expect(GlobalBus.listenerCount("event")).toBe(listeners)
      yield* globalEventStream({ maxEvents: 1, maxBytes: 512 }).pipe(Stream.take(1), Stream.runDrain)
      expect(GlobalBus.listenerCount("event")).toBe(listeners)
    }),
  )

  it.effect("a reconnected subscriber receives new events with a fresh budget", () =>
    Effect.gen(function* () {
      const first = yield* paused({ maxEvents: 1, maxBytes: 512 })
      yield* Effect.sync(() => {
        GlobalBus.emit("event", { payload: { type: "probe", properties: {} } })
        GlobalBus.emit("event", { payload: { type: "probe", properties: {} } })
      })
      yield* Deferred.succeed(first.resume, undefined)
      yield* Fiber.join(first.fiber).pipe(Effect.flip)
      const second = yield* paused({ maxEvents: 1, maxBytes: 512 })
      yield* Effect.sync(() => GlobalBus.emit("event", { payload: { type: "probe.recovered", properties: {} } }))
      yield* Deferred.succeed(second.resume, undefined)
      yield* Deferred.await(second.received)
      expect(second.data[1]).toContain("probe.recovered")
      yield* Fiber.interrupt(second.fiber)
    }),
  )

  it.effect("releases the budget as a healthy consumer drains events", () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const acknowledgements = yield* Effect.all(Array.from({ length: 4 }, () => Deferred.make<void>()))
      let received = 0
      const fiber = yield* globalEventStream({ maxEvents: 1, maxBytes: 512 }).pipe(
        Stream.runForEach((event) =>
          event.data.includes("server.connected")
            ? Deferred.succeed(ready, undefined)
            : Deferred.succeed(acknowledgements[received++], undefined),
        ),
        Effect.forkScoped,
      )
      yield* Deferred.await(ready)
      for (const acknowledgement of acknowledgements) {
        yield* Effect.sync(() => GlobalBus.emit("event", { payload: { type: "probe", properties: {} } }))
        yield* Deferred.await(acknowledgement)
      }
      expect(received).toBe(4)
      yield* Fiber.interrupt(fiber)
    }),
  )

  it.effect("isolates an encoding failure from the GlobalBus publisher and other subscribers", () =>
    Effect.gen(function* () {
      const consumer = yield* paused({ maxEvents: 10, maxBytes: 512 })
      let delivered = 0
      const listener = () => delivered++
      yield* Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", listener)),
        () => Effect.sync(() => GlobalBus.off("event", listener)),
      )
      const properties: { self?: unknown } = {}
      properties.self = properties
      expect(() => GlobalBus.emit("event", { payload: { type: "probe", properties } })).not.toThrow()
      expect(delivered).toBe(1)
      yield* Deferred.succeed(consumer.resume, undefined)
      expect((yield* Fiber.join(consumer.fiber).pipe(Effect.flip)).reason).toBe("encoding")
    }),
  )

  it.live("detaches an overflowing subscriber while the consumer is paused", () =>
    Effect.gen(function* () {
      const listeners = GlobalBus.listenerCount("event")
      const controller = new AbortController()
      const reader = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const response = await Server.Default().app.request("/global/event", { signal: controller.signal })
          expect(response.status).toBe(200)
          if (!response.body) throw new Error("missing SSE body")
          return response.body.getReader()
        }),
        (reader) =>
          Effect.promise(async () => {
            controller.abort()
            // Overflow intentionally errors the response body; cancellation must still release the reader.
            await reader.cancel().catch(() => undefined)
          }),
      )
      const connected = yield* Effect.promise(() => reader.read())
      expect(new TextDecoder().decode(connected.value)).toContain("server.connected")
      // Start the next pull so the legacy concat path also acquires its listener.
      const pending = reader.read().catch(() => undefined)
      yield* pollWithTimeout(
        Effect.sync(() => (GlobalBus.listenerCount("event") > listeners ? true : undefined)),
        "global SSE listener was not acquired",
      )
      yield* Effect.sync(() => {
        for (let index = 0; index < 4096; index++) {
          GlobalBus.emit("event", { payload: { type: "server.heartbeat", properties: { index } } })
        }
      })
      expect(GlobalBus.listenerCount("event")).toBe(listeners)
      yield* Effect.promise(() => pending)
      const ended = yield* Effect.promise(async () => {
        for (let index = 0; index < 1024; index++) {
          // Overflow can surface as an errored body or an EOF, depending on the HTTP transport.
          const next = await reader.read().catch(() => ({ done: true }))
          if (next.done) return true
        }
        return false
      })
      expect(ended).toBe(true)
    }),
  )
})
