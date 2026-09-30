// 260814 Red 工具级 cooperative 超时（tool.ts wrap 层统一拦截）
import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer))

const params = Schema.Struct({ input: Schema.String })

function makeCtx(): Tool.Context {
  return {
    sessionID: SessionID.descending(),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata() {
      return Effect.void
    },
    ask() {
      return Effect.void
    },
  }
}

function slowTool(timeoutMs: number | undefined, sleepMs: number) {
  return {
    description: "test tool",
    parameters: params,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    execute() {
      return Effect.sleep(sleepMs).pipe(
        Effect.map(() => ({ title: "test", output: "ok", metadata: { truncated: false } })),
      )
    },
  }
}

describe("Tool timeoutMs", () => {
  it.live("caller interruption stays interruption and cancels the tool-local signal", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const upstream = new AbortController()
      const observed: { signal?: AbortSignal; aborted: boolean } = { aborted: false }
      const info = yield* Tool.define(
        "interrupted-tool",
        Effect.succeed({
          description: "test outer cancellation",
          parameters: params,
          timeoutMs: 5000,
          execute(_args, ctx) {
            observed.signal = ctx.abort
            ctx.abort.addEventListener("abort", () => (observed.aborted = true), { once: true })
            return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
          },
        }),
      )
      const tool = yield* info.init()
      const fiber = yield* tool.execute({ input: "x" }, { ...makeCtx(), abort: upstream.signal }).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(observed.signal?.aborted).toBe(true)
      expect(observed.aborted).toBe(true)
      expect(upstream.signal.aborted).toBe(false)
    }),
  )

  it.live("deadline aborts the tool context without aborting its caller", () =>
    Effect.gen(function* () {
      const upstream = new AbortController()
      yield* Effect.addFinalizer(() => Effect.sync(() => upstream.abort()))
      const observed: { signal?: AbortSignal; aborted: boolean } = { aborted: false }
      const info = yield* Tool.define(
        "signal-tool",
        Effect.succeed({
          description: "test signal cancellation",
          parameters: params,
          timeoutMs: 20,
          execute(_args, ctx) {
            observed.signal = ctx.abort
            return Effect.promise(
              () =>
                new Promise<Tool.ExecuteResult>((resolve) => {
                  ctx.abort.addEventListener(
                    "abort",
                    () => {
                      observed.aborted = true
                      resolve({ title: "cancelled", output: "cancelled", metadata: {} })
                    },
                    { once: true },
                  )
                }),
            )
          },
        }),
      )
      const tool = yield* info.init()
      const exit = yield* tool.execute({ input: "x" }, { ...makeCtx(), abort: upstream.signal }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      expect(observed.signal).not.toBe(upstream.signal)
      expect(observed.aborted).toBe(true)
      expect(upstream.signal.aborted).toBe(false)
      if (!Exit.isFailure(exit)) return
      expect(exit.cause.reasons.find(Cause.isDieReason)?.defect).toBeInstanceOf(Tool.TimeoutError)
    }),
  )

  it.live("execute exceeding the budget fails with typed TimeoutError carrying model-facing prose", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define("slow-tool", Effect.succeed(slowTool(20, 5_000)))
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

      const exit = yield* execute({ input: "x" }, makeCtx()).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return

      // wrap ends with Effect.orDie: the typed failure surfaces as a defect in the cause.
      const die = exit.cause.reasons.find(Cause.isDieReason)
      const error = die?.defect
      expect(error).toBeInstanceOf(Tool.TimeoutError)
      const timeout = error as Tool.TimeoutError
      expect(timeout.tool).toBe("slow-tool")
      expect(timeout.ms).toBe(20)
      expect(timeout.message).toContain("timed out after 20ms")
      expect(timeout.message).toContain("different approach")
    }),
  )

  it.live("execute within the budget succeeds untouched", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define("fast-tool", Effect.succeed(slowTool(2_000, 10)))
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

      const result = yield* execute({ input: "x" }, makeCtx())
      expect(result.output).toBe("ok")
    }),
  )

  it.live("tool without timeoutMs is not armed", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define("no-budget-tool", Effect.succeed(slowTool(undefined, 50)))
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

      const result = yield* execute({ input: "x" }, makeCtx())
      expect(result.output).toBe("ok")
    }),
  )
})
