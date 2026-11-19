import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { generateText, type ModelMessage } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import type { Auth } from "@/auth"
import type { Agent } from "../../src/agent/agent"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { LLMRequestPrep } from "@/session/llm/request"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, SessionID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { Plugin } from "@/plugin"

// 261119 Red GPT-6.2 instructions developer 前缀试验的发送形状。
// 决策与 A/B 判据：docs/notes/proposed/feature/2026-11-19-instructions-developer-prefix.md

function testModel(apiId: string): Provider.Model {
  return {
    id: apiId,
    providerID: "openai",
    name: apiId,
    api: { id: apiId, npm: "@ai-sdk/openai", url: "https://chatgpt.com/backend-api/codex" },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, image: true, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 400_000, output: 128_000 },
    options: {},
    headers: {},
    variants: {},
  } as unknown as Provider.Model
}

const passthroughPlugin = {
  trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
} as unknown as Plugin.Interface

// 模拟插件往 system 追加块：返回对象的 system 数组被就地追加
const sessionID = SessionID.make("ses_instructions_developer")

function input(options: {
  apiId?: string
  authType?: "oauth" | "api"
  flag?: boolean
  messages?: ModelMessage[]
  plugin?: Plugin.Interface
}) {
  const model = testModel(options.apiId ?? "gpt-6.2-sol")
  const agent = {
    name: "test",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  } satisfies Agent.Info
  return {
    user: {
      id: MessageID.make("msg_instructions_developer"),
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: agent.name,
      model: { providerID: ProviderID.make("openai"), modelID: ModelID.make(model.id) },
    } satisfies MessageV2.User,
    sessionID,
    model,
    agent,
    permission: [],
    system: ["BASE INSTRUCTIONS", "EXTRA INSTRUCTIONS"],
    messages: options.messages ?? [{ role: "user", content: "Hello" }],
    tools: {},
    provider: { id: "openai", options: {} } as unknown as Provider.Info,
    auth: { type: options.authType ?? "oauth" } as unknown as Auth.Info,
    plugin: options.plugin ?? passthroughPlugin,
    flags: { experimentalInstructionsDeveloper: options.flag ?? false } as RuntimeFlags.Info,
    isWorkflow: false,
  }
}

const run = (value: ReturnType<typeof input>) => Effect.runPromise(LLMRequestPrep.prepare(value))

describe("session.llm.request developer instructions", () => {
  test("keeps top-level instructions when the flag is off", async () => {
    const prepared = await run(input({}))

    expect(prepared.params.options.instructions).toContain("BASE INSTRUCTIONS\nEXTRA INSTRUCTIONS")
    expect(prepared.params.options.systemMessageMode).toBeUndefined()
    expect(prepared.messages).toEqual([{ role: "user", content: "Hello" }])
  })

  test("sends the same text as one developer message and omits top-level instructions", async () => {
    const legacy = await run(input({}))
    const prepared = await run(input({ flag: true }))

    expect(prepared.params.options.instructions).toBeUndefined()
    expect(prepared.params.options.systemMessageMode).toBe("developer")
    // 逐字对照：developer 正文必须与旧顶层 instructions 完全相同
    expect(prepared.messages[0]).toEqual({ role: "system", content: legacy.params.options.instructions })
    expect(prepared.messages.slice(1)).toEqual([{ role: "user", content: "Hello" }])
  })

  test("joins plugin-appended system blocks into the single developer message", async () => {
    const prepared = await run(
      input({
        flag: true,
        plugin: {
          trigger: (name: string, _input: unknown, output: { system: string[] }) => {
            if (name === "experimental.chat.system.transform") output.system.push("PLUGIN BLOCK")
            return Effect.succeed(output)
          },
        } as unknown as Plugin.Interface,
      }),
    )

    expect(prepared.messages[0].role).toBe("system")
    expect(prepared.messages[0].content).toContain("EXTRA INSTRUCTIONS\nPLUGIN BLOCK")
    expect(prepared.messages.filter((message) => message.role === "system")).toHaveLength(1)
  })

  test("keeps the existing shape for 6.1 models even with the flag on", async () => {
    const prepared = await run(input({ apiId: "gpt-6.1-sol", flag: true }))

    expect(prepared.params.options.instructions).toContain("BASE INSTRUCTIONS\nEXTRA INSTRUCTIONS")
    expect(prepared.params.options.systemMessageMode).toBeUndefined()
    expect(prepared.messages).toEqual([{ role: "user", content: "Hello" }])
  })

  test("keeps the existing shape for API-key auth", async () => {
    const prepared = await run(input({ authType: "api", flag: true }))

    expect(prepared.params.options.instructions).toBeUndefined()
    expect(prepared.params.options.systemMessageMode).toBeUndefined()
    expect(prepared.messages[0].role).toBe("system")
    expect(prepared.messages.at(-1)).toEqual({ role: "user", content: "Hello" })
  })

  test("matches the model family by api id, not by display id", async () => {
    const value = input({ flag: true })
    const prepared = await run({
      ...value,
      model: { ...value.model, api: { ...value.model.api, id: "gpt-6.2-astra" } },
    })

    expect(prepared.params.options.systemMessageMode).toBe("developer")
    expect(prepared.params.options.instructions).toBeUndefined()
  })
})

// 用真实 @ai-sdk/openai 序列化 prepared 的请求形状，钉住最终 wire body：
// developer 模式下 instructions 必须消失且 input[0] 是 developer；旧形状下相反。
async function wireBody(prepared: Awaited<ReturnType<typeof run>>, apiId = "gpt-6.2-sol") {
  const bodies: Record<string, any>[] = []
  const model = createOpenAI({
    apiKey: "test-key",
    baseURL: "https://example.invalid/v1",
    fetch: (async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = init?.body
      bodies.push(JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array)))
      throw new Error("captured")
    }) as unknown as typeof fetch,
  }).responses(apiId)

  await generateText({
    model,
    messages: prepared.messages,
    providerOptions: ProviderTransform.providerOptions(testModel(apiId), prepared.params.options),
    allowSystemInMessages: true,
    maxRetries: 0,
  }).catch(() => undefined)

  expect(bodies).toHaveLength(1)
  return bodies[0]
}

describe("session.llm.request developer instructions wire shape", () => {
  test("sends the system text as the first input item and omits instructions", async () => {
    const body = await wireBody(await run(input({ flag: true })))

    expect(body.instructions).toBeUndefined()
    expect(body.input[0]).toEqual({
      role: "developer",
      content: expect.stringContaining("BASE INSTRUCTIONS\nEXTRA INSTRUCTIONS"),
    })
    expect(body.input[1]).toEqual({ role: "user", content: [{ type: "input_text", text: "Hello" }] })
  })

  test("keeps the legacy top-level instructions when the flag is off", async () => {
    const body = await wireBody(await run(input({})))

    expect(body.instructions).toContain("BASE INSTRUCTIONS\nEXTRA INSTRUCTIONS")
    expect(body.input[0].role).toBe("user")
  })
})
