import { Effect, Schema } from "effect"
import path from "node:path"
import { Companion } from "@/companion/companion"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session/session"
import * as Tool from "./tool"
import DESCRIPTION from "./companion-profile.md" with { type: "text" }

export const Parameters = Schema.Struct({
  action: Schema.Literals(["update", "pause", "finish"]),
  name: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  userName: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  sourceQuote: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
})

export const CompanionProfileTool = Tool.define(
  "companion_profile",
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
            throw new Error("Companion profiles are available only in their bound main Chat session")
          if (args.action === "update" && args.name === undefined && args.userName === undefined)
            throw new Error("update requires name or userName")
          if (args.action !== "update" && (args.name !== undefined || args.userName !== undefined))
            throw new Error("pause and finish cannot change names")
          if (!args.sourceQuote.trim() || Buffer.byteLength(args.sourceQuote, "utf8") > 1024)
            throw new Error("sourceQuote must be a non-empty user quote of at most 1024 UTF-8 bytes")

          // Read the persisted trigger, not transformed context, retrieved history or a later queued message.
          const assistant = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
          if (assistant.info.role !== "assistant") throw new Error("The current assistant response is unavailable")
          const user = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: assistant.info.parentID })
          if (
            user.info.role !== "user" ||
            !user.parts.some(
              (part) =>
                part.type === "text" && !part.synthetic && !part.ignored && part.text.includes(args.sourceQuote),
            )
          )
            throw new Error("sourceQuote must come from the real user message that prompted this response")

          const profile = yield* companions.get(session.companionID)
          if (!profile) throw new Error("The bound companion is unavailable")
          const targets = [path.join(profile.directory, "..", "profile.json")]
          if (args.name !== undefined) targets.push(path.join(profile.directory, "IDENTITY.md"))
          if (args.userName !== undefined) targets.push(path.join(profile.directory, "USER.md"))
          yield* ctx.ask({
            permission: "edit",
            patterns: targets,
            always: targets,
            metadata: { action: args.action, companionID: profile.id, sourceMessageID: user.info.id },
          })
          const saved = yield* companions.update(
            profile.id,
            args.action === "update"
              ? {
                  ...(args.name === undefined ? {} : { name: args.name }),
                  ...(args.userName === undefined ? {} : { userName: args.userName }),
                }
              : { introduction: args.action === "pause" ? "paused" : "complete" },
          )
          const output = JSON.stringify({
            saved: true,
            ...(args.action === "update" && args.name !== undefined ? { name: args.name.trim() } : {}),
            ...(args.action === "update" && args.userName !== undefined ? { userName: args.userName.trim() } : {}),
            introduction: Companion.introductionOf(saved.profile),
          })
          return {
            title: "Companion profile saved",
            metadata: { action: args.action, companionID: profile.id, sourceMessageID: user.info.id },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
