// 260814 Red 工具级 cooperative 超时（tool.ts wrap 层统一拦截）
import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
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
