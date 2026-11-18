import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Global } from "@redcode-ai/core/global"
import * as Log from "@redcode-ai/core/util/log"
import { Effect } from "effect"
import { Server } from "../../src/server/server"
import { MAX_SOUL_BYTES } from "../../src/soul/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"

void Log.init({ print: false })

const app = () => Server.Default().app
const soulDirectory = () => path.join(Global.Path.home, ".redcode", "souls")
const created: string[] = []
const id = () => `api-soul-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`

const json = (response: Response) => Effect.promise(() => response.json())

// async 包装把 Bun 的 `Response | Promise<Response>` 归一成 Promise；Effect.promise 只接受 PromiseLike。
const post = (body: unknown, directory: string) =>
  Effect.promise(async () =>
    app().request("/soul", {
      method: "POST",
      headers: { "content-type": "application/json", "x-redcode-directory": directory },
      body: JSON.stringify(body),
    }),
  )

const put = (soulID: string, body: unknown, directory: string) =>
  Effect.promise(async () =>
    app().request(`/soul/${soulID}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-redcode-directory": directory },
      body: JSON.stringify(body),
    }),
  )

const tmp = () =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (value) => Effect.promise(() => value[Symbol.asyncDispose]()),
  )

afterEach(async () => {
  while (created.length) fs.rmSync(created.pop()!, { force: true })
  await disposeAllInstances()
  await resetDatabase()
})

describe("POST /soul", () => {
  it.live("updates the registered file, preserves metadata and keeps existing session snapshots", () =>
    Effect.gen(function* () {
      const dir = yield* tmp()
      const soulID = id()
      const alias = path.join(soulDirectory(), `named-${soulID}.md`)
      created.push(alias)
      yield* Effect.promise(async () => {
        await fs.promises.mkdir(soulDirectory(), { recursive: true })
        await Bun.write(alias, `---\nid: ${soulID}\nname: Original\navatar: existing-avatar\n---\n\nOriginal body\n`)
        await fs.promises.chmod(alias, 0o600)
      })
      const createSession = () =>
        Effect.promise(async () => {
          const response = await app().request("/session", {
            method: "POST",
            headers: { "content-type": "application/json", "x-redcode-directory": dir.path },
            body: JSON.stringify({ soul: soulID }),
          })
          expect(response.status).toBe(200)
          return response.json() as Promise<{ id: string; soulBodyHash: string }>
        })
      const oldSession = yield* createSession()
      const response = yield* put(soulID, { content: "Edited body", displayName: "Updated" }, dir.path)
      expect(response.status).toBe(200)
      expect(yield* json(response)).toMatchObject({
        id: soulID,
        name: "Original",
        avatar: "existing-avatar",
        content: "Edited body",
        path: alias,
      })
      expect(fs.existsSync(path.join(soulDirectory(), `${soulID}.md`))).toBe(false)
      if (process.platform !== "win32") expect(fs.statSync(alias).mode & 0o777).toBe(0o600)
      const newSession = yield* createSession()
      expect(newSession.soulBodyHash).not.toBe(oldSession.soulBodyHash)
      const oldResponse = yield* Effect.promise(async () =>
        app().request(`/session/${oldSession.id}`, { headers: { "x-redcode-directory": dir.path } }),
      )
      expect(yield* json(oldResponse)).toMatchObject({ soulBodyHash: oldSession.soulBodyHash })
      const before = yield* Effect.promise(() => Bun.file(alias).text())
      expect(
        (yield* put(soulID, { markdown: "---\nid: changed\nname: Changed\n---\n\nWrong identity\n" }, dir.path)).status,
      ).toBe(400)
      expect((yield* put(soulID, { content: "" }, dir.path)).status).toBe(400)
      expect((yield* put(soulID, { content: "x".repeat(MAX_SOUL_BYTES) }, dir.path)).status).toBe(400)
      expect((yield* put(soulID, { content: "mixed", markdown: "mixed" }, dir.path)).status).toBe(400)
      expect(yield* Effect.promise(() => Bun.file(alias).text())).toBe(before)
      expect((yield* put("does-not-exist", { content: "body" }, dir.path)).status).toBe(404)
    }),
  )

  it.live("creates a structured Soul and reads it back through soul.get", () =>
    Effect.gen(function* () {
      const dir = yield* tmp()
      const soulID = id()
      const file = path.join(soulDirectory(), `${soulID}.md`)
      created.push(file)

      const response = yield* post(
        {
          id: soulID,
          name: "API: Soul #1",
          displayName: 'Quoted "Name"',
          description: "created by test",
          content: "# Body\n\nHello",
        },
        dir.path,
      )

      expect(response.status).toBe(200)
      expect(yield* json(response)).toMatchObject({
        id: soulID,
        name: "API: Soul #1",
        displayName: 'Quoted "Name"',
        description: "created by test",
      })
      const raw = yield* Effect.promise(() => Bun.file(file).text())
      expect(raw).toContain(`id: "${soulID}"`)
      expect(raw).toContain('name: "API: Soul #1"')

      const details = yield* Effect.promise(async () =>
        app().request(`/soul/${soulID}`, { headers: { "x-redcode-directory": dir.path } }),
      )
      expect(details.status).toBe(200)
      expect(yield* json(details)).toMatchObject({ id: soulID, content: "# Body\n\nHello" })
    }),
  )

  it.live("returns 409 and preserves the original file for a duplicate id", () =>
    Effect.gen(function* () {
      const dir = yield* tmp()
      const soulID = id()
      const file = path.join(soulDirectory(), `${soulID}.md`)
      created.push(file)
      const body = { id: soulID, name: "Original", content: "original body" }

      expect((yield* post(body, dir.path)).status).toBe(200)
      const before = yield* Effect.promise(() => Bun.file(file).text())

      const duplicate = yield* post({ ...body, name: "Replacement", content: "replacement body" }, dir.path)
      expect(duplicate.status).toBe(409)
      expect(JSON.stringify(yield* json(duplicate))).toContain("already exists")
      expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(before)
    }),
  )

  it.live("returns 409 when the id is registered under another filename", () =>
    Effect.gen(function* () {
      const dir = yield* tmp()
      const soulID = id()
      const alias = path.join(soulDirectory(), `alias-${soulID}.md`)
      created.push(alias)
      yield* Effect.promise(async () => {
        await fs.promises.mkdir(soulDirectory(), { recursive: true })
        await Bun.write(alias, `---\nid: ${soulID}\nname: Alias\n---\n\nbody\n`)
      })

      const response = yield* post({ id: soulID, name: "Other", content: "body" }, dir.path)
      expect(response.status).toBe(409)
      expect(fs.existsSync(path.join(soulDirectory(), `${soulID}.md`))).toBe(false)
    }),
  )

  it.live("rejects invalid and mixed payloads with 400", () =>
    Effect.gen(function* () {
      const dir = yield* tmp()
      const body = { id: id(), name: "Valid", content: "body" }
      const cases = [
        { id: "Bad ID", name: "X", content: "body" },
        { ...body, content: "  " },
        { ...body, description: "你".repeat(86) },
        { ...body, markdown: "---\nid: other\nname: Other\n---\n\nbody\n" },
        { name: "X" },
      ]

      for (const payload of cases) expect((yield* post(payload, dir.path)).status).toBe(400)
    }),
  )

  it.live("accepts a pasted Markdown document verbatim and refuses a duplicate", () =>
    Effect.gen(function* () {
      const dir = yield* tmp()
      const soulID = id()
      const file = path.join(soulDirectory(), `${soulID}.md`)
      created.push(file)
      const markdown = `---\nid: "${soulID}"\nname: "Pasted: Soul #1"\ncommit_prefix: "Pasted"\ndescription: "a: b # c"\n---\n\n# Pasted\n\nBody: with colon\n`

      const response = yield* post({ markdown }, dir.path)
      expect(response.status).toBe(200)
      expect(yield* json(response)).toMatchObject({
        id: soulID,
        name: "Pasted: Soul #1",
        commitPrefix: "Pasted",
        description: "a: b # c",
      })
      expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(markdown)

      expect((yield* post({ markdown }, dir.path)).status).toBe(409)
    }),
  )

  it.live("rejects Markdown the registry cannot parse with 400", () =>
    Effect.gen(function* () {
      const dir = yield* tmp()
      const cases = [
        "# Just body\n",
        "---\nid: Bad ID\nname: Bad\n---\n\nbody\n",
        "---\nid: unknown\nname: Unknown\nextra: value\n---\n\nbody\n",
        "x".repeat(MAX_SOUL_BYTES + 1),
      ]

      for (const markdown of cases) expect((yield* post({ markdown }, dir.path)).status).toBe(400)
    }),
  )
})
