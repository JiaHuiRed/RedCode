import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "node:path"
import fs from "node:fs/promises"
import { Companion } from "@/companion/companion"
import { Session } from "@/session/session"
import { Soul } from "@/soul"
import { Database, eq } from "@/storage/db"
import { SessionTable } from "@/session/session.sql"
import { PromptCaches } from "@/session/prompt-caches"
import { sessionSoul } from "@/session/soul"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Soul.defaultLayer,
    Companion.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(Storage.defaultLayer),
      Layer.provide(SyncEvent.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
    ),
  ),
)

function withArchive<A, E, R>(body: (profile: Companion.Info, directory: string) => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const source = path.join(directory, "archive")
    yield* Effect.promise(() =>
      Bun.write(path.join(source, "workspace", "SOUL.md"), "# Mira\nA familiar, thoughtful companion."),
    )
    yield* Effect.promise(() =>
      Bun.write(path.join(source, "workspace", "MEMORY.md"), "We built a paper lantern together."),
    )
    return yield* Effect.gen(function* () {
      const archive = yield* Companion.Service
      const imported = yield* archive.importArchive({ source, id: "mira", name: "Mira" })
      const souls = yield* Soul.Service
      yield* souls.create({ id: "coder", name: "Coder", content: "A careful coding partner." })
      return yield* body(imported.profile, directory)
    }).pipe(
      Effect.provideService(Companion.directory, path.join(directory, "companions")),
      Effect.provideService(Soul.directory, path.join(directory, "souls")),
    )
  })
}

describe("session companion binding", () => {
  it.live("excludes bound companions from both default and explicit Code selection", () =>
    withArchive((profile, directory) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const code = yield* session.create()
        expect(code.soul).toBe("coder")
        yield* Effect.promise(() => fs.unlink(path.join(directory, "souls", "coder.md")))
        const neutral = yield* session.create()
        expect(neutral.mode).toBe("code")
        expect(neutral.soul).toBeUndefined()
        expect(neutral.soulBodyHash).toBeUndefined()
        const explicit = yield* session.create({ soul: profile.soulID }).pipe(Effect.flip)
        expect(explicit._tag).toBe("InvalidSoul")
        for (const item of [code, neutral]) yield* session.remove(item.id)
      }).pipe(provideInstance(directory)),
    ),
  )

  it.live("persists Chat's archive and Soul through reads, child sessions and forks", () =>
    withArchive((profile) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const souls = yield* Soul.Service
        const chat = yield* session.create({ mode: "chat", companionID: profile.id })
        expect(chat.mode).toBe("chat")
        expect(chat.companionID).toBe(profile.id)
        expect(chat.soul).toBe(profile.soulID)
        expect(chat.soulBodyHash).toBeTruthy()
        const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, chat.id)).get())
        expect(row?.mode).toBe("chat")
        expect(row?.companion_id).toBe(profile.id)
        expect((yield* session.get(chat.id)).companionID).toBe(profile.id)

        PromptCaches.souls.delete(chat.id)
        const restored = yield* sessionSoul(chat.id, "coder", souls)
        expect(restored.id).toBe(profile.soulID)
        expect(restored.prompt).toContain("A familiar, thoughtful companion.")

        const child = yield* session.create({ parentID: chat.id })
        const fork = yield* session.fork({ sessionID: chat.id })
        for (const related of [child, fork]) {
          expect(related.mode).toBe("chat")
          expect(related.companionID).toBe(profile.id)
          expect(related.soulBodyHash).toBe(chat.soulBodyHash)
        }
        expect(child.parentID).toBe(chat.id)
        expect(fork.parentID).toBeUndefined()
        yield* session.remove(chat.id)
        yield* session.remove(fork.id)
        PromptCaches.souls.delete(chat.id)
      }).pipe(provideInstance(profile.directory)),
    ),
  )

  it.live("keeps Code's selected Soul and stores no companion binding", () =>
    withArchive((_profile, directory) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const code = yield* session.create({ soul: "coder" })
        expect(code.mode).toBe("code")
        expect(code.soul).toBe("coder")
        expect(code.companionID).toBeUndefined()
        const fork = yield* session.fork({ sessionID: code.id })
        expect(fork.mode).toBe("code")
        expect(fork.companionID).toBeUndefined()
        expect(fork.soul).toBe(code.soul)
        yield* session.remove(code.id)
        yield* session.remove(fork.id)
      }).pipe(provideInstance(directory)),
    ),
  )

  it.live("rejects missing or mixed identities before publishing a session", () =>
    withArchive((profile) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const before = (yield* session.list()).length
        for (const input of [
          { mode: "chat" as const },
          { mode: "chat" as const, companionID: "unknown" },
          { mode: "chat" as const, companionID: profile.id, soul: "coder" },
          { mode: "code" as const, companionID: profile.id },
          { companionID: profile.id },
        ]) {
          expect((yield* session.create(input).pipe(Effect.flip))._tag).toBe("InvalidCompanion")
        }
        expect((yield* session.list()).length).toBe(before)
      }).pipe(provideInstance(profile.directory)),
    ),
  )

  it.live("requires the companion workspace and rejects identity changes on child creation", () =>
    withArchive((profile, directory) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const wrongDirectory = yield* session
          .create({ mode: "chat", companionID: profile.id })
          .pipe(Effect.flip, provideInstance(directory))
        expect(wrongDirectory._tag).toBe("InvalidCompanion")
        const chat = yield* session
          .create({ mode: "chat", companionID: profile.id })
          .pipe(provideInstance(profile.directory))
        for (const input of [
          { parentID: chat.id, mode: "code" as const },
          { parentID: chat.id, companionID: "another" },
          { parentID: chat.id, soul: "coder" },
        ]) {
          expect((yield* session.create(input).pipe(Effect.flip, provideInstance(profile.directory)))._tag).toBe(
            "InvalidCompanion",
          )
        }
        expect((yield* session.fork({ sessionID: chat.id }).pipe(Effect.flip, provideInstance(directory)))._tag).toBe(
          "InvalidCompanion",
        )
        yield* session.remove(chat.id).pipe(provideInstance(profile.directory))
      }),
    ),
  )
})
