import { describe, expect } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { Companion } from "@/companion/companion"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Session } from "@/session/session"
import type { SessionID } from "@/session/schema"
import { SessionShare } from "@/share/session"
import { ShareNext } from "@/share/share-next"
import { Soul } from "@/soul"
import { SyncEvent } from "@/sync"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Session.defaultLayer, Companion.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("Chat automatic sharing", () => {
  it.live("share:auto never publishes Chat or child sessions while Code retains automatic sharing", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true, config: { share: "auto" } })
      const source = path.join(directory, "archive")
      yield* Effect.promise(() => Bun.write(path.join(source, "workspace", "SOUL.md"), "# Mira\nA familiar companion."))
      const published: SessionID[] = []
      const share = SessionShare.layer.pipe(
        Layer.provide(Config.defaultLayer),
        Layer.provide(SyncEvent.defaultLayer),
        Layer.provide(RuntimeFlags.layer({ autoShare: false })),
        Layer.provide(
          Layer.mock(ShareNext.Service, {
            create: (sessionID) =>
              Effect.sync(() => {
                published.push(sessionID)
                return { id: `share-${sessionID}`, url: `https://share.test/${sessionID}`, secret: "test-secret" }
              }),
          }),
        ),
      )
      yield* Effect.gen(function* () {
        const archive = yield* Companion.Service
        const imported = yield* archive.importArchive({ source, id: "mira", name: "Mira" })
        const sharing = yield* SessionShare.Service
        const sessions = yield* Session.Service
        const chat = yield* sharing
          .create({ mode: "chat", companionID: imported.profile.id })
          .pipe(provideInstance(imported.profile.directory))
        const child = yield* sharing.create({ parentID: chat.id }).pipe(provideInstance(imported.profile.directory))
        const code = yield* sharing.create({ mode: "code" }).pipe(provideInstance(directory))
        const codeChild = yield* sharing.create({ parentID: code.id }).pipe(provideInstance(directory))
        yield* pollWithTimeout(
          sessions.get(code.id).pipe(Effect.map((session) => session.share?.url)),
          "Code session was not automatically shared",
        )
        expect(published).toEqual([code.id])
        expect((yield* sessions.get(chat.id)).share).toBeUndefined()
        expect((yield* sessions.get(child.id)).share).toBeUndefined()
        expect((yield* sessions.get(codeChild.id)).share).toBeUndefined()
        expect((yield* sessions.get(code.id)).share?.url).toBe(`https://share.test/${code.id}`)
        yield* sessions.remove(chat.id).pipe(provideInstance(imported.profile.directory))
        yield* sessions.remove(code.id).pipe(provideInstance(directory))
      }).pipe(
        Effect.provide(share),
        Effect.provideService(Companion.directory, path.join(directory, "companions")),
        Effect.provideService(Soul.directory, path.join(directory, "souls")),
      )
    }),
  )
})
