import { Effect, Schema } from "effect"
import type { JSONSchema7 } from "@ai-sdk/provider"
import type { MessageV2 } from "../session/message-v2"
import type { Permission } from "../permission"
import type { SessionID, MessageID } from "../session/schema"
import * as Truncate from "./truncate"
import { Agent } from "@/agent/agent"

interface Metadata {
  [key: string]: any
}

/**
 * Raised when the LLM calls a tool with arguments that fail the parameter
 * schema. This is the canonical "rewrite the input" tool error: the typed
 * error class makes it matchable upstream, and its `message` getter produces
 * the model-facing prose that the AI SDK feeds back as the tool result.
 */
export class InvalidArgumentsError extends Schema.TaggedErrorClass<InvalidArgumentsError>()(
  "ToolInvalidArgumentsError",
  {
    tool: Schema.String,
    detail: Schema.String,
  },
) {
  override get message() {
    return `The ${this.tool} tool was called with invalid arguments: ${this.detail}.\nPlease rewrite the input so it satisfies the expected schema.`
  }
}

// 260814 Red 工具级 cooperative 超时（参考 DeepSeek Harness guard/timeout-policy）
// 决策见 docs/notes/：超时走与 InvalidArgumentsError 同构的 typed-error 路径——
// orDie 变 defect、AI SDK 把 message 转成 tool error result，模型拿到结构化文案自纠,
// 整轮不再被一个挂死的工具吊死。Effect fiber 中断是协作式的：不配合取消的底层操作
// （如已 spawn 的子进程）超时后可能继续跑完，但模型侧已解锁——防挂死是目的，不是硬杀。
export class TimeoutError extends Schema.TaggedErrorClass<TimeoutError>()("ToolTimeoutError", {
  tool: Schema.String,
  ms: Schema.Number,
}) {
  override get message() {
    return (
      `The ${this.tool} tool call timed out after ${this.ms}ms. ` +
      `The underlying operation may still finish in the background if it does not honor cancellation. ` +
      `Retry with a narrower scope, or choose a different approach instead of repeating the same call.`
    )
  }
}

export type Context<M extends Metadata = Metadata> = {
  sessionID: SessionID
  messageID: MessageID
  agent: string
  abort: AbortSignal
  callID?: string
  extra?: { [key: string]: unknown }
  messages: MessageV2.WithParts[]
  metadata(input: { title?: string; metadata?: M }): Effect.Effect<void>
  ask(input: Omit<Permission.Request, "id" | "sessionID" | "tool">): Effect.Effect<void>
}

export interface ExecuteResult<M extends Metadata = Metadata> {
  title: string
  metadata: M
  output: string
  attachments?: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[]
}

export interface Def<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> {
  id: string
  description: string
  parameters: Parameters
  jsonSchema?: JSONSchema7
  // 执行预算（毫秒），策略元数据、不进模型可见 schema。只有底层操作能配合中断的
  // 工具才应声明（网络/子进程类）；纯本地快操作不需要。超时产出 TimeoutError。
  timeoutMs?: number
  execute(args: Schema.Schema.Type<Parameters>, ctx: Context): Effect.Effect<ExecuteResult<M>>
  formatValidationError?(error: unknown): string
}
export type DefWithoutID<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> = Omit<Def<Parameters, M>, "id">

export interface Info<
  Parameters extends Schema.Decoder<unknown> = Schema.Decoder<unknown>,
  M extends Metadata = Metadata,
> {
  id: string
  init: () => Effect.Effect<DefWithoutID<Parameters, M>>
}

type Init<Parameters extends Schema.Decoder<unknown>, M extends Metadata> =
  DefWithoutID<Parameters, M> | (() => Effect.Effect<DefWithoutID<Parameters, M>>)

export type InferParameters<T> =
  T extends Info<infer P, any>
    ? Schema.Schema.Type<P>
    : T extends Effect.Effect<Info<infer P, any>, any, any>
      ? Schema.Schema.Type<P>
      : never
export type InferMetadata<T> =
  T extends Info<any, infer M> ? M : T extends Effect.Effect<Info<any, infer M>, any, any> ? M : never

export type InferDef<T> =
  T extends Info<infer P, infer M>
    ? Def<P, M>
    : T extends Effect.Effect<Info<infer P, infer M>, any, any>
      ? Def<P, M>
      : never

