import { describe, expect } from "bun:test"
import { generateText } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { Effect, Layer, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { Provider } from "@/provider/provider"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { SessionTools } from "@/session/tools"
import { Goal } from "@/session/goal"
import { Tool } from "@/tool/tool"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import type { TaskPromptOps } from "@/tool/task"
import { testEffect } from "../lib/effect"

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
    api: { id: "test-model", npm: "@ai-sdk/openai" },
    options: {},
  } as unknown as Provider.Model
}

function resolveInput() {
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
    session: { id: SessionID.descending(), permission: [] } as unknown as Parameters<
      typeof SessionTools.resolve
    >[0]["session"],
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

describe("session.tools unknown arguments", () => {
  it.live("rejects SDK tool-call extras before the real tool executes and returns the error to the model", () =>
    Effect.gen(function* () {
      const beforeArgs: unknown[] = []
      const executions: unknown[] = []
      const definition = yield* Tool.build({
        id: "read_like",
        description: "Read a file",
        parameters: Schema.Struct({ filePath: Schema.String }),
        execute: (args) => {
          executions.push(args)
          return Effect.succeed({ title: "Read", metadata: {}, output: "file contents" })
        },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Agent.Service)({ get: () => Effect.succeed({ name: "build" } as Agent.Info) }),
            Layer.mock(Truncate.Service)({
              result: (input: { output: string }) =>
                Effect.succeed({ output: input.output, metadata: { truncated: false } }),
            }),
          ),
        ),
      )
      const item = yield* Tool.init(definition)
      const tools = yield* SessionTools.resolve(resolveInput()).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Agent.Service)({ get: () => Effect.succeed({ name: "build" } as Agent.Info) }),
            Layer.mock(Plugin.Service)({
              trigger: (name, _input, output) => {
                if (name === "tool.execute.before") beforeArgs.push((output as { args: unknown }).args)
                return Effect.succeed(output)
              },
              list: () => Effect.succeed([]),
              init: () => Effect.void,
            }),
            Layer.mock(Permission.Service)({ ask: () => Effect.void }),
            Layer.mock(MCP.Service)({
              tools: () => Effect.succeed({}),
              clients: () => Effect.succeed({}),
            }),
            Layer.mock(Truncate.Service)({
              result: (input: { output: string }) =>
                Effect.succeed({ output: input.output, metadata: { truncated: false } }),
            }),
            Layer.mock(ToolRegistry.Service)({ tools: () => Effect.succeed([item]) }),
          ),
        ),
      )

      const provider = createOpenAI({
        apiKey: "offline-fixture",
        fetch: Object.assign(
          async () =>
            new Response(
              JSON.stringify({
                id: "chatcmpl-fixture",
                object: "chat.completion",
                created: 1,
                model: "gpt-4o",
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: "call-unknown",
                          type: "function",
                          function: {
                            name: "read_like",
                            arguments: JSON.stringify({ filePath: "a.txt", content: "body" }),
                          },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
              }),
              { headers: { "Content-Type": "application/json" } },
            ),
          { preconnect: () => undefined },
        ),
      })
      const response = yield* Effect.promise(() =>
        generateText({
          model: provider.chat("gpt-4o"),
          prompt: "Read a.txt",
          tools,
          maxRetries: 0,
        }),
      )

      expect(beforeArgs).toEqual([{ filePath: "a.txt", content: "body" }])
      expect(executions).toEqual([])
      const toolMessages = response.response.messages.filter((message) => message.role === "tool")
      expect(toolMessages).toMatchObject([
        {
          role: "tool",
          content: [
            {
              toolName: "read_like",
              toolCallId: "call-unknown",
              output: {
                type: "error-text",
                value: expect.stringContaining(
                  'unknown argument(s): content. Remove the unknown arguments and call the tool again',
                ),
              },
            },
          ],
        },
      ])
    }),
  )

  it.live("executes valid SDK tool-call arguments", () =>
    Effect.gen(function* () {
      const executions: unknown[] = []
      const definition = yield* Tool.build({
        id: "read_like",
        description: "Read a file",
        parameters: Schema.Struct({ filePath: Schema.String }),
        execute: (args) => {
          executions.push(args)
          return Effect.succeed({ title: "Read", metadata: {}, output: "file contents" })
        },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Agent.Service)({ get: () => Effect.succeed({ name: "build" } as Agent.Info) }),
            Layer.mock(Truncate.Service)({
              result: (input: { output: string }) =>
                Effect.succeed({ output: input.output, metadata: { truncated: false } }),
            }),
          ),
        ),
      )
      const item = yield* Tool.init(definition)
      const tools = yield* SessionTools.resolve(resolveInput()).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Agent.Service)({ get: () => Effect.succeed({ name: "build" } as Agent.Info) }),
            Layer.mock(Plugin.Service)({
              trigger: (_name, _input, output) => Effect.succeed(output),
              list: () => Effect.succeed([]),
              init: () => Effect.void,
            }),
            Layer.mock(Permission.Service)({ ask: () => Effect.void }),
            Layer.mock(MCP.Service)({ tools: () => Effect.succeed({}), clients: () => Effect.succeed({}) }),
            Layer.mock(Truncate.Service)({
              result: (input: { output: string }) =>
                Effect.succeed({ output: input.output, metadata: { truncated: false } }),
            }),
            Layer.mock(ToolRegistry.Service)({ tools: () => Effect.succeed([item]) }),
          ),
        ),
      )
      const provider = createOpenAI({
        apiKey: "offline-fixture",
        fetch: Object.assign(
          async () =>
            new Response(
              JSON.stringify({
                id: "chatcmpl-valid",
                object: "chat.completion",
                created: 1,
                model: "gpt-4o",
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: "call-valid",
                          type: "function",
                          function: { name: "read_like", arguments: JSON.stringify({ filePath: "a.txt" }) },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
              }),
              { headers: { "Content-Type": "application/json" } },
            ),
          { preconnect: () => undefined },
        ),
      })
      yield* Effect.promise(() =>
        generateText({
          model: provider.chat("gpt-4o"),
          prompt: "Read a.txt",
          tools,
          maxRetries: 0,
        }),
      )
      expect(executions).toEqual([{ filePath: "a.txt" }])
    }),
  )
})
