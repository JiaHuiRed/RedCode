import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import type { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js"
import type { ToolExecutionOptions } from "ai"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { Provider } from "@/provider/provider"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { SessionTools } from "@/session/tools"
import { Goal } from "@/session/goal"
import { Truncate } from "@/tool/truncate"
import { ToolRegistry } from "@/tool/registry"
import type { TaskPromptOps } from "@/tool/task"
import { testEffect } from "../lib/effect"

// 261006 Red MCP resource tools 的 session 层回归。这三个工具是模型可见、带 permission、
// 可读外部二进制的入口，执行顺序（args 改写 → pre 钩子 → capability → permission →
// execute）必须逐环可证，而不是只看最终文本。

const READ = "read_mcp_resource"
const LIST = "list_mcp_resources"

type Recorder = {
  reads: string[]
  asks: (readonly string[])[]
  afterArgs: unknown[]
}

const it = testEffect(Layer.empty)

function createModel(): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: { context: 100_000, output: 32_000 },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0, miss: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { id: "test-model", npm: "@ai-sdk/anthropic" },
    options: {},
  } as unknown as Provider.Model
}

function layers(rec: Recorder, rewrite: (name: string) => Record<string, unknown> | undefined) {
  const client = { getServerCapabilities: () => ({ resources: {} }) } as unknown as MCPClient
  return Layer.mergeAll(
    Layer.mock(MCP.Service)({
      tools: () => Effect.succeed({}),
      clients: () => Effect.succeed({ A: client, B: client }),
      resources: () =>
        Effect.succeed({
          "foo://a": { uri: "foo://a", name: "a-res", client: "A" },
          "foo://b": { uri: "foo://b", name: "b-res", client: "B" },
        }),
      resourceTemplates: () => Effect.succeed({}),
      readResource: (clientName: string, resourceUri: string) => {
        rec.reads.push(`${clientName} ${resourceUri}`)
        return Effect.succeed({
          contents: [{ uri: resourceUri, mimeType: "text/plain", text: `body from ${clientName}` }],
        })
      },
    }),
    Layer.mock(Plugin.Service)({
      trigger: <Name extends string, Input, Output>(name: Name, input: Input, output: Output) => {
        const rewritten = rewrite(name)
        if (rewritten) return Effect.succeed({ ...output, args: rewritten } as Output)
        // tool.execute.after 的 input 带 { tool, sessionID, callID, args }
        if (name === "tool.execute.after") rec.afterArgs.push((input as { args: unknown }).args)
        return Effect.succeed(output)
      },
      list: () => Effect.succeed([]),
      init: () => Effect.void,
    }),
    Layer.mock(Permission.Service)({
      ask: (input: Permission.AskInput) => {
        rec.asks.push(input.patterns)
        return Effect.void
      },
    }),
    Layer.mock(Truncate.Service)({
      result: (input: { output: string; attachments?: Truncate.Attachment[] }) =>
        Effect.succeed({ output: input.output, attachments: input.attachments, metadata: { truncated: false } }),
    }),
    Layer.mock(ToolRegistry.Service)({
      tools: () => Effect.succeed([]),
    }),
  )
}

function resolveInput() {
  const sessionID = SessionID.descending()
  return {
    agent: {
      name: "build",
      mode: "primary",
      options: {},
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
      temperature: 0,
      topP: 1,
    } satisfies Agent.Info,
    model: createModel(),
    session: { id: sessionID, permission: [] } as unknown as Parameters<typeof SessionTools.resolve>[0]["session"],
    processor: {
      message: { id: MessageID.ascending() } as unknown as MessageV2.Assistant,
      updateToolCall: () => Effect.succeed(undefined),
      completeToolCall: () => Effect.void,
    },
    bypassAgentCheck: false,
    messages: [] as MessageV2.WithParts[],
    promptOps: {} as unknown as TaskPromptOps,
    goal: {} as unknown as Goal.Interface,
  }
}

function callTool(tools: Record<string, unknown>, name: string, args: unknown) {
  const execute = (tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute
  return Effect.promise(() =>
    execute(args, {
      toolCallId: "call-1",
      abortSignal: new AbortController().signal,
      messages: [],
    } as unknown as ToolExecutionOptions<Record<string, unknown>>),
  )
}

describe("session.tools mcp resource tools", () => {
  it.live(
    "read_mcp_resource executes against the hook-rewritten server and uri",
    () =>
      Effect.gen(function* () {
        const rec: Recorder = { reads: [], asks: [], afterArgs: [] }
        const tools = yield* SessionTools.resolve(resolveInput()).pipe(
          Effect.provide(layers(rec, (name) => (name === "tool.execute.before" ? { server: "B", uri: "foo://new" } : undefined))),
        )
        const output = yield* callTool(tools, READ, { server: "A", uri: "foo://old" })

        expect(rec.reads).toEqual(["B foo://new"])
        expect(rec.asks).toEqual([["mcp:B:foo://new"]])
        expect(rec.afterArgs).toEqual([{ server: "B", uri: "foo://new" }])
        expect(output).toMatchObject({ metadata: { server: "B", uri: "foo://new" }, output: expect.stringContaining("body from B") })
      }),
  )

  it.live(
    "read_mcp_resource falls through to the raw args when no plugin rewrites them",
    () =>
      Effect.gen(function* () {
        const rec: Recorder = { reads: [], asks: [], afterArgs: [] }
        const tools = yield* SessionTools.resolve(resolveInput()).pipe(Effect.provide(layers(rec, () => undefined)))
        yield* callTool(tools, READ, { server: "A", uri: "foo://old" })

        expect(rec.reads).toEqual(["A foo://old"])
        expect(rec.asks).toEqual([["mcp:A:foo://old"]])
      }),
  )

  it.live(
    "list_mcp_resources scopes permission and filtering to the rewritten server",
    () =>
      Effect.gen(function* () {
        const rec: Recorder = { reads: [], asks: [], afterArgs: [] }
        const tools = yield* SessionTools.resolve(resolveInput()).pipe(
          Effect.provide(layers(rec, (name) => (name === "tool.execute.before" ? { server: "B" } : undefined))),
        )
        const output = yield* callTool(tools, LIST, { server: "A" })

        expect(rec.asks).toEqual([["mcp:B:*"]])
        expect(output).toMatchObject({ metadata: { count: 1, server: "B" } })
        expect(JSON.stringify(output)).toContain("foo://b")
        expect(JSON.stringify(output)).not.toContain("foo://a")
      }),
  )
})
