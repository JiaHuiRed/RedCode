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
const request = Effect.fn("Test.companionRequest")(function* (
  url: string,
  directory: string,
  body?: unknown,
  method?: string,
) {
  return yield* Effect.promise(async () =>
    Server.Default().app.request(url, {
      method: method ?? (body === undefined ? "GET" : "POST"),
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
  // 261117 Red Windows archive file handles may outlive disposed instances until GC.
  Bun.gc(true)
  for (const id of created.splice(0)) {
    await fs.rm(path.join(Global.Path.home, ".redcode", "companions", id), { recursive: true, force: true })
    await fs.rm(path.join(Global.Path.home, ".redcode", "souls", `${id}.md`), { force: true })
  }
  await resetDatabase()
})

describe("companion HTTP session boundary", () => {
  it.live("creates at most two profiles and retries a request after both places are filled", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
      )
      const first = yield* request("/companion", dir.path, { requestID: "http-first" })
      expect(first.status).toBe(200)
      const one = yield* json<Companion.InitializeResult>(first)
      created.push(one.profile.id)
      expect(one.profile.introduction).toBe("available")
      const second = yield* request("/companion", dir.path, { requestID: "http-second" })
      expect(second.status).toBe(200)
      const two = yield* json<Companion.InitializeResult>(second)
      created.push(two.profile.id)
      expect((yield* request("/companion", dir.path, { requestID: "http-third" })).status).toBe(409)
      const retry = yield* request("/companion", dir.path, { requestID: "http-first" })
      expect(yield* json(retry)).toMatchObject({ created: false, profile: { id: one.profile.id } })
      expect((yield* request("/companion", dir.path, { requestID: "bad request id" })).status).toBe(400)
      const updated = yield* request(
        `/companion/${one.profile.id}`,
        dir.path,
        { name: "Luna", userName: "Rowan", introduction: "active" },
        "PATCH",
      )
      expect(updated.status).toBe(200)
      expect(yield* json(updated)).toMatchObject({
        companionName: "Luna",
        userName: "Rowan",
        profile: { introduction: "active" },
        paths: { identity: path.join(one.profile.directory, "IDENTITY.md") },
      })
      expect(
        (yield* request(`/companion/${one.profile.id}`, dir.path, { user: "notes", userName: "name" }, "PATCH")).status,
      ).toBe(400)
      const empty = yield* request(
        `/companion/${one.profile.id}`,
        dir.path,
        { name: "", userName: "", introduction: "complete" },
        "PATCH",
      )
      expect(yield* json(empty)).toMatchObject({
        companionName: "",
        userName: "",
        profile: { name: "Chat", introduction: "complete" },
      })
      expect(yield* json(yield* request(`/companion/${two.profile.id}`, dir.path))).toMatchObject({
        companionName: "",
        userName: "",
        profile: { introduction: "available" },
      })
    }),
  )

  it.live("initializes Chat, reads and updates settings, and preserves the original Soul", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
      )
      const first = yield* request("/companion/initialize", dir.path, undefined, "POST")
      expect(first.status).toBe(200)
      const initialized = yield* json<Companion.InitializeResult>(first)
      expect(initialized.created).toBe(true)
      created.push(initialized.profile.id)
      expect(initialized.profile.needsSetup).toBe(true)
      const again = yield* request("/companion/initialize", dir.path, undefined, "POST")
      expect(yield* json(again)).toMatchObject({ created: false, profile: { id: initialized.profile.id } })
      const endpoint = `/companion/${initialized.profile.id}`
      const read = yield* request(endpoint, dir.path)
      expect(read.status).toBe(200)
      const details = yield* json<Companion.Details>(read)
      expect(details.paths.soul).toBe(path.join(Global.Path.home, ".redcode", "souls", `${initialized.profile.id}.md`))
      const originalSoul = yield* Effect.promise(() => Bun.file(details.paths.soul).text())
      const updated = yield* request(
        endpoint,
        dir.path,
        { name: "自定义伙伴", user: "# 我的资料\n\n喜欢具体的例子。\n" },
        "PATCH",
      )
      expect(updated.status).toBe(200)
      expect(yield* json(updated)).toMatchObject({
        profile: { name: "自定义伙伴", needsSetup: true, introduction: "available" },
        user: "# 我的资料\n\n喜欢具体的例子。\n",
      })
      expect(yield* Effect.promise(() => Bun.file(details.paths.soul).text())).toBe(originalSoul)
      expect((yield* request(endpoint, dir.path, { name: "bad\nname" }, "PATCH")).status).toBe(400)
      expect((yield* request("/companion/no-such-profile", dir.path)).status).toBe(404)
      expect((yield* request("/companion/no-such-profile", dir.path, {}, "PATCH")).status).toBe(404)
      const chat = yield* request("/session", initialized.profile.directory, {
        mode: "chat",
        companionID: initialized.profile.id,
      })
      expect(chat.status).toBe(200)
      expect(yield* json(chat)).toMatchObject({ mode: "chat", soul: initialized.profile.soulID })
    }),
  )

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
      expect(created.status, yield* Effect.promise(() => created.clone().text())).toBe(200)
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
      expect(response.status, yield* Effect.promise(() => response.clone().text())).toBe(200)
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
