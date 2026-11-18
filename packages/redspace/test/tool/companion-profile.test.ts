import { describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { Agent } from "@/agent/agent"
import { Companion } from "@/companion/companion"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session/session"
import { Soul } from "@/soul"
import { CompanionProfileTool, Parameters as ProfileParameters } from "@/tool/companion-profile"
import type * as Tool from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Companion.defaultLayer,
    Soul.defaultLayer,
    Session.defaultLayer,
    Agent.defaultLayer,
    Truncate.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

function setup<A, E, R>(body: (profile: Companion.Info, chat: Session.Info) => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    return yield* Effect.gen(function* () {
      const companions = yield* Companion.Service
      const created = yield* companions.create()
      return yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ mode: "chat", companionID: created.profile.id })
        yield* Effect.addFinalizer(() => sessions.remove(chat.id).pipe(Effect.orDie))
        return yield* body(created.profile, chat)
      }).pipe(provideInstance(created.profile.directory))
    }).pipe(
      Effect.provideService(Companion.directory, path.join(directory, "companions")),
      Effect.provideService(Soul.directory, path.join(directory, "souls")),
    )
  })
}

function context(chat: Session.Info, text: string, synthetic = false) {
  return Effect.gen(function* () {
    const sessions = yield* Session.Service
    const userID = MessageID.ascending()
    const messageID = MessageID.ascending()
    const model = { providerID: ProviderID.make("test"), modelID: ModelID.make("test") }
    yield* sessions.updateMessage({
      id: userID,
      sessionID: chat.id,
      role: "user",
      agent: "build",
      model,
      time: { created: Date.now() },
    })
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: chat.id,
      messageID: userID,
      type: "text",
      text,
      synthetic,
    })
    yield* sessions.updateMessage({
      id: messageID,
      sessionID: chat.id,
      role: "assistant",
      parentID: userID,
      agent: "build",
      mode: "build",
      ...model,
      path: { cwd: chat.directory, root: chat.directory },
      time: { created: Date.now() },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const requests: Array<Parameters<Tool.Context["ask"]>[0]> = []
    const ctx: Tool.Context = {
      sessionID: chat.id,
      messageID,
      agent: "build",
      abort: new AbortController().signal,
      callID: "profile-call",
      messages: [],
      metadata: () => Effect.void,
      ask: (request) =>
        Effect.sync(() => {
          requests.push(request)
        }),
    }
    return { ctx, requests, userID }
  })
}

function run(args: typeof ProfileParameters.Type, ctx: Tool.Context) {
  return Effect.gen(function* () {
    const tool = yield* CompanionProfileTool
    return yield* (yield* tool.init()).execute(args, ctx)
  })
}

describe("companion_profile", () => {
  it.live("writes only the bound profile with a real user quote and exact file permissions", () =>
    setup((profile, chat) =>
      Effect.gen(function* () {
        const companions = yield* Companion.Service
        const other = yield* companions.create()
        const soul = yield* (yield* Soul.Service).details(profile.soulID)
        const quoted = "Call yourself Luna and call me Rowan."
        const captured = yield* context(chat, quoted)
        const result = yield* run(
          { action: "update", name: "Luna", userName: "Rowan", sourceQuote: quoted },
          captured.ctx,
        )
        expect(JSON.parse(result.output)).toMatchObject({
          saved: true,
          name: "Luna",
          userName: "Rowan",
          introduction: "available",
        })
        expect(result.metadata.sourceMessageID).toBe(captured.userID)
        expect(captured.requests[0].patterns).toEqual([
          path.join(profile.directory, "..", "profile.json"),
          path.join(profile.directory, "IDENTITY.md"),
          path.join(profile.directory, "USER.md"),
        ])
        expect((yield* companions.details(other.profile.id)).userName).toBe("")
        expect(yield* (yield* Soul.Service).details(profile.soulID)).toEqual(soul)
        expect((yield* (yield* Session.Service).get(chat.id)).soulBodyHash).toBe(chat.soulBodyHash)
        const before = (yield* companions.details(profile.id)).user
        const denied = { ...captured.ctx, ask: () => Effect.die(new Error("edit denied")) }
        expect(
          Exit.isFailure(
            yield* run({ action: "update", userName: "Other", sourceQuote: quoted }, denied).pipe(Effect.exit),
          ),
        ).toBe(true)
        expect((yield* companions.details(profile.id)).user).toBe(before)
      }),
    ),
  )

  it.live("rejects invented, historical and synthetic evidence and disallows Code or child sessions", () =>
    setup((profile, chat) =>
      Effect.gen(function* () {
        const first = yield* context(chat, "An earlier statement")
        const current = yield* context(chat, "Please solve this task.")
        for (const sourceQuote of ["Invented confirmation", "An earlier statement"])
          expect(
            Exit.isFailure(
              yield* run({ action: "update", name: "Invented", sourceQuote }, current.ctx).pipe(Effect.exit),
            ),
          ).toBe(true)
        const synthetic = yield* context(chat, "Call yourself Invented.", true)
        expect(
          Exit.isFailure(
            yield* run(
              { action: "update", name: "Invented", sourceQuote: "Call yourself Invented." },
              synthetic.ctx,
            ).pipe(Effect.exit),
          ),
        ).toBe(true)
        const sessions = yield* Session.Service
        const code = yield* sessions.create({ mode: "code" })
        const child = yield* sessions.create({ parentID: chat.id })
        for (const session of [code, child])
          expect(
            Exit.isFailure(
              yield* run(
                { action: "finish", sourceQuote: "An earlier statement" },
                { ...first.ctx, sessionID: session.id },
              ).pipe(Effect.exit),
            ),
          ).toBe(true)
        expect((yield* (yield* Companion.Service).details(profile.id)).companionName).toBe("")
      }),
    ),
  )

  it.live("allows finishing with no names and never echoes large untouched managed fields", () =>
    setup((profile, chat) =>
      Effect.gen(function* () {
        const companions = yield* Companion.Service
        const sourceQuote = "We can finish getting acquainted now."
        const captured = yield* context(chat, sourceQuote)
        const finished = yield* run({ action: "finish", sourceQuote }, captured.ctx)
        expect(JSON.parse(finished.output)).toEqual({ saved: true, introduction: "complete" })
        const detail = yield* companions.details(profile.id)
        expect(detail.companionName).toBe("")
        expect(detail.userName).toBe("")
        const huge = "x".repeat(50_000)
        yield* Effect.promise(() =>
          fs.writeFile(
            detail.paths.user,
            `<!-- redspace:preferred-name -->\nPreferred name: ${huge}\n<!-- /redspace:preferred-name -->\n\nuntouched`,
          ),
        )
        const pause = yield* context(chat, "Pause the introduction.")
        const result = yield* run({ action: "pause", sourceQuote: "Pause the introduction." }, pause.ctx)
        expect(JSON.parse(result.output)).toEqual({ saved: true, introduction: "paused" })
        expect(Buffer.byteLength(result.output)).toBeLessThan(4096)
        expect((yield* companions.details(profile.id)).userName).toBe(huge)
      }),
    ),
  )
})
