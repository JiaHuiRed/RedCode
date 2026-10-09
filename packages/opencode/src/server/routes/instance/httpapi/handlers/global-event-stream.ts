import { Cause, Effect, Queue, Schema, Stream } from "effect"
import type * as Sse from "effect/unstable/encoding/Sse"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Bus } from "@/bus"
import type { ConfigServer } from "@/config/server"
import * as Log from "@redcode-ai/core/util/log"
import { eventData } from "./sse-encode"

const log = Log.create({ service: "server" })

export class GlobalEventStreamError extends Schema.TaggedErrorClass<GlobalEventStreamError>()("GlobalEventStreamError", {
  reason: Schema.Literals(["events", "bytes", "encoding"]),
  maxEvents: Schema.Number,
  maxBytes: Schema.Number,
}) {}

// 261009 Red 每连接按条数和序列化字节双限额；不静默丢事件、不阻塞 GlobalBus 发布者。
// 决策：docs/notes/implemented/bug-fix/2026-10-09-global-sse-buffer.md
export function globalEventStream(limits: ReturnType<typeof ConfigServer.resolveEventBuffer>) {
  return Stream.suspend(() => {
    let pendingEvents = 0
    let pendingBytes = 0
    let closed = false
    return Stream.callback<{ event: Sse.Event; bytes: number }, GlobalEventStreamError>(
      (queue) => {
        const fail = (reason: "events" | "bytes" | "encoding") => {
          closed = true
          GlobalBus.off("event", handler)
          log.warn("global event stream failed", { reason, ...limits, pendingEvents, pendingBytes })
          Queue.failCauseUnsafe(queue, Cause.fail(new GlobalEventStreamError({ reason, ...limits })))
        }
        const handler = (event: GlobalEvent) => {
          if (closed) return
          if (pendingEvents >= limits.maxEvents) return fail("events")
          let encoded: Sse.Event
          try {
            encoded = eventData(event)
          } catch {
            // 261009 Red 序列化失败只终止本订阅，不能沿同步 emit 污染生产者或其他 listener。
            return fail("encoding")
          }
          const bytes = Buffer.byteLength(encoded.data, "utf8")
          if (bytes > limits.maxBytes - pendingBytes) return fail("bytes")
          pendingEvents += 1
          pendingBytes += bytes
          if (!Queue.offerUnsafe(queue, { event: encoded, bytes })) fail("events")
        }
        return Effect.acquireRelease(
          Effect.sync(() => {
            GlobalBus.on("event", handler)
            // Ready means the listener is already installed, not merely that HTTP headers were sent.
            handler({ payload: { id: Bus.createID(), type: "server.connected", properties: {} } })
          }),
          () =>
            Effect.sync(() => {
              closed = true
              GlobalBus.off("event", handler)
            }),
        )
      },
      { bufferSize: limits.maxEvents, strategy: "dropping" },
    ).pipe(
      Stream.map((item) => {
        pendingEvents -= 1
        pendingBytes -= item.bytes
        return item.event
      }),
    )
  })
}
