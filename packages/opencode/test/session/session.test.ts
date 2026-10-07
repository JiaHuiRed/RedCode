import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import * as Log from "@redcode-ai/core/util/log"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Bus } from "@/bus"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { Database, eq } from "@/storage/db"
import { PartTable } from "@/session/session.sql"
import { Soul } from "@/soul"
import path from "node:path"
import fs from "node:fs"
import { TestInstance } from "../fixture/fixture"

void Log.init({ print: false })

const it = testEffect(
  Layer.mergeAll(
    Soul.defaultLayer,
    SessionNs.layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(Storage.defaultLayer),
      Layer.provide(SyncEvent.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
    ),
    CrossSpawnSpawner.defaultLayer,
  ),
)

const awaitDeferred = <T>(deferred: Deferred.Deferred<T>, message: string) =>
  Effect.race(
    Deferred.await(deferred),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error(message)))),
  )

const remove = (id: SessionID) => SessionNs.use.remove(id)

const subscribeGlobal = (type: string, callback: (event: NonNullable<GlobalEvent["payload"]>) => void) => {
  const listener = (event: GlobalEvent) => {
    if (event.payload?.type === type) callback(event.payload)
  }
  GlobalBus.on("event", listener)
  return () => GlobalBus.off("event", listener)
}

describe("session.created event", () => {
  it.instance("should emit session.created event when session is created", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const received = yield* Deferred.make<SessionNs.Info>()

      const unsub = subscribeGlobal(SessionNs.Event.Created.type, (event) => {
        Deferred.doneUnsafe(received, Effect.succeed(event.properties.info as SessionNs.Info))
      })
      yield* Effect.addFinalizer(() => Effect.sync(unsub))

      const info = yield* session.create({})
      const receivedInfo = yield* awaitDeferred(received, "timed out waiting for session.created")

      expect(receivedInfo.id).toBe(info.id)
      expect(receivedInfo.projectID).toBe(info.projectID)
      expect(receivedInfo.directory).toBe(info.directory)
      expect(receivedInfo.path).toBe(info.path)
      expect(receivedInfo.title).toBe(info.title)

      yield* session.remove(info.id)
    }),
  )

  it.instance("session.created event should be emitted before session.updated", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events: string[] = []
      const received = yield* Deferred.make<string[]>()
      const push = (event: string) => {
        events.push(event)
        if (events.includes("created") && events.includes("updated")) {
          Deferred.doneUnsafe(received, Effect.succeed(events))
        }
      }

      const unsubCreated = subscribeGlobal(SessionNs.Event.Created.type, () => {
        push("created")
      })
      yield* Effect.addFinalizer(() => Effect.sync(unsubCreated))

      const unsubUpdated = subscribeGlobal(SessionNs.Event.Updated.type, () => {
        push("updated")
      })
      yield* Effect.addFinalizer(() => Effect.sync(unsubUpdated))

      const info = yield* session.create({})
      const receivedEvents = yield* awaitDeferred(received, "timed out waiting for session created/updated events")

      expect(receivedEvents).toContain("created")
      expect(receivedEvents).toContain("updated")
      expect(receivedEvents.indexOf("created")).toBeLessThan(receivedEvents.indexOf("updated"))

      yield* session.remove(info.id)
    }),
  )
})

describe("session soul", () => {
  it.instance("falls back to the first valid soul when the client preference is unavailable", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const directory = test.directory
      yield* Effect.promise(async () => {
        await Bun.write(path.join(directory, "chi.md"), "---\nid: chi\nname: 赤\n---\n\n# 赤\n\nA valid soul.\n")
      })
      const session = yield* SessionNs.Service
      const created = yield* session.create({}).pipe(Effect.provideService(Soul.directory, directory))
      expect(created.soul).toBe("chi")
      yield* session.remove(created.id)
    }),
  )

  it.instance("pins an explicit soul and inherits it for child and fork sessions", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "chi.md")
      yield* Effect.promise(() => Bun.write(file, "---\nid: chi\nname: 赤\n---\n\n# 赤\n\nThird Soul.\n"))
      const session = yield* SessionNs.Service
      const parent = yield* session.create({ soul: "chi" }).pipe(Effect.provideService(Soul.directory, test.directory))
      yield* Effect.sync(() => fs.unlinkSync(file))
      const child = yield* session.create({ parentID: parent.id, soul: "yuqi" })
      const fork = yield* session.fork({ sessionID: parent.id })

      expect(parent.soul).toBe("chi")
      expect(child.soul).toBe("chi")
      expect(fork.soul).toBe("chi")

      expect((yield* session.get(parent.id)).soul).toBe("chi")
      expect((yield* session.get(child.id)).soul).toBe("chi")
      expect((yield* session.get(fork.id)).soul).toBe("chi")

      yield* session.remove(parent.id)
      yield* session.remove(child.id)
      yield* session.remove(fork.id)
    }),
  )

  it.instance("rejects an unknown root Soul before creating a session", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* SessionNs.Service
      const result = yield* Effect.exit(
        session.create({ soul: "missing" }).pipe(Effect.provideService(Soul.directory, test.directory)),
      )
      expect(result._tag).toBe("Failure")
      expect(yield* session.list()).toEqual([])
    }),
  )
})

