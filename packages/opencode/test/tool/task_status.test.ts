import { afterEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { TaskStatusTool, stallWarning } from "@/tool/task_status"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const layer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Layer.mergeAll(
    Agent.defaultLayer,
    BackgroundJob.defaultLayer,
    Bus.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    SessionStatus.defaultLayer,
    Truncate.defaultLayer,
    RuntimeFlags.layer(flags),
  )

const it = testEffect(layer({ experimentalBackgroundSubagents: true }))

describe("tool.task_status", () => {
  it.instance("conflicting full arguments explain how to omit inactive fields", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({})
      const def = yield* (yield* TaskStatusTool).init()
      const context = {
        sessionID: chat.id,
        messageID: MessageID.ascending(),
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const exit = yield* def.execute(
        { task_id: chat.id, wait: false, timeout_ms: 1000, cancel: false, message: "" },
        context,
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const text = Cause.pretty(exit.cause)
        expect(text).toContain("omit message entirely")
        expect(text).toContain("omit wait, timeout_ms, and cancel")
      }
      expect((yield* def.execute({ task_id: chat.id }, context)).title).toBe("Task status")
    }),
  )

  for (const message of ["", "   ", "x".repeat(16_385)]) {
    it.instance(`rejects invalid steer text (${message.length} characters)`, () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({})
        const child = yield* sessions.create({ parentID: parent.id })
        const def = yield* (yield* TaskStatusTool).init()
        const exit = yield* def.execute(
          { task_id: child.id, message },
          {
            sessionID: parent.id,
            messageID: MessageID.ascending(),
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        ).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    )
  }

  it.instance("rejects steering an unrelated session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({})
      const unrelated = yield* sessions.create({})
      const jobs = yield* BackgroundJob.Service
      yield* jobs.start({ id: unrelated.id, type: "task", run: Effect.never })
      const def = yield* (yield* TaskStatusTool).init()
      const exit = yield* def.execute(
        { task_id: unrelated.id, message: "new guidance" },
        {
          sessionID: parent.id,
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect((yield* jobs.get(unrelated.id))?.status).toBe("running")
      yield* jobs.cancel(unrelated.id)
    }),
  )

  it.instance("rejects steering an idle child instead of starting a new task", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const parent = yield* sessions.create({})
      const child = yield* sessions.create({ parentID: parent.id })
      const def = yield* (yield* TaskStatusTool).init()
      const exit = yield* def.execute(
        { task_id: child.id, message: "do not restart" },
        {
          sessionID: parent.id,
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("returns completed background job output", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const tool = yield* TaskStatusTool
      const def = yield* tool.init()
      const chat = yield* sessions.create({})

      yield* jobs.start({ id: chat.id, type: "task", run: Effect.succeed("all done") })

      const result = yield* def.execute(
        { task_id: chat.id, wait: true, timeout_ms: 1_000 },
        {
          sessionID: chat.id,
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("state: completed")
      expect(result.output).toContain("all done")
      expect(result.metadata.timed_out).toBe(false)
    }),
  )

  it.instance("wait=true times out while the background job is running", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const tool = yield* TaskStatusTool
      const def = yield* tool.init()
      const chat = yield* sessions.create({})

      yield* jobs.start({ id: chat.id, type: "task", run: Effect.never })

      const result = yield* def.execute(
        { task_id: chat.id, wait: true, timeout_ms: 50 },
        {
          sessionID: chat.id,
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("state: running")
      expect(result.output).toContain("Timed out after 50ms")
      expect(result.metadata.timed_out).toBe(true)
      yield* jobs.cancel(chat.id)
    }),
  )

  it.instance("cancels a running task and its background job", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.Service
      const sessions = yield* Session.Service
      const tool = yield* TaskStatusTool
      const def = yield* tool.init()
      const chat = yield* sessions.create({})
      const child = yield* sessions.create({})

      yield* jobs.start({ id: chat.id, type: "task", run: Effect.never })
      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: chat.id },
        run: Effect.never,
      })

      const result = yield* def.execute(
        { task_id: chat.id, cancel: true },
        {
          sessionID: chat.id,
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("state: cancelled")
      expect((yield* jobs.get(chat.id))?.status).toBe("cancelled")
      expect((yield* jobs.get(child.id))?.status).toBe("cancelled")
    }),
  )

  // 261023 Red 子代理卡死警告：状态段打点 + 超限提示（只警告不终止）。
  it.instance("stamps status segments and keeps the origin across same-type rewrites", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const chat = yield* sessions.create({})

      yield* status.set(chat.id, { type: "busy" })
      const busy = yield* status.get(chat.id)
      if (busy.type !== "busy") return
      expect(busy.since).toBeDefined()

      yield* status.set(chat.id, { type: "busy" })
      const busyAgain = yield* status.get(chat.id)
      // retry 每个 attempt 都会重写一次状态：同类型重写必须保留段起点，
      // 否则「卡了多久」永远从最近一次重写算起，警告永远不触发。
      if (busyAgain.type !== "busy") return
      expect(busyAgain.since).toBe(busy.since!)

      yield* status.set(chat.id, {
        type: "retry",
        attempt: 1,
        message: "gateway not responding",
        next: Date.now() + 1_000,
      })
      const retry = yield* status.get(chat.id)
      if (retry.type !== "retry") return
      expect(retry.since).toBeGreaterThanOrEqual(busy.since!)

      yield* status.set(chat.id, { type: "idle" })
      expect((yield* status.get(chat.id)).type).toBe("idle")
    }),
  )

  it.instance("reports retry progress and appends the stall warning past the threshold", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const status = yield* SessionStatus.Service
      const tool = yield* TaskStatusTool
      const def = yield* tool.init()
      const parent = yield* sessions.create({})
      const child = yield* sessions.create({ parentID: parent.id })

      const now = Date.now()
      yield* status.set(child.id, {
        type: "retry",
        attempt: 7,
        message: "provider quota exceeded",
        next: now + 1_000,
        since: now - 10 * 60_000,
      })

      const result = yield* def.execute(
        { task_id: child.id },
        {
          sessionID: parent.id,
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.output).toContain("state: running")
      expect(result.output).toContain("Task is retrying (attempt 7/10): provider quota exceeded")
      expect(result.output).toContain('in "retry" for ~10 min')
      expect(result.output).toContain("cancel: true")
      expect(result.metadata.timed_out).toBe(false)
    }),
  )

  describe("stallWarning", () => {
    const warnMs = 6 * 60_000
    const now = 1_000_000_000

    test("stays silent inside the threshold and without a segment origin", () => {
      expect(stallWarning({ type: "busy", since: now - warnMs + 1_000 }, now, warnMs)).toBeUndefined()
      expect(stallWarning({ type: "busy" }, now, warnMs)).toBeUndefined()
    })

    test("warns past the threshold without suggesting an abort", () => {
      const text = stallWarning({ type: "busy", since: now - 10 * 60_000 }, now, warnMs)
      expect(text).toContain('"busy"')
      expect(text).toContain("~10 min")
      expect(text).toContain("cancel: true")
      expect(text).not.toContain("abort")
    })
  })
})
