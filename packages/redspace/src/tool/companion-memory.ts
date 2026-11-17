import { Clock, Effect, Schema } from "effect"
import path from "node:path"
import { Companion } from "@/companion/companion"
import { Session } from "@/session/session"
import * as Tool from "./tool"
import DESCRIPTION from "./companion-memory.md" with { type: "text" }

export const Parameters = Schema.Struct({
  action: Schema.Literals(["search", "read", "remember"]),
  query: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))),
  cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
  path: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))),
  text: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8192))),
  offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  byteOffset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
})

export const CompanionMemoryTool = Tool.define(
  "companion_memory",
  Effect.gen(function* () {
    const companions = yield* Companion.Service
    const sessions = yield* Session.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: typeof Parameters.Type, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const session = yield* sessions.get(ctx.sessionID)
          if (session.mode !== "chat" || !session.companionID || session.parentID)
            throw new Error("Personal memory is available only in its bound main Chat session")
          const profile = yield* companions.get(session.companionID)
          if (!profile) throw new Error("The bound companion archive is unavailable")
          if (args.action === "search" && !args.query?.trim()) throw new Error("search requires query")
          if (args.action === "read" && !args.path) throw new Error("read requires path")
          if (args.action === "remember" && !args.text?.trim()) throw new Error("remember requires text")

          const now = yield* Clock.currentTimeMillis
          const paths =
            args.action === "search"
              ? yield* companions.sources(profile.id)
              : [args.action === "read" ? args.path! : Companion.diaryPath(profile.timezone, now)]
          const targets = paths.map((file) => path.resolve(profile.directory, file))
          yield* ctx.ask({
            permission: args.action === "remember" ? "edit" : "read",
            patterns: targets,
            always: targets,
            metadata: { action: args.action, companionID: profile.id },
          })
          const result =
            args.action === "search"
              ? yield* companions.search({
                  id: profile.id,
                  query: args.query!,
                  limit: Math.min(args.limit ?? 5, 10),
                  paths,
                  cursor: args.cursor,
                })
              : args.action === "read"
                ? yield* companions.read({
                    id: profile.id,
                    path: args.path!,
                    offset: args.offset,
                    byteOffset: args.byteOffset,
                    limit: args.limit,
                  })
                : yield* companions.remember({
                    id: profile.id,
                    text: args.text!,
                    time: now,
                    source: `session:${ctx.sessionID}/message:${ctx.messageID}`,
                    idempotencyKey: ctx.callID ? `tool:${ctx.sessionID}:${ctx.callID}` : undefined,
                  })
          const output =
            "text" in result
              ? `${JSON.stringify({
                  path: result.path,
                  startLine: result.startLine,
                  endLine: result.endLine,
                  totalLines: result.totalLines,
                  byteOffset: result.byteOffset,
                  nextByteOffset: result.nextByteOffset,
                  truncated: result.truncated,
                })}\n\n${result.text}`
              : JSON.stringify(result)
          return {
            title: args.action === "remember" ? "Memory saved" : "Companion memory",
            metadata: { action: args.action, companionID: profile.id },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