describe("step-finish token propagation via Bus event", () => {
  it.instance(
    "non-zero tokens propagate through PartUpdated event",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const info = yield* session.create({})

        const messageID = MessageID.ascending()
        yield* session.updateMessage({
          id: messageID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as MessageV2.Info)

        // Bus subscribers receive readonly Schema.Type payloads; `MessageV2.Part`
        // is the mutable domain type. Cast bridges the two — safe because the
        // test only reads the value afterwards.
        const received = yield* Deferred.make<MessageV2.Part>()
        const unsub = subscribeGlobal(MessageV2.Event.PartUpdated.type, (event) => {
          Deferred.doneUnsafe(received, Effect.succeed(event.properties.part as MessageV2.Part))
        })
        yield* Effect.addFinalizer(() => Effect.sync(unsub))

        const tokens = {
          total: 1500,
          input: 500,
          output: 800,
          reasoning: 200,
          cache: { read: 100, write: 50, miss: 0 },
        }

        const partInput = {
          id: PartID.ascending(),
          messageID,
          sessionID: info.id,
          type: "step-finish" as const,
          reason: "stop",
          cost: 0.005,
          tokens,
        }

        yield* session.updatePart(partInput)
        const receivedPart = yield* awaitDeferred(received, "timed out waiting for message.part.updated")

        expect(receivedPart.type).toBe("step-finish")
        const finish = receivedPart as MessageV2.StepFinishPart
        expect(finish.tokens.input).toBe(500)
        expect(finish.tokens.output).toBe(800)
        expect(finish.tokens.reasoning).toBe(200)
        expect(finish.tokens.total).toBe(1500)
        expect(finish.tokens.cache.read).toBe(100)
        expect(finish.tokens.cache.write).toBe(50)
        expect(finish.cost).toBe(0.005)
        expect(receivedPart).not.toBe(partInput)

        yield* session.remove(info.id)
      }),
    { timeout: 30000 },
  )
})

describe("edit part storage", () => {
  it.instance(
    "stores an edit patch once and restores it for part readers",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const info = yield* session.create({})
        const messageID = MessageID.ascending()
        yield* session.updateMessage({
          id: messageID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as MessageV2.Info)

        const patch = "UNIQUE-PERSISTED-EDIT-PATCH"
        const part: MessageV2.ToolPart = {
          id: PartID.ascending(),
          sessionID: info.id,
          messageID,
          type: "tool",
          callID: "call_edit",
          tool: "edit",
          state: {
            status: "completed",
            input: {},
            output: "Edit applied successfully.",
            title: "file.ts",
            metadata: {
              diff: patch,
              filediff: { file: "file.ts", patch, additions: 1, deletions: 0 },
            },
            time: { start: 1, end: 2 },
          },
        }
        yield* session.updatePart(part)

        const row = Database.use((db) => db.select().from(PartTable).where(eq(PartTable.id, part.id)).get())
        expect(row).toBeDefined()
        if (!row) throw new Error("edit part was not persisted")
        expect(JSON.stringify(row.data).split(patch).length - 1).toBe(1)

        expect(yield* session.getPart({ sessionID: info.id, messageID, partID: part.id })).toEqual(part)
        expect(MessageV2.parts(messageID).find((item) => item.id === part.id)).toEqual(part)
        const page = yield* MessageV2.page({ sessionID: info.id, limit: 10 })
        expect(page.items.flatMap((item) => item.parts).find((item) => item.id === part.id)).toEqual(part)

        yield* session.remove(info.id)
      }),
    { timeout: 30000 },
  )
})

describe("Session", () => {
  it.live("remove works without an instance", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const info = yield* provideInstance(dir)(session.create({ title: "remove-without-instance" }))

      const removeExit = yield* remove(info.id).pipe(Effect.exit)
      expect(Exit.isSuccess(removeExit)).toBe(true)

      const getExit = yield* session.get(info.id).pipe(Effect.exit)
      expect(Exit.isFailure(getExit)).toBe(true)
    }),
  )
})
