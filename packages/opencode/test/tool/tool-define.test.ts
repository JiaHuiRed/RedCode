import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { ImageTokens } from "@/session/image-tokens"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, Agent.defaultLayer))
const budgetIt = testEffect(
  Layer.mergeAll(
    Layer.mock(Truncate.Service)({
      result: (input) =>
        Effect.succeed({
          output: `${input.output}\n[fit]`,
          attachments: input.attachments,
          metadata: {
            truncated: true,
            outputPath: input.outputPath ?? "spill.txt",
          },
        }),
    }),
    Agent.defaultLayer,
  ),
)

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

function makeTool(id: string, executeFn?: () => void) {
  return {
    description: "test tool",
    parameters: params,
    execute() {
      executeFn?.()
      return Effect.succeed({ title: "test", output: "ok", metadata: {} })
    },
  }
}

describe("Tool.define", () => {
  it.live("limits a tool result that reports truncated false", () =>
    Effect.gen(function* () {
      const original = "r".repeat(80_000)
      const info = yield* Tool.define(
        "tool-pretruncated",
        Effect.succeed({
          description: "test tool",
          parameters: params,
          execute() {
            return Effect.succeed({ title: "test", output: original, metadata: { truncated: false } })
          },
        }),
      )
      const tool = yield* info.init()
      const result = yield* tool.execute({ input: "value" }, makeCtx())

      expect(result.metadata.truncated).toBe(true)
      expect(result.output).not.toBe(original)
      expect(result.output).toContain("Full output saved to:")
      const outputPath = "outputPath" in result.metadata ? result.metadata.outputPath : undefined
      expect(typeof outputPath).toBe("string")
      if (typeof outputPath !== "string") return
      expect(yield* Effect.promise(() => Bun.file(outputPath).text())).toBe(original)
      expect(ImageTokens.estimateToolResult({ text: result.output }, { providerID: "" })).toBeLessThanOrEqual(
        ImageTokens.TOOL_RESULT_TOKEN_BUDGET,
      )
    }),
  )

  budgetIt.effect("applies the model-visible budget even when tool metadata already defines truncated", () =>
    Effect.gen(function* () {
      for (const [id, metadata] of [
        ["truncated-false", { truncated: false }],
        ["truncated-with-path", { truncated: true, outputPath: "existing.txt" }],
      ] as const) {
        const info = yield* Tool.define(
          id,
          Effect.succeed({
            description: "test tool",
            parameters: params,
            execute() {
              return Effect.succeed({ title: id, output: "raw", metadata })
            },
          }),
        )
        const tool = yield* info.init()
        const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>
        const result = yield* execute({ input: "value" }, makeCtx())

        expect(result.output).toBe("raw\n[fit]")
        expect(result.metadata.outputPath).toBe("outputPath" in metadata ? metadata.outputPath : "spill.txt")
      }
    }),
  )

  it.effect("object-defined tool does not mutate the original init object", () =>
    Effect.gen(function* () {
      const original = makeTool("test")
      const originalExecute = original.execute

      const info = yield* Tool.define("test-tool", Effect.succeed(original))

      yield* info.init()
      yield* info.init()
      yield* info.init()

      expect(original.execute).toBe(originalExecute)
    }),
  )

  it.effect("effect-defined tool returns fresh objects and is unaffected", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define(
        "test-fn-tool",
        Effect.succeed(() => Effect.succeed(makeTool("test"))),
      )

      const first = yield* info.init()
      const second = yield* info.init()

      expect(first).not.toBe(second)
    }),
  )

  it.effect("object-defined tool returns distinct objects per init() call", () =>
    Effect.gen(function* () {
      const info = yield* Tool.define("test-copy", Effect.succeed(makeTool("test")))

      const first = yield* info.init()
      const second = yield* info.init()

      expect(first).not.toBe(second)
    }),
  )

  it.effect("execute receives decoded parameters", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({
        count: Schema.NumberFromString.pipe(Schema.optional, Schema.withDecodingDefaultType(Effect.succeed(5))),
      })
      const calls: Array<Schema.Schema.Type<typeof parameters>> = []
      const info = yield* Tool.define(
        "test-decoded",
        Effect.succeed({
          description: "test tool",
          parameters,
          execute(args: Schema.Schema.Type<typeof parameters>) {
            calls.push(args)
            return Effect.succeed({ title: "test", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const ctx = makeCtx()
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

      yield* execute({}, ctx)
      yield* execute({ count: "7" }, ctx)

      expect(calls).toEqual([{ count: 5 }, { count: 7 }])
    }),
  )

  // Regression for #28438: the wrap is the canonical "untyped → typed" boundary.
  // When the LLM emits a tool call with a payload that fails the parameter
  // schema, the wrap must surface a typed `Tool.InvalidArgumentsError` whose
  // `.message` is the actionable prose the AI SDK feeds back to the model.
  it.effect("invalid args surface as Tool.InvalidArgumentsError with friendly message and JSON path", () =>
    Effect.gen(function* () {
      const parameters = Schema.Struct({
        questions: Schema.Array(
          Schema.Struct({
            question: Schema.String,
            options: Schema.Array(Schema.String),
          }),
        ),
      })
      const info = yield* Tool.define(
        "qtest",
        Effect.succeed({
          description: "test tool",
          parameters,
          execute() {
            return Effect.succeed({ title: "ok", output: "ok", metadata: { truncated: false } })
          },
        }),
      )
      const tool = yield* info.init()
      const execute = tool.execute as unknown as (args: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>

      // Missing required `question` field on the first questions[] entry.
      const exit = yield* execute({ questions: [{ options: ["a"] }] }, makeCtx()).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return

      // The wrap ends with Effect.orDie, so the failure lives in the cause as a
      // defect. Recover the typed instance from there.
      const die = exit.cause.reasons.find(Cause.isDieReason)
      const error = die?.defect
      expect(error).toBeInstanceOf(Tool.InvalidArgumentsError)
      const args = error as Tool.InvalidArgumentsError
      expect(args.tool).toBe("qtest")
      expect(args.message).toContain("qtest tool was called with invalid arguments")
      expect(args.message).toContain("Please rewrite the input")
      expect(args.message).toContain(`["questions"][0]["question"]`)
    }),
  )
})
