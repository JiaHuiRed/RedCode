import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@redcode-ai/core/global"
import * as Log from "@redcode-ai/core/util/log"
import { Effect } from "effect"
import type { Companion } from "@/companion/companion"
import { Server } from "@/server/server"
import type { Session } from "@/session/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

void Log.init({ print: false })

const created: string[] = []
const request = Effect.fn("Test.companionRequest")(function* (url: string, directory: string, body?: unknown) {
  return yield* Effect.promise(async () =>
    Server.Default().app.request(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-redcode-directory": directory },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
})
const json = <T>(response: Response) => Effect.promise(async () => (await response.json()) as T)

const archive = Effect.fn("Test.companionArchive")(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
  )
  const id = `api-companion-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
  created.push(id)
  const source = path.join(directory.path, "archive")
  yield* Effect.promise(() =>
    Bun.write(path.join(source, "workspace", "SOUL.md"), "# Mira\nA familiar, thoughtful companion."),
  )
  yield* Effect.promise(() =>
    Bun.write(path.join(source, "workspace", "MEMORY.md"), "We made a paper lantern together."),
  )
  const response = yield* request("/companion/import", directory.path, { source, id, name: "Mira" })
  expect(response.status).toBe(200)
  const result = yield* json<Companion.ImportResult>(response)
  expect(result.imported).toBe(true)
  expect(result.profile).toMatchObject({ id, name: "Mira", soulID: id })
  return { directory: directory.path, source, profile: result.profile }
})

afterEach(async () => {
  await disposeAllInstances()
  for (const id of created.splice(0)) {
    await fs.rm(path.join(Global.Path.home, ".redcode", "companions", id), { recursive: true, force: true })
    await fs.rm(path.join(Global.Path.home, ".redcode", "souls", `${id}.md`), { force: true })
  }
  await resetDatabase()
})

describe("companion HTTP session boundary", () => {
  it.live("imports and lists an existing identity, then persists its Chat binding and Soul", () =>
    Effect.gen(function* () {
      const imported = yield* archive()
      const listed = yield* request("/companion", imported.directory)
      expect(listed.status).toBe(200)
      expect(yield* json<Companion.Info[]>(listed)).toContainEqual(imported.profile)

      const created = yield* request("/session", imported.profile.directory, {
        mode: "chat",
        companionID: imported.profile.id,
      })
      expect(created.status).toBe(200)
      const chat = yield* json<Session.Info>(created)
      expect(chat).toMatchObject({
        mode: "chat",
        companionID: imported.profile.id,
        soul: imported.profile.soulID,
        directory: imported.profile.directory,
      })
      expect(chat.soulBodyHash).toBeTruthy()

      yield* Effect.promise(disposeAllInstances)
      const restored = yield* request(`/session/${chat.id}`, imported.profile.directory)
      expect(restored.status).toBe(200)
      expect(yield* json<Session.Info>(restored)).toMatchObject({
        id: chat.id,
        mode: "chat",
        companionID: imported.profile.id,
        soul: imported.profile.soulID,
        soulBodyHash: chat.soulBodyHash,
      })
      const soul = yield* request(`/soul/${imported.profile.soulID}`, imported.profile.directory)
      expect(soul.status).toBe(200)
      expect(yield* json(soul)).toMatchObject({
        id: imported.profile.soulID,
        content: "# Mira\nA familiar, thoughtful companion.",
      })
      expect(yield* Effect.promise(() => Bun.file(path.join(imported.source, "workspace", "MEMORY.md")).text())).toBe(
        "We made a paper lantern together.",
      )
    }),
  )

  it.live("returns 400 for wrong directories, missing companions and mixed Code or Soul identities", () =>
    Effect.gen(function* () {
      const imported = yield* archive()
      expect(
        (yield* request("/session", imported.directory, {
          mode: "chat",
          companionID: imported.profile.id,
        })).status,
      ).toBe(400)
      for (const body of [
        { mode: "chat" },
        { mode: "chat", companionID: "missing-companion" },
        { mode: "code", companionID: imported.profile.id },
        { companionID: imported.profile.id },
        { mode: "chat", companionID: imported.profile.id, soul: "another-soul" },
      ]) {
        const response = yield* request("/session", imported.profile.directory, body)
        expect(response.status).toBe(400)
      }
      const sessions = yield* request(
        `/session?directory=${encodeURIComponent(imported.profile.directory)}`,
        imported.profile.directory,
      )
      expect(sessions.status).toBe(200)
      expect(yield* json<Session.Info[]>(sessions)).toEqual([])
    }),
  )

  it.live("forks preserve the Chat identity and reject a fork in another directory", () =>
    Effect.gen(function* () {
      const imported = yield* archive()
      const response = yield* request("/session", imported.profile.directory, {
        mode: "chat",
        companionID: imported.profile.id,
      })
      expect(response.status).toBe(200)
      const chat = yield* json<Session.Info>(response)
      const forked = yield* request(`/session/${chat.id}/fork`, imported.profile.directory, {})
      expect(forked.status).toBe(200)
      const fork = yield* json<Session.Info>(forked)
      expect(fork.id).not.toBe(chat.id)
      expect(fork).toMatchObject({
        mode: "chat",
        companionID: imported.profile.id,
        soul: imported.profile.soulID,
        soulBodyHash: chat.soulBodyHash,
        directory: imported.profile.directory,
      })
      expect((yield* request(`/session/${chat.id}/fork`, imported.directory, {})).status).toBe(400)
    }),
  )
})