function wrap<Parameters extends Schema.Decoder<unknown>, Result extends Metadata>(
  id: string,
  init: Init<Parameters, Result>,
  truncate: Truncate.Interface,
  agents: Agent.Interface,
) {
  return () =>
    Effect.gen(function* () {
      const toolInfo = typeof init === "function" ? { ...(yield* init()) } : { ...init }
      // Compile the parser closure once per tool init; `decodeUnknownEffect`
      // allocates a new closure per call, so hoisting avoids re-closing it for
      // every LLM tool invocation.
      const decode = Schema.decodeUnknownEffect(toolInfo.parameters)
      const execute = toolInfo.execute
      toolInfo.execute = (args, ctx) => {
        const attrs = {
          "tool.name": id,
          "session.id": ctx.sessionID,
          "message.id": ctx.messageID,
          ...(ctx.callID ? { "tool.call_id": ctx.callID } : {}),
        }
        return Effect.gen(function* () {
          const decoded = yield* decode(args).pipe(
            Effect.mapError(
              (error) =>
                new InvalidArgumentsError({
                  tool: id,
                  detail: toolInfo.formatValidationError ? toolInfo.formatValidationError(error) : String(error),
                }),
            ),
          )
          const run = execute(decoded as Schema.Schema.Type<Parameters>, ctx)
          // 260814 Red 声明了 timeoutMs 的工具在此统一拦截，超时 fail 结构化 TimeoutError
          const result = yield* toolInfo.timeoutMs
            ? run.pipe(
                Effect.timeoutOrElse({
                  duration: toolInfo.timeoutMs,
                  orElse: () => Effect.fail(new TimeoutError({ tool: id, ms: toolInfo.timeoutMs! })),
                }),
              )
            : run
          if (result.metadata.truncated !== undefined) {
            return result
          }
          const agent = yield* agents.get(ctx.agent)
          const truncated = yield* truncate.output(result.output, {}, agent)
          return {
            ...result,
            output: truncated.content,
            metadata: {
              ...result.metadata,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
          }
        }).pipe(Effect.orDie, Effect.withSpan("Tool.execute", { attributes: attrs }))
      }
      return toolInfo
    })
}

export function define<
  Parameters extends Schema.Decoder<unknown>,
  Result extends Metadata,
  R,
  ID extends string = string,
>(
  id: ID,
  init: Effect.Effect<Init<Parameters, Result>, never, R>,
): Effect.Effect<Info<Parameters, Result>, never, R | Truncate.Service | Agent.Service> & { id: ID } {
  return Object.assign(
    Effect.gen(function* () {
      const resolved = yield* init
      const truncate = yield* Truncate.Service
      const agents = yield* Agent.Service
      return { id, init: wrap(id, resolved, truncate, agents) }
    }),
    { id },
  )
}

export function init<P extends Schema.Decoder<unknown>, M extends Metadata>(
  info: Info<P, M>,
): Effect.Effect<Def<P, M>> {
  return Effect.gen(function* () {
    const init = yield* info.init()
    return {
      ...init,
      id: info.id,
    }
  })
}

/**
 * Simplified tool factory for tools that don't need custom init logic.
 * Reduces boilerplate by auto-wrapping execute with Effect.orDie via
 * the standard define() path.
 * // 260606 Red Use as Effect.Effect cast to preserve generic Params type
 * through define(); without it TypeScript narrows Params to Decoder<unknown>
 *
 * Usage:
 * ```ts
 * export const MyTool = Tool.build({
 *   id: "my_tool",
 *   description: DESCRIPTION,
 *   parameters: Schema.Struct({ ... }),
 *   execute: (params, ctx) =>
 *     Effect.gen(function* () {
 *       // ...
 *       return { title, metadata, output }
 *     }),
 * })
 * ```
 */
export function build<Params extends Schema.Decoder<unknown>, M extends Metadata = Metadata>(config: {
  id: string
  description: string
  parameters: Params
  execute(args: Schema.Schema.Type<Params>, ctx: Context<M>): Effect.Effect<ExecuteResult<M>>
}): Effect.Effect<Info<Params, M>, never, Truncate.Service | Agent.Service> {
  return define(
    config.id,
    Effect.succeed({
      description: config.description,
      parameters: config.parameters,
      execute: config.execute,
    }) as Effect.Effect<DefWithoutID<Params, M>, never, never>,
  )
}

export * as Tool from "./tool"
