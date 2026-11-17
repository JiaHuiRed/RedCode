import { Effect, Layer } from "effect"
import path from "node:path"

// 261008 Red 独立进程只用调用方提供的临时 home/文件库，不能继承 live 路径。
const [mode, root, sessionID] = process.argv.slice(2)
if (!root || (mode !== "create" && mode !== "read")) throw new Error("expected create/read and temporary root")
if (process.env.REDCODE_DB !== path.join(root, "sessions.db") || process.env.REDCODE_TEST_HOME !== path.join(root, "home"))
  throw new Error("restart fixture requires an isolated database and home")

const { Session } = await import("../../src/session/session")
const { Soul } = await import("../../src/soul")
const { sessionSoul } = await import("../../src/session/soul")
const { Database } = await import("../../src/storage/db")
const { initProjectors } = await import("../../src/server/projectors")
const { Bus } = await import("../../src/bus")
const { Storage } = await import("../../src/storage/storage")
const { SyncEvent } = await import("../../src/sync")
const { RuntimeFlags } = await import("../../src/effect/runtime-flags")
const { BackgroundJob } = await import("../../src/background/job")
const { CrossSpawnSpawner } = await import("@redcode-ai/core/cross-spawn-spawner")
const { provideTestInstance } = await import("./fixture")
const { SessionID } = await import("../../src/session/schema")
const { InstanceRef } = await import("../../src/effect/instance-ref")

initProjectors()
const layer = Layer.mergeAll(
  Session.layer.pipe(
    Layer.provide(Bus.layer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(SyncEvent.defaultLayer),
    Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false, client: "tui" })),
    Layer.provide(BackgroundJob.defaultLayer),
  ),
  CrossSpawnSpawner.defaultLayer,
  Soul.defaultLayer,
)

try {
  const result = await provideTestInstance({
    directory: path.join(root, "workspace"),
    fn: (ctx) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const souls = yield* Soul.Service
          if (mode === "create") {
            const session = yield* sessions.create({ soul: "restart-persona" })
            // 创建进程不读 prompt：冻结必须发生在创建时，而非首次请求时。
            return { id: session.id, pid: process.pid }
          }
          if (!sessionID) return yield* Effect.die(new Error("read requires a session id"))
          const original = yield* sessions.get(SessionID.make(sessionID))
          const snapshot = yield* sessionSoul(original.id, original.soul, souls)
          const fork = yield* sessions.fork({ sessionID: original.id })
          const child = yield* sessions.create({ parentID: original.id })
          const current = original.soul ? yield* souls.get(original.soul) : undefined
          const newSession = current ? yield* sessions.create({ soul: current.id }) : undefined
          return {
            pid: process.pid,
            prompt: snapshot.prompt,
            forkPrompt: (yield* sessionSoul(fork.id, fork.soul, souls)).prompt,
            childPrompt: (yield* sessionSoul(child.id, child.soul, souls)).prompt,
            newPrompt: newSession ? (yield* sessionSoul(newSession.id, newSession.soul, souls)).prompt : undefined,
          }
        }).pipe(
          Effect.provide(layer),
          Effect.provideService(Soul.directory, path.join(root, "souls")),
          Effect.provideService(InstanceRef, ctx),
        ),
      ),
  })
  process.stdout.write(JSON.stringify(result))
} finally {
  Database.close()
}
