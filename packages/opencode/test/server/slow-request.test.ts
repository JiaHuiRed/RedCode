// 261011 Red B0.1（审计 ZW-03）：慢请求日志的三种出口。原实现用 Effect.timed(effect)
// 计时，failure/interruption 会短路——失败与中断恰好是事故里最缺证据的出口。这里用
// TestClock 拨动时间（实现计时走 Clock），不真等 3.5s。
import { describe, expect } from "bun:test"
import { Duration, Effect, Exit } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { makeRequestLogging, type SlowRequestRecord } from "@/server/server"
import { it } from "../lib/effect"

// 只填 middleware 会触碰的字段（method/url/headers）
const fakeRequest = (url: string, headers: Record<string, string> = {}) =>
  ({ method: "GET", url, headers }) as unknown as HttpServerRequest.HttpServerRequest

const logging = (entries: SlowRequestRecord[]) => makeRequestLogging((record) => entries.push(record))

const slowOk = Effect.gen(function* () {
  yield* TestClock.adjust(Duration.millis(3500))
  return HttpServerResponse.text("ok")
})

describe("慢请求日志（ZW-03）", () => {
  it.effect("100ms 正常返回不记录", () =>
    Effect.gen(function* () {
      const entries: SlowRequestRecord[] = []
      yield* logging(entries)(
        Effect.gen(function* () {
          yield* TestClock.adjust(Duration.millis(100))
          return HttpServerResponse.text("ok")
        }),
      ).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, fakeRequest("/session?directory=/tmp/demo")))
      expect(entries).toHaveLength(0)
    }),
  )

  it.effect("3.5s 成功：记录 success 与真实 status", () =>
    Effect.gen(function* () {
      const entries: SlowRequestRecord[] = []
      const response = yield* logging(entries)(
        Effect.gen(function* () {
          yield* TestClock.adjust(Duration.millis(3500))
          return HttpServerResponse.text("ok", { status: 201 })
        }),
      ).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, fakeRequest("/session?directory=/tmp/demo")))
      expect(response.status).toBe(201)
      expect(entries).toEqual([
        { method: "GET", path: "/session", directory: "/tmp/demo", outcome: "success", status: 201, ms: 3500 },
      ])
    }),
  )

  it.effect("3.5s 失败：原错误照常传播，且记录 failure", () =>
    Effect.gen(function* () {
      const entries: SlowRequestRecord[] = []
      const exit = yield* logging(entries)(
        Effect.gen(function* () {
          yield* TestClock.adjust(Duration.millis(3500))
          return yield* Effect.fail(new Error("boom"))
        }),
      ).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, fakeRequest("/session?directory=/tmp/demo")),
        Effect.exit,
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ outcome: "failure", ms: 3500, path: "/session", directory: "/tmp/demo" })
      expect(entries[0].status).toBeUndefined()
    }),
  )

  it.effect("3.5s 中断：exit 保留中断，且记录 interrupted", () =>
    Effect.gen(function* () {
      const entries: SlowRequestRecord[] = []
      const exit = yield* logging(entries)(
        Effect.gen(function* () {
          yield* TestClock.adjust(Duration.millis(3500))
          return yield* Effect.interrupt
        }),
      ).pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, fakeRequest("/session?directory=/tmp/demo")),
        Effect.exit,
      )
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ outcome: "interrupted", ms: 3500 })
      expect(entries[0].status).toBeUndefined()
    }),
  )

  it.effect("directory：query 缺省时回退 header", () =>
    Effect.gen(function* () {
      const entries: SlowRequestRecord[] = []
      yield* logging(entries)(slowOk).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          fakeRequest("/x", { "x-redcode-directory": "/tmp/from-header" }),
        ),
      )
      expect(entries[0]?.directory).toBe("/tmp/from-header")
    }),
  )
})
