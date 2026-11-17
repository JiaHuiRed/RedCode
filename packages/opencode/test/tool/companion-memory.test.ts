import { describe, expect } from "bun:test"
import { Cause, Clock, Effect, Exit, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import fs from "node:fs/promises"
import path from "node:path"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { Companion } from "@/companion/companion"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Permission } from "@/permission"
import { MessageID, type SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { Soul } from "@/soul"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "@/sync"
import { CompanionMemoryTool } from "@/tool/companion-memory"
import * as Tool from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Companion.defaultLayer,
    Soul.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Agent.defaultLayer,
    Truncate.defaultLayer,
    Session.layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(Storage.defaultLayer),
      Layer.provide(SyncEvent.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
    ),
  ),
)

const archive = {
  "workspace/SOUL.md": "# Mira\nA familiar companion who remembers shared experiences.\n",
  "workspace/MEMORY.md": "Our garden has a blue gate.\n",
  "workspace/USER.md": "The user calls the garden the quiet corner.\n",
  "workspace/IDENTITY.md": "Mira is the keeper of our garden diary.\n",
  "workspace/memory/2026-03-09.md": "The private garden phrase is SYNTHETIC_PRIVATE_PHRASE.\n",
  "openclaw.json": JSON.stringify({
    agents: { list: [{ id: "main", identity: { name: "Mira" } }], defaults: { userTimezone: "Pacific/Kiritimati" } },
  }),
}

function withArchive<A, E, R>(body: (profile: Companion.Info, chat: Session.Info) => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const temp = yield* tmpdirScoped()
    const source = path.join(temp, "old-home")
    yield* Effect.promise(async () => {
      for (const [relative, content] of Object.entries(archive)) {
        const file = path.join(source, relative)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, content)
      }
    })
    return yield* Effect.gen(function* () {
      const companions = yield* Companion.Service
      const { profile } = yield* companions.importArchive({ source, id: "mira" })
      return yield* Effect.gen(function* () {
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ mode: "chat", companionID: profile.id })
        return yield* body(profile, chat).pipe(Effect.ensuring(sessions.remove(chat.id).pipe(Effect.ignore)))
      }).pipe(provideInstance(profile.directory))
    }).pipe(
      Effect.provideService(Companion.directory, path.join(temp, "companions")),
      Effect.provideService(Soul.directory, path.join(temp, "souls")),
    )
  })
}

function permissions(sessionID: SessionID, rules: Permission.Ruleset = []) {
  const requests: Parameters<Tool.Context["ask"]>[0][] = []
  const ruleset: Permission.Ruleset = [{ permission: "*", pattern: "*", action: "allow" }, ...rules]
  const context: Tool.Context = {
    sessionID,
    messageID: MessageID.ascending(),
    callID: "companion-memory-test",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (request) =>
      Effect.sync(() => {
        requests.push(request)
        for (const pattern of request.patterns) {
          if (Permission.evaluate(request.permission, pattern, ruleset).action === "deny")
            throw new Permission.DeniedError({ ruleset })
        }
      }),
  }
  return { context, requests }
}

const run = Effect.fn("CompanionMemoryTest.run")(function* (
  args: Tool.InferParameters<typeof CompanionMemoryTool>,
  context: Tool.Context,
) {
  const info = yield* CompanionMemoryTool
  const tool = yield* info.init()
  return yield* tool.execute(args, context)
})

function failure<A, E>(exit: Exit.Exit<A, E>) {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isSuccess(exit)) throw new Error("Expected the memory tool to reject the operation")
  return Cause.squash(exit.cause)
}

