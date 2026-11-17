import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { EffectFlock } from "@redcode-ai/core/util/effect-flock"
import path from "path"
import { pathToFileURL } from "url"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { Env } from "../../src/env"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { Session } from "../../src/session/session"
import { SessionTable } from "../../src/session/session.sql"
import * as Database from "../../src/storage/db"
import { eq } from "drizzle-orm"

const configLayer = Config.layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(AuthTest.empty),
  Layer.provide(AccountTest.empty),
  Layer.provide(NpmTest.noop),
  Layer.provide(FetchHttpClient.layer),
)
const it = testEffect(
  Layer.mergeAll(
    Plugin.layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(configLayer),
      Layer.provide(RuntimeFlags.layer({ disableDefaultPlugins: true })),
    ),
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
  ),
)
const systemHook = "experimental.chat.system.transform"

function withProject<A, E, R>(source: string, self: Effect.Effect<A, E, R>) {
  return provideTmpdirInstance((dir) =>
    Effect.gen(function* () {
      const file = path.join(dir, "plugin.ts")
      yield* Effect.all(
        [
          Effect.promise(() => Bun.write(file, source)),
          Effect.promise(() =>
            Bun.write(
              path.join(dir, "redcode.json"),
              JSON.stringify(
                {
                  $schema: "https://redcode.dev/config.json",
                  plugin: [pathToFileURL(file).href],
                },
                null,
                2,
              ),
            ),
          ),
        ],
        { discard: true, concurrency: 2 },
      )
      return yield* self
    }),
  )
}

const triggerSystemTransform = Effect.fn("PluginTriggerTest.triggerSystemTransform")(function* () {
  const plugin = yield* Plugin.Service
  const out = { system: [] as string[] }
  yield* plugin.trigger(
    systemHook,
    {
      model: {
        providerID: ProviderID.anthropic,
        modelID: ModelID.make("claude-sonnet-4-6"),
      },
    },
    out,
  )
  return out.system
})

describe("plugin.trigger", () => {
  it.live("limits engineering prompt hooks to Code using persisted mode, while leaving tools shared", () =>
    withProject(
      `export default async () => ({
        promptModes: ["code"],
        "experimental.chat.system.transform": (input, output) => { output.system.push("engineering:" + input.mode) },
        "experimental.chat.messages.transform": (input, output) => { output.messages.push({ info: { id: "engineering" }, parts: [] }) },
        "tool.definition": (_input, output) => { output.description = "shared tool" },
      })`,
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({})
        const code = yield* sessions.create({})
        Database.use((db) =>
          db.update(SessionTable).set({ mode: "chat", companion_id: "mira" }).where(eq(SessionTable.id, chat.id)).run(),
        )
        const model = { providerID: ProviderID.anthropic, modelID: ModelID.make("claude-sonnet-4-6") }
        const root = { system: [] as string[] }
        yield* plugin.trigger(systemHook, { sessionID: chat.id, mode: "code", model }, root)
        expect(root.system).toEqual([])
        const messages = { messages: [] }
        yield* plugin.trigger("experimental.chat.messages.transform", { sessionID: chat.id }, messages)
        expect(messages.messages).toEqual([])
        const work = { system: [] as string[] }
        yield* plugin.trigger(systemHook, { sessionID: code.id, mode: "chat", model }, work)
        expect(work.system).toEqual(["engineering:code"])
        const shared = { description: "before", parameters: {} }
        yield* plugin.trigger("tool.definition", { toolID: "example" }, shared)
        expect(shared.description).toBe("shared tool")
      }),
    ),
  )

  it.live("runs synchronous hooks without crashing", () =>
    withProject(
      [
        "export default async () => ({",
        `  ${JSON.stringify(systemHook)}: (_input, output) => {`,
        '    output.system.unshift("sync")',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toEqual(["sync"])
      }),
    ),
  )

  it.live("awaits asynchronous hooks", () =>
    withProject(
      [
        "export default async () => ({",
        `  ${JSON.stringify(systemHook)}: async (_input, output) => {`,
        "    await Bun.sleep(1)",
        '    output.system.unshift("async")',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toEqual(["async"])
      }),
    ),
  )
})
