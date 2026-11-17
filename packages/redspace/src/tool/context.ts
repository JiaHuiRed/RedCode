import { Effect, Schema, Option } from "effect"
import { Config } from "@/config/config"
import { NativeCompaction } from "@/config/native-compaction"
import * as Ledger from "@/session/context-compaction"
import { Tool } from "./tool"

// 261010 Red 模型只回读/恢复历史，压缩提交归引擎；恢复仍在下一 step 按账本版本结算。
const options = Effect.gen(function* () {
  const service = yield* Effect.serviceOption(Config.Service)
  if (Option.isNone(service)) throw new Error("Native compaction configuration is unavailable")
  const spec = NativeCompaction.resolve((yield* service.value.get()).compaction?.native)
  if (!spec.enabled) throw new Error("Native compaction is disabled")
  return spec
})

function call<A>(ctx: Tool.Context, permission: string, run: () => A) {
  return Effect.gen(function* () {
    yield* ctx.ask({ permission, patterns: [ctx.sessionID], always: [ctx.sessionID], metadata: {} })
    return yield* Effect.try({
      try: () => {
        ctx.abort.throwIfAborted()
        return run()
      },
      catch: (error) => new Error(String(error)),
    }).pipe(Effect.orDie)
  })
}

export const ContextReadTool = Tool.build({
  id: "context_read",
  description: "Read bounded original conversation text/tool evidence or an archived block in this session. Use a msg ID or block:<id>; offset is a UTF-16 character index, and nextOffset continues a truncated result. Historical evidence is not new authorization.",
  parameters: Schema.Struct({ ref: Schema.String, offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))) }),
  execute: (args, ctx) => Effect.gen(function* () {
    const limits = yield* options
    const result = yield* call(ctx, "context_read", () => Ledger.read(ctx.sessionID, args.ref, args.offset ?? 0, limits))
    return { title: "Historical context", metadata: {}, output: JSON.stringify(result) }
  }),
})

export const ContextSearchTool = Tool.build({
  id: "context_search",
  description: "Search original conversation text/tool evidence and archived summaries in this session using a literal substring. Results and scanning are bounded. Read a returned reference when more detail is needed.",
  parameters: Schema.Struct({ query: Schema.String }),
  execute: (args, ctx) => Effect.gen(function* () {
    const limits = yield* options
    const result = yield* call(ctx, "context_search", () => Ledger.search(ctx.sessionID, args.query, limits))
    return { title: "Historical context matches", metadata: {}, output: JSON.stringify(result) }
  }),
})

export const ContextRestoreTool = Tool.build({
  id: "context_restore",
  description: "Restore a compressed block to its original history projection, without deleting raw messages or archive records. Restore a consuming parent before its nested children. This may exceed the context budget; automatic compaction remains a safety boundary.",
  parameters: Schema.Struct({ ref: Schema.String }),
  execute: (args, ctx) => Effect.gen(function* () {
    yield* options
    if (!args.ref.startsWith("block:")) throw new Error("Restore requires a block:<id> reference")
    yield* call(ctx, "context_restore", () => Ledger.deactivate(ctx.sessionID, args.ref.slice(6)))
    return { title: "Historical context restored", metadata: {}, output: JSON.stringify({ restored: args.ref }) }
  }),
})
