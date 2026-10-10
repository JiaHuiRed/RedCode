import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { Session } from "../../src/session/session"
import type { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import { Config } from "../../src/config/config"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool/truncate"
import { Tool } from "../../src/tool/tool"
import { CompressTool, ContextReadTool, ContextRestoreTool } from "../../src/tool/context"
import * as Ledger from "../../src/session/context-compaction"

const it = testEffect(Layer.mergeAll(
  Session.defaultLayer, CrossSpawnSpawner.defaultLayer, Agent.defaultLayer, Truncate.defaultLayer, Config.defaultLayer,
))

it.instance("native tools commit, retrieve and restore with scoped permissions", () => Effect.gen(function* () {
  const session = yield* Session.Service
  const info = yield* session.create({})
  const user = yield* session.updateMessage({
    id: MessageID.ascending(), sessionID: info.id, role: "user", time: { created: 1 },
    agent: "build", model: { providerID: "openai", modelID: "gpt-6.1-sol" } as MessageV2.User["model"],
  } as MessageV2.User)
  yield* session.updatePart({
    id: PartID.ascending(), sessionID: info.id, messageID: user.id, type: "text", text: "Never push.",
  })
  const assistant = yield* session.updateMessage({
    id: MessageID.ascending(), sessionID: info.id, role: "assistant" as const,
    parentID: user.id, time: { created: 2, completed: 3 }, agent: "build", mode: "build",
    modelID: "gpt-6.1-sol", providerID: "openai", path: { cwd: "/", root: "/" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop",
  } as MessageV2.Assistant)
  yield* session.updatePart({
    id: PartID.ascending(), sessionID: info.id, messageID: assistant.id, type: "text",
    text: "Verified implementation evidence. ".repeat(500),
  })
  const current = { ...user, id: MessageID.ascending(), time: { created: 4 } }
  yield* session.updateMessage(current)
  yield* session.updatePart({
    id: PartID.ascending(), sessionID: info.id, messageID: current.id, type: "text", text: "Continue.",
  })
  const messages = yield* session.messages({ sessionID: info.id })
  const permissions: string[] = []
  const ctx: Tool.Context = {
    sessionID: info.id, messageID: assistant.id, agent: "build", callID: "compress-one",
    abort: new AbortController().signal, messages,
    metadata: () => Effect.void,
    ask: (request) => Effect.sync(() => { permissions.push(request.permission) }),
  }
  const config = yield* Config.Service
  const compress = yield* Tool.init(yield* CompressTool)
  const read = yield* Tool.init(yield* ContextReadTool)
  const restore = yield* Tool.init(yield* ContextRestoreTool)
  yield* Effect.gen(function* () {
    const result = yield* compress.execute({
      content: [{ startId: user.id, endId: assistant.id, summary: "Implementation verified." }],
    }, ctx)
    expect(result.metadata.nativeCompression.netSavingsEstimated).toBeGreaterThan(0)
    const block = Ledger.list(info.id)[0]!
    const original = yield* read.execute({ ref: assistant.id }, ctx)
    expect(original.output).toContain("Verified implementation evidence")
    yield* restore.execute({ ref: `block:${block.id}` }, ctx)
    expect(Ledger.list(info.id)).toHaveLength(0)
    expect(permissions).toEqual(["compress", "context_read", "context_restore"])
  }).pipe(Effect.provideService(Config.Service, {
    ...config, get: () => Effect.succeed({ compaction: { native: { enabled: true } } }),
  }))
}))