describe("companion_memory binding and permissions", () => {
  it.live("reads the archive selected by a persisted Chat binding", () =>
    withArchive((profile, chat) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        expect((yield* sessions.get(chat.id)).companionID).toBe(profile.id)
        const captured = permissions(chat.id)
        const result = yield* run({ action: "read", path: "MEMORY.md" }, captured.context)
        expect(JSON.parse(result.output.split("\n", 1)[0]!).path).toBe("MEMORY.md")
        expect(result.output).toContain(`\n\n${archive["workspace/MEMORY.md"]}`)
        expect(result.metadata.companionID).toBe(profile.id)
        expect(captured.requests).toHaveLength(1)
        expect(captured.requests[0]?.permission).toBe("read")
        expect(captured.requests[0]?.patterns).toEqual([path.join(profile.directory, "MEMORY.md")])
      }),
    ),
  )

  it.live("honors a file-specific MEMORY.md deny even when all other reads are allowed", () =>
    withArchive((profile, chat) =>
      Effect.gen(function* () {
        const captured = permissions(chat.id, [{ permission: "read", pattern: "**/MEMORY.md", action: "deny" }])
        const exit = yield* run({ action: "read", path: "MEMORY.md" }, captured.context).pipe(Effect.exit)
        expect(failure(exit)).toBeInstanceOf(Permission.DeniedError)
        expect(captured.requests.flatMap((request) => request.patterns)).toEqual([
          path.join(profile.directory, "MEMORY.md"),
        ])
      }),
    ),
  )

  it.live("checks the exact diary date in the companion timezone before writing", () =>
    withArchive((profile, chat) =>
      Effect.gen(function* () {
        const clock = yield* TestClock.make()
        yield* clock.setTime(Date.UTC(2026, 10, 17, 12, 30))
        const diary = path.join(profile.directory, "memory", "2026-11-18.md")
        const before = "An existing diary entry.\n"
        yield* Effect.promise(() => fs.writeFile(diary, before))
        const captured = permissions(chat.id, [{ permission: "edit", pattern: diary, action: "deny" }])
        const exit = yield* run({ action: "remember", text: "This must not be saved." }, captured.context).pipe(
          Effect.provideService(Clock.Clock, clock),
          Effect.exit,
        )
        expect(failure(exit)).toBeInstanceOf(Permission.DeniedError)
        expect(captured.requests).toHaveLength(1)
        expect(captured.requests[0]?.permission).toBe("edit")
        expect(captured.requests[0]?.patterns).toEqual([diary])
        expect(yield* Effect.promise(() => fs.readFile(diary, "utf8"))).toBe(before)
        expect(
          yield* Effect.promise(() => fs.readdir(path.join(profile.directory, "..", "entries")).catch(() => [])),
        ).toEqual([])
      }),
    ),
  )

  it.live("writes only the approved diary when midnight passes during permission approval", () =>
    withArchive((profile, chat) =>
      Effect.gen(function* () {
        const clock = yield* TestClock.make()
        yield* clock.setTime(Date.UTC(2026, 10, 17, 12, 30))
        const captured = permissions(chat.id)
        const result = yield* run(
          { action: "remember", text: "We finished the garden bench." },
          {
            ...captured.context,
            ask: (request) =>
              captured.context.ask(request).pipe(Effect.andThen(clock.setTime(Date.UTC(2026, 10, 18, 12, 30)))),
          },
        ).pipe(Effect.provideService(Clock.Clock, clock))
        const saved = JSON.parse(result.output)
        expect(saved.path).toBe("memory/2026-11-18.md")
        expect(captured.requests[0]?.patterns).toEqual([path.join(profile.directory, saved.path)])
        expect(yield* Effect.promise(() => fs.readFile(path.join(profile.directory, saved.path), "utf8"))).toContain(
          "We finished the garden bench.",
        )
        expect(
          yield* Effect.promise(() => Bun.file(path.join(profile.directory, "memory", "2026-11-19.md")).exists()),
        ).toBe(false)
      }),
    ),
  )

  it.live("search checks its actual source files and returns no content when one is denied", () =>
    withArchive((profile, chat) =>
      Effect.gen(function* () {
        const companions = yield* Companion.Service
        const sources = yield* companions.sources(profile.id)
        const secret = path.join(profile.directory, "memory", "2026-03-09.md")
        const captured = permissions(chat.id, [{ permission: "read", pattern: secret, action: "deny" }])
        const exit = yield* run({ action: "search", query: "garden" }, captured.context).pipe(Effect.exit)
        expect(failure(exit)).toBeInstanceOf(Permission.DeniedError)
        const checked = captured.requests.flatMap((request) => request.patterns)
        expect(checked).toContain(secret)
        expect(
          checked.every((target) => sources.some((source) => path.join(profile.directory, source) === target)),
        ).toBe(true)
        expect(checked.some((target) => target.includes("*"))).toBe(false)
      }),
    ),
  )

  it.live("search does not read a new source introduced after its permission snapshot", () =>
    withArchive((profile, chat) =>
      Effect.gen(function* () {
        const captured = permissions(chat.id)
        const lateFile = path.join(profile.directory, "memory", "2026-11-19.md")
        const result = yield* run(
          { action: "search", query: "garden" },
          {
            ...captured.context,
            ask: (request) =>
              captured.context
                .ask(request)
                .pipe(Effect.andThen(Effect.promise(() => fs.writeFile(lateFile, "garden UNAPPROVED_LATE_SOURCE")))),
          },
        )
        expect(result.output).toContain("blue gate")
        expect(result.output).not.toContain("UNAPPROVED_LATE_SOURCE")
        expect(captured.requests.flatMap((request) => request.patterns)).not.toContain(lateFile)
      }),
    ),
  )

  it.live("rejects Code and child sessions before asking for any personal-memory permission", () =>
    withArchive((_profile, chat) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const code = yield* sessions.create({ mode: "code" })
        const child = yield* sessions.create({ parentID: chat.id })
        yield* Effect.gen(function* () {
          for (const session of [code, child]) {
            const captured = permissions(session.id)
            for (const args of [
              { action: "read" as const, path: "MEMORY.md" },
              { action: "search" as const, query: "garden" },
              { action: "remember" as const, text: "An unrelated session must not save this." },
            ]) {
              const exit = yield* run(args, captured.context).pipe(Effect.exit)
              expect(String(failure(exit))).toContain("bound main Chat session")
            }
            expect(captured.requests).toEqual([])
          }
        }).pipe(Effect.ensuring(sessions.remove(code.id).pipe(Effect.ignore)))
      }),
    ),
  )
})
