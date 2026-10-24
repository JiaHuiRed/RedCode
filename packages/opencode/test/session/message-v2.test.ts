import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { APICallError, type ModelMessage } from "ai"
import { MessageV2 } from "../../src/session/message-v2"
import { ImageTokens } from "@/session/image-tokens"
import { ProviderTransform } from "@/provider/transform"
import type { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { Question } from "../../src/question"

const sessionID = SessionID.make("session")
const providerID = ProviderID.make("test")
const model: Provider.Model = {
  id: ModelID.make("test-model"),
  providerID,
  api: {
    id: "test-model",
    url: "https://example.com",
    npm: "@ai-sdk/openai",
  },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 0,
    input: 0,
    output: 0,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

function userInfo(id: string): MessageV2.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID, modelID: ModelID.make("test") },
    tools: {},
    mode: "",
  } as unknown as MessageV2.User
}

function assistantInfo(
  id: string,
  parentID: string,
  error?: MessageV2.Assistant["error"],
  meta?: { providerID: string; modelID: string },
): MessageV2.Assistant {
  const infoModel = meta ?? { providerID: model.providerID, modelID: model.api.id }
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    error,
    parentID,
    modelID: infoModel.modelID,
    providerID: infoModel.providerID,
    mode: "",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  } as unknown as MessageV2.Assistant
}

function basePart(messageID: string, id: string) {
  return {
    id: PartID.make(id.startsWith("prt") ? id : `prt_${id}`),
    sessionID,
    messageID: MessageID.make(messageID.startsWith("msg") ? messageID : `msg_${messageID}`),
  }
}

describe("session.message-v2 stored parts", () => {
  test("stores an edit patch once and restores both public metadata fields", () => {
    const patch = "UNIQUE-EDIT-PATCH-CONTENT"
    const part: MessageV2.ToolPart = {
      ...basePart("edit-message", "edit-part"),
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

    const stored = MessageV2.toStoredPart(part)
    const serialized = JSON.stringify(stored)
    expect(serialized.split(patch).length - 1).toBe(1)
    expect(MessageV2.fromStoredPart(JSON.parse(serialized) as MessageV2.Part)).toEqual(part)
  })

  test("does not synthesize a missing patch on legacy edit metadata", () => {
    const part: MessageV2.ToolPart = {
      ...basePart("legacy-edit-message", "legacy-edit-part"),
      type: "tool",
      callID: "call_legacy_edit",
      tool: "edit",
      state: {
        status: "completed",
        input: {},
        output: "Edit applied successfully.",
        title: "file.ts",
        metadata: {
          diff: "UNIQUE-EDIT-PATCH-CONTENT",
          filediff: { file: "file.ts", additions: 1, deletions: 0 },
        },
        time: { start: 1, end: 2 },
      },
    }

    expect(MessageV2.fromStoredPart(part)).toEqual(part)
  })
})

describe("session.message-v2.toModelMessage", () => {
  test("omits retired native compress nudges without mutating stored history", async () => {
    const notice: MessageV2.TextPart = {
      ...basePart("a1", "native-notice"),
      type: "text",
      synthetic: true,
      text: "[Context notice, not a user request] Use compress for closed ranges.",
      metadata: { native_context_nudge: { revision: "old-revision" } },
    }
    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo("a1", "u1"),
        parts: [{ ...basePart("a1", "reply"), type: "text", text: "Implementation verified." }, notice],
      },
    ]
    const before = structuredClone(input)
    const output = JSON.stringify(await MessageV2.toModelMessages(input, model))
    expect(output).toContain("Implementation verified.")
    expect(output).not.toContain("Use compress")
    expect(input).toEqual(before)
    expect(await MessageV2.toModelMessages([{ ...input[0]!, parts: [notice] }], model)).toEqual([])
    expect(
      JSON.stringify(
        await MessageV2.toModelMessages(
          [
            {
              ...input[0]!,
              parts: [{ ...notice, synthetic: false }],
            },
          ],
          model,
        ),
      ),
    ).toContain("Use compress")
  })

  test("filters out messages with no parts", async () => {
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("m-empty"),
        parts: [],
      },
      {
        info: userInfo("m-user"),
        parts: [
          {
            ...basePart("m-user", "p1"),
            type: "text",
            text: "hello",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ])
  })

  test("inserts a model-switch notice before the selected model's user turn", async () => {
    const firstUser = "m-first-user"
    const firstAssistant = "m-first-assistant"
    const secondUser = "m-second-user"
    const secondAssistant = "m-second-assistant"
    const thirdUser = "m-third-user"
    const oldModel = { providerID: ProviderID.make("deepseek"), modelID: ModelID.make("deepseek-v4-flash") }
    const newModel = { providerID: ProviderID.make("deepseek"), modelID: ModelID.make("deepseek-v4.1-flash") }
    const input: MessageV2.WithParts[] = [
      {
        info: { ...userInfo(firstUser), model: oldModel },
        parts: [{ ...basePart(firstUser, "p1"), type: "text", text: "first task" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(firstAssistant, firstUser, undefined, oldModel),
        parts: [{ ...basePart(firstAssistant, "p1"), type: "text", text: "first answer" }] as MessageV2.Part[],
      },
      {
        info: { ...userInfo(secondUser), model: newModel },
        parts: [{ ...basePart(secondUser, "p1"), type: "text", text: "second task" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(secondAssistant, secondUser, undefined, newModel),
        parts: [{ ...basePart(secondAssistant, "p1"), type: "text", text: "second answer" }] as MessageV2.Part[],
      },
      {
        info: { ...userInfo(thirdUser), model: newModel },
        parts: [{ ...basePart(thirdUser, "p1"), type: "text", text: "third task" }] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      { role: "user", content: [{ type: "text", text: "first task" }] },
      { role: "assistant", content: [{ type: "text", text: "first answer" }] },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "[model changed: assistant turns above this point were generated by deepseek/deepseek-v4-flash; the session continues with deepseek/deepseek-v4.1-flash]",
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "second task" }] },
      { role: "assistant", content: [{ type: "text", text: "second answer" }] },
      { role: "user", content: [{ type: "text", text: "third task" }] },
    ])
  })

  test("strips cross-model reasoning instead of demoting it to text", async () => {
    const userID = "m-xmodel-user"
    const assistantID = "m-xmodel-assistant"
    const oldModel = { providerID: ProviderID.make("glm"), modelID: ModelID.make("glm-5") }

    const input: MessageV2.WithParts[] = [
      {
        info: { ...userInfo(userID), model: oldModel },
        parts: [{ ...basePart(userID, "p1"), type: "text", text: "task" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID, undefined, oldModel),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "reasoning",
            text: "long thinking prose that must not reach the new model as text",
            time: { start: 0 },
          },
          { ...basePart(assistantID, "p2"), type: "text", text: "answer" },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      { role: "user", content: [{ type: "text", text: "task" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ])
  })

  test("keeps a placeholder when cross-model stripping empties an assistant turn", async () => {
    const userID = "m-xmodel2-user"
    const assistantID = "m-xmodel2-assistant"
    const oldModel = { providerID: ProviderID.make("glm"), modelID: ModelID.make("glm-5") }

    const input: MessageV2.WithParts[] = [
      {
        info: { ...userInfo(userID), model: oldModel },
        parts: [{ ...basePart(userID, "p1"), type: "text", text: "task" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID, undefined, oldModel),
        parts: [
          { ...basePart(assistantID, "p1"), type: "step-start" },
          { ...basePart(assistantID, "p2"), type: "reasoning", text: "thinking only", time: { start: 0 } },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      { role: "user", content: [{ type: "text", text: "task" }] },
      { role: "assistant", content: [{ type: "text", text: "[Thinking removed]" }] },
    ])
  })

  test("filters out messages with only ignored parts", async () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "ignored",
            ignored: true,
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("filters out user messages with only empty text parts", async () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("filters empty user text parts while keeping non-empty parts", async () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "",
          },
          {
            ...basePart(messageID, "p2"),
            type: "text",
            text: "hello",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ])
  })

  test("includes synthetic text parts", async () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
            synthetic: true,
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo("m-assistant", messageID),
        parts: [
          {
            ...basePart("m-assistant", "a1"),
            type: "text",
            text: "assistant",
            synthetic: true,
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant" }],
      },
    ])
  })

  test("converts user text/file parts and injects compaction/subtask prompts", async () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
          },
          {
            ...basePart(messageID, "p2"),
            type: "text",
            text: "ignored",
            ignored: true,
          },
          {
            ...basePart(messageID, "p3"),
            type: "file",
            mime: "image/png",
            filename: "img.png",
            url: "https://example.com/img.png",
          },
          {
            ...basePart(messageID, "p4"),
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "https://example.com/note.txt",
          },
          {
            ...basePart(messageID, "p5"),
            type: "file",
            mime: "application/x-directory",
            filename: "dir",
            url: "https://example.com/dir",
          },
          {
            ...basePart(messageID, "p6"),
            type: "compaction",
            auto: true,
          },
          {
            ...basePart(messageID, "p7"),
            type: "subtask",
            prompt: "prompt",
            description: "desc",
            agent: "agent",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          {
            type: "file",
            mediaType: "image/png",
            filename: "img.png",
            data: { type: "url", url: new URL("https://example.com/img.png") },
          },
          { type: "text", text: "What did we do so far?" },
          { type: "text", text: "The following tool was executed by the user" },
        ],
      },
    ])
  })

  // 260808 Red 回归：用户手动附件（粘贴/拖入）走 data: URL，必须原样保留。
  // 曾经这里调 stripDataUrlPrefix 把前缀剥掉留下裸 base64，而 v7 的
  // convertToModelMessages 对 file part 做真 new URL() 解析 → ERR_INVALID_URL，
  // 于是 prompt 构造直接抛异常、请求根本发不出去，UI 永远停在"等待模型响应"
  // （实测 ses_020d51950ffe…，日志里只有一条 service=server error="<整串 base64>"
  // cannot be parsed as a URL，token 全 0）。同一个坑 v7 迁移时修过工具结果附件那条，
  // 用户附件这条漏了——所以两条路径各来一个用例钉住。
  test("keeps data: URLs intact for user-attached media (v7 new URL() contract)", async () => {
    const messageID = "m-data-url"
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=="

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          { ...basePart(messageID, "p1"), type: "text", text: "看这个" },
          {
            ...basePart(messageID, "p2"),
            type: "file",
            mime: "image/png",
            filename: "clipboard",
            url: png,
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)
    const file = (result[0]!.content as any[]).find((part) => part.type === "file")
    // 关键断言：拿到的必须仍是可被 new URL() 解析的 data: URL，而不是裸 base64
    expect(String(file.data.url ?? file.data)).toStartWith("data:image/png;base64,")
    expect(() => new URL(String(file.data.url ?? file.data))).not.toThrow()
  })

  test("converts assistant tool completion into tool-call + tool-result messages with attachments", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "done",
            metadata: { openai: { assistant: "meta" } },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-1"),
                  type: "file",
                  mime: "image/png",
                  filename: "attachment.png",
                  url: "data:image/png;base64,Zm9v",
                },
              ],
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done", providerOptions: { openai: { assistant: "meta" } } },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: {
              type: "content",
              value: [
                { type: "text", text: "ok" },
                // 260807 Red v7: 工具结果内容的 "media" 变体并入 file 族，内联 base64 用 "file-data"
                { type: "file-data", mediaType: "image/png", data: "Zm9v" },
              ],
            },
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
    ])
  })

  test("preserves jpeg tool-result media for anthropic models", async () => {
    const anthropicModel: Provider.Model = {
      ...model,
      id: ModelID.make("anthropic/claude-opus-4-7"),
      providerID: ProviderID.make("anthropic"),
      api: {
        id: "claude-opus-4-7-20250805",
        url: "https://api.anthropic.com",
        npm: "@ai-sdk/anthropic",
      },
      capabilities: {
        ...model.capabilities,
        attachment: true,
        input: {
          ...model.capabilities.input,
          image: true,
          pdf: true,
        },
      },
    }
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]).toString(
      "base64",
    )
    const userID = "m-user-anthropic"
    const assistantID = "m-assistant-anthropic"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1-anthropic"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1-anthropic"),
            type: "tool",
            callID: "call-anthropic-1",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/tmp/rails-demo.png" },
              output: "Image read successfully",
              title: "Read",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-anthropic-1"),
                  type: "file",
                  mime: "image/jpeg",
                  filename: "rails-demo.png",
                  url: `data:image/jpeg;base64,${jpeg}`,
                },
              ],
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = ProviderTransform.message(await MessageV2.toModelMessages(input, anthropicModel), anthropicModel, {})
    expect(result).toHaveLength(3)
    expect(result[2].role).toBe("tool")
    expect(result[2].content[0]).toMatchObject({
      type: "tool-result",
      toolCallId: "call-anthropic-1",
      toolName: "read",
      output: {
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          { type: "file-data", mediaType: "image/jpeg", data: jpeg },
        ],
      },
    })
  })

  test("moves bedrock pdf tool-result media into a separate user message", async () => {
    const bedrockModel: Provider.Model = {
      ...model,
      id: ModelID.make("amazon-bedrock/anthropic.claude-sonnet-4-6"),
      providerID: ProviderID.make("amazon-bedrock"),
      api: {
        id: "anthropic.claude-sonnet-4-6",
        url: "https://bedrock-runtime.us-east-1.amazonaws.com",
        npm: "@ai-sdk/amazon-bedrock",
      },
      capabilities: {
        ...model.capabilities,
        attachment: true,
        input: {
          ...model.capabilities.input,
          image: true,
          pdf: true,
        },
      },
    }
    const pdf = Buffer.from("%PDF-1.4\n").toString("base64")
    const userID = "m-user-bedrock-pdf"
    const assistantID = "m-assistant-bedrock-pdf"
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1-bedrock-pdf"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1-bedrock-pdf"),
            type: "tool",
            callID: "call-bedrock-pdf-1",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "/tmp/example.pdf" },
              output: "PDF read successfully",
              title: "Read",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-bedrock-pdf-1"),
                  type: "file",
                  mime: "application/pdf",
                  filename: "example.pdf",
                  url: `data:application/pdf;base64,${pdf}`,
                },
              ],
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, bedrockModel)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-bedrock-pdf-1",
            toolName: "read",
            input: { filePath: "/tmp/example.pdf" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-bedrock-pdf-1",
            toolName: "read",
            output: { type: "text", value: "PDF read successfully" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Attached media from tool result:" },
          {
            type: "file",
            mediaType: "application/pdf",
            filename: "example.pdf",
            data: { type: "url", url: new URL(`data:application/pdf;base64,${pdf}`) },
          },
        ],
      },
    ])
  })

  test("omits provider metadata and strips reasoning when assistant model differs", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID, undefined, { providerID: "other", modelID: "other" }),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "done",
            metadata: { openai: { assistant: "meta" } },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "reasoning",
            text: "thinking",
            metadata: { openai: { reasoning: "meta" } },
            time: { start: 0 },
          },
          {
            ...basePart(assistantID, "a3"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done" },
          // 261024 Red 跨模型推理从「降级成 text」改为整段剥离（见 message-v2.ts 注释）。
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ])
  })

  test("replaces compacted tool output with placeholder", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "this should be cleared",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1, compacted: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "[Old tool result content cleared]" },
          },
        ],
      },
    ])
  })

  test("truncates tool output when requested", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "abcdefghij",
              title: "Shell",
              metadata: {},
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model, { toolOutputMaxChars: 4 })).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: {
              type: "text",
              // 260814 Red head+tail 4:1 截断:maxChars=4 → head 3 + tail 1,尾部保留结论/报错
              value: "abc\n[... tool output middle omitted for compaction: 6 chars ...]\nj",
            },
          },
        ],
      },
    ])
  })

  test("keeps historical multimodal tool results within the hard token budget", async () => {
    const userID = "m-user-budget"
    const assistantID = "m-assistant-budget"
    const output = "x".repeat(52_000)
    const attachments = Array.from({ length: 32 }, (_, index) => ({
      ...basePart(assistantID, `budget-file-${index}`),
      type: "file" as const,
      mime: "image/png",
      filename: `image-${index}.png`,
      url: "data:image/png;base64,Zm9v",
    }))
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [{ ...basePart(userID, "budget-user"), type: "text", text: "inspect tool output" }] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "budget-tool"),
            type: "tool",
            callID: "call-budget",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: "large-output.txt" },
              output,
              title: "Read",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments,
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const messages = await MessageV2.toModelMessages(input, model)
    const toolMessage = messages.find((message) => message.role === "tool")!
    const result = (toolMessage.content as any[])[0].output

    expect(ImageTokens.estimateModelMessages(result.value, model)).toBeLessThanOrEqual(14_000)
    expect((input[1]!.parts[0] as MessageV2.ToolPart).state.status).toBe("completed")
    const stored = (input[1]!.parts[0] as MessageV2.ToolPart).state
    if (stored.status === "completed") {
      expect(stored.output).toBe(output)
      expect(stored.attachments).toHaveLength(32)
    }
  })

  test("converts assistant tool error into error-text tool result", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "error",
              input: { cmd: "ls" },
              error: "nope",
              time: { start: 0, end: 1 },
              metadata: {},
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "error-text", value: "nope" },
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
    ])
  })

  test("forwards partial bash output for aborted tool calls", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"
    const output = [
      "31403",
      "12179",
      "4575",
      "",
      "<shell_metadata>",
      "User aborted the command",
      "</shell_metadata>",
    ].join("\n")

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "error",
              input: { command: "for i in {1..20}; do print -- $RANDOM; sleep 1; done" },
              error: "Tool execution aborted",
              metadata: { interrupted: true, output },
              time: { start: 0, end: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "for i in {1..20}; do print -- $RANDOM; sleep 1; done" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: output },
          },
        ],
      },
    ])
  })

  test("filters assistant messages with non-abort errors", async () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(
          assistantID,
          "m-parent",
          new MessageV2.APIError({ message: "boom", isRetryable: true }).toObject() as MessageV2.APIError,
        ),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "should not render",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("includes aborted assistant messages only when they have non-step-start/reasoning content", async () => {
    const assistantID1 = "m-assistant-1"
    const assistantID2 = "m-assistant-2"

    const aborted = new MessageV2.AbortedError({ message: "aborted" }).toObject() as MessageV2.Assistant["error"]

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID1, "m-parent", aborted),
        parts: [
          {
            ...basePart(assistantID1, "a1"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
          },
          {
            ...basePart(assistantID1, "a2"),
            type: "text",
            text: "partial answer",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID2, "m-parent", aborted),
        parts: [
          {
            ...basePart(assistantID2, "b1"),
            type: "step-start",
          },
          {
            ...basePart(assistantID2, "b2"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", providerOptions: undefined },
          { type: "text", text: "partial answer" },
        ],
      },
    ])
  })

  test("preserves OpenRouter reasoning details through provider transform", async () => {
    const assistantID = "m-assistant"
    const openrouterModel: Provider.Model = {
      ...model,
      id: ModelID.make("deepseek/deepseek-v4-pro"),
      providerID: ProviderID.make("openrouter"),
      api: {
        id: "deepseek/deepseek-v4-pro",
        url: "https://openrouter.ai/api/v1",
        npm: "@openrouter/ai-sdk-provider",
      },
      capabilities: {
        ...model.capabilities,
        reasoning: true,
        interleaved: { field: "reasoning_details" },
      },
    }
    const reasoningDetails = [
      {
        type: "reasoning.text",
        text: "thinking",
        format: "unknown",
        index: 0,
      },
    ]
    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent", undefined, {
          providerID: openrouterModel.providerID,
          modelID: openrouterModel.id,
        }),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
            metadata: {
              openrouter: {
                reasoning_details: reasoningDetails,
              },
            },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "text",
            text: "answer",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(
      ProviderTransform.message(await MessageV2.toModelMessages(input, openrouterModel), openrouterModel, {}),
    ).toStrictEqual([
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking",
            providerOptions: {
              openrouter: {
                reasoning_details: reasoningDetails,
              },
            },
          },
          { type: "text", text: "answer" },
        ],
      },
    ])
  })

  test("splits assistant messages on step-start boundaries", async () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "text",
            text: "first",
          },
          {
            ...basePart(assistantID, "p2"),
            type: "step-start",
          },
          {
            ...basePart(assistantID, "p3"),
            type: "text",
            text: "second",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "second" }],
      },
    ])
  })

  test("drops messages that only contain step-start parts", async () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "step-start",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(await MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("converts pending/running tool calls to error results to prevent dangling tool_use", async () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-pending",
            tool: "bash",
            state: {
              status: "pending",
              input: { cmd: "ls" },
              raw: "",
            },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-running",
            tool: "read",
            state: {
              status: "running",
              input: { path: "/tmp" },
              time: { start: 0 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-pending",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
          {
            type: "tool-call",
            toolCallId: "call-running",
            toolName: "read",
            input: { path: "/tmp" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-pending",
            toolName: "bash",
            output: { type: "error-text", value: "[Tool execution was interrupted]" },
          },
          {
            type: "tool-result",
            toolCallId: "call-running",
            toolName: "read",
            output: { type: "error-text", value: "[Tool execution was interrupted]" },
          },
        ],
      },
    ])
  })

  test("substitutes space for empty text between signed reasoning blocks", async () => {
    // Reproduces the bug pattern: [reasoning(sig), text(""), reasoning(sig), text(full)]
    const assistantID = "m-assistant"
    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          { ...basePart(assistantID, "p1"), type: "step-start" },
          {
            ...basePart(assistantID, "p2"),
            type: "reasoning",
            text: "thinking-one",
            metadata: { anthropic: { signature: "sig1" } },
          },
          { ...basePart(assistantID, "p3"), type: "text", text: "" },
          { ...basePart(assistantID, "p4"), type: "step-start" },
          {
            ...basePart(assistantID, "p5"),
            type: "reasoning",
            text: "thinking-two",
            metadata: { anthropic: { signature: "sig2" } },
          },
          { ...basePart(assistantID, "p6"), type: "text", text: "the answer" },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    // step-start splits into two assistant messages; SDK's groupIntoBlocks merges them later
    expect(result).toHaveLength(2)
    expect((result[0].content as any[]).find((p) => p.type === "text").text).toBe(" ")
    expect((result[1].content as any[]).find((p) => p.type === "text").text).toBe("the answer")
  })

  test("leaves empty text alone when reasoning signature is under 'bedrock' namespace", async () => {
    // Bedrock signed reasoning is preserved as reasoning metadata, but unlike the
    // direct Anthropic path we do not preserve empty text separators for Bedrock.
    const assistantID = "m-assistant-bedrock"
    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "reasoning",
            text: "thinking-bedrock",
            metadata: { bedrock: { signature: "bedrock-sig" } },
          },
          { ...basePart(assistantID, "p2"), type: "text", text: "" },
          { ...basePart(assistantID, "p3"), type: "text", text: "answer" },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toHaveLength(1)
    const texts = (result[0].content as any[]).filter((p) => p.type === "text")
    expect(texts.map((t) => t.text)).toStrictEqual(["", "answer"])
  })

  test("leaves empty text alone when reasoning has no Anthropic signature", async () => {
    // Non-Anthropic providers' reasoning doesn't position-validate, so empty text
    // should be filtered normally rather than substituted.
    const assistantID = "m-assistant-unsigned"
    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          { ...basePart(assistantID, "p1"), type: "reasoning", text: "thinking" },
          { ...basePart(assistantID, "p2"), type: "text", text: "" },
          { ...basePart(assistantID, "p3"), type: "text", text: "answer" },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toHaveLength(1)
    const texts = (result[0].content as any[]).filter((p) => p.type === "text")
    expect(texts.map((t) => t.text)).toStrictEqual(["", "answer"])
  })

  test("leaves empty text alone in assistant messages without reasoning", async () => {
    const assistantID = "m-assistant-no-reasoning"
    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          { ...basePart(assistantID, "p1"), type: "text", text: "" },
          { ...basePart(assistantID, "p2"), type: "text", text: "hello" },
        ] as MessageV2.Part[],
      },
    ]

    const result = await MessageV2.toModelMessages(input, model)

    expect(result).toHaveLength(1)
    const texts = (result[0].content as any[]).filter((p) => p.type === "text")
    expect(texts.map((t) => t.text)).toStrictEqual(["", "hello"])
  })
})

describe("session.message-v2.fromError", () => {
  test("serializes context_length_exceeded as ContextOverflowError", () => {
    const input = {
      type: "error",
      error: {
        code: "context_length_exceeded",
      },
    }
    const result = MessageV2.fromError(input, { providerID })

    expect(result).toStrictEqual({
      name: "ContextOverflowError",
      data: {
        message: "Input exceeds context window of this model",
        responseBody: JSON.stringify(input),
      },
    })
  })

  test("serializes response error codes", () => {
    const cases = [
      {
        code: "insufficient_quota",
        message: "Quota exceeded. Check your plan and billing details.",
      },
      {
        code: "usage_not_included",
        message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
      },
      {
        code: "invalid_prompt",
        message: "Invalid prompt from test",
      },
    ]

    cases.forEach((item) => {
      const input = {
        type: "error",
        error: {
          code: item.code,
          message: item.code === "invalid_prompt" ? item.message : undefined,
        },
      }
      const result = MessageV2.fromError(input, { providerID })

      expect(result).toStrictEqual({
        name: "APIError",
        data: {
          message: item.message,
          isRetryable: false,
          responseBody: JSON.stringify(input),
        },
      })
    })
  })

  test("serializes OpenAI response server_error stream chunks as retryable APIError", () => {
    const body = {
      type: "error",
      sequence_number: 2,
      error: {
        type: "server_error",
        code: "server_error",
        message:
          "An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req_77eccd008d984bf6bf82d1b2c2b68715 in your message.",
        param: null,
      },
    }
    const result = MessageV2.fromError({ message: JSON.stringify(body) }, { providerID })

    expect(result).toStrictEqual({
      name: "APIError",
      data: {
        message: body.error.message,
        isRetryable: true,
        responseBody: JSON.stringify(body),
      },
    })
  })

  test("detects context overflow from APICallError provider messages", () => {
    const cases = [
      "prompt is too long: 213462 tokens > 200000 maximum",
      "Your input exceeds the context window of this model",
      "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)",
      "Please reduce the length of the messages or completion",
      "400 status code (no body)",
      "413 status code (no body)",
    ]

    cases.forEach((message) => {
      const error = new APICallError({
        message,
        url: "https://example.com",
        requestBodyValues: {},
        statusCode: 400,
        responseHeaders: { "content-type": "application/json" },
        isRetryable: false,
      })
      const result = MessageV2.fromError(error, { providerID })
      expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(true)
    })
  })

  test("detects context overflow from context_length_exceeded code in response body", () => {
    const error = new APICallError({
      message: "Request failed",
      url: "https://example.com",
      requestBodyValues: {},
      statusCode: 422,
      responseHeaders: { "content-type": "application/json" },
      responseBody: JSON.stringify({
        error: {
          message: "Some message",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      }),
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID })
    expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(true)
  })

  test("does not classify 429 no body as context overflow", () => {
    const result = MessageV2.fromError(
      new APICallError({
        message: "429 status code (no body)",
        url: "https://example.com",
        requestBodyValues: {},
        statusCode: 429,
        responseHeaders: { "content-type": "application/json" },
        isRetryable: false,
      }),
      { providerID },
    )
    expect(MessageV2.ContextOverflowError.isInstance(result)).toBe(false)
    expect(MessageV2.APIError.isInstance(result)).toBe(true)
  })

  test("serializes unknown inputs", () => {
    const result = MessageV2.fromError(123, { providerID })

    expect(result).toStrictEqual({
      name: "UnknownError",
      data: {
        message: "123",
      },
    })
  })

  test("serializes tagged errors with their message", () => {
    const result = MessageV2.fromError(new Question.RejectedError(), { providerID })

    expect(result).toStrictEqual({
      name: "UnknownError",
      data: {
        message: "The question was dismissed",
      },
    })
  })

  test("classifies ZlibError from fetch as retryable APIError", () => {
    const zlibError = new Error(
      'ZlibError fetching "https://redcode.cloudflare.dev/anthropic/messages". For more information, pass `verbose: true` in the second argument to fetch()',
    )
    ;(zlibError as any).code = "ZlibError"
    ;(zlibError as any).errno = 0
    ;(zlibError as any).path = ""

    const result = MessageV2.fromError(zlibError, { providerID })

    expect(MessageV2.APIError.isInstance(result)).toBe(true)
    expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
    expect((result as MessageV2.APIError).data.message).toInclude("decompression")
  })

  test("classifies ZlibError as AbortedError when abort context is provided", () => {
    const zlibError = new Error(
      'ZlibError fetching "https://redcode.cloudflare.dev/anthropic/messages". For more information, pass `verbose: true` in the second argument to fetch()',
    )
    ;(zlibError as any).code = "ZlibError"
    ;(zlibError as any).errno = 0

    const result = MessageV2.fromError(zlibError, { providerID, aborted: true })

    expect(result.name).toBe("MessageAbortedError")
  })
})

describe("session.message-v2.latest", () => {
  const TAIL_USER = MessageID.make("msg_001")
  const OVERFLOW_ASSISTANT = MessageID.make("msg_002")
  const COMPACTION_USER = MessageID.make("msg_003")
  const SUMMARY_ASSISTANT = MessageID.make("msg_004")
  const CONTINUE_USER = MessageID.make("msg_005")
  const NEW_COMPACTION_USER = MessageID.make("msg_006")

  const tailUser: MessageV2.WithParts = {
    info: userInfo(TAIL_USER),
    parts: [{ ...basePart(TAIL_USER, "p1"), type: "text", text: "original prompt" }] as MessageV2.Part[],
  }

  const overflowAssistant: MessageV2.WithParts = {
    info: {
      ...assistantInfo(OVERFLOW_ASSISTANT, TAIL_USER),
      finish: "tool-calls",
      tokens: { input: 280_000, output: 200, reasoning: 0, cache: { read: 0, write: 0 }, total: 280_200 },
    } as MessageV2.Assistant,
    parts: [],
  }

  const compactionUser: MessageV2.WithParts = {
    info: userInfo(COMPACTION_USER),
    parts: [
      {
        ...basePart(COMPACTION_USER, "p1"),
        type: "compaction",
        auto: true,
        tail_start_id: TAIL_USER,
      },
    ] as MessageV2.Part[],
  }

  const summaryAssistant: MessageV2.WithParts = {
    info: {
      ...assistantInfo(SUMMARY_ASSISTANT, COMPACTION_USER),
      summary: true,
      finish: "stop",
      tokens: { input: 150_000, output: 1_500, reasoning: 0, cache: { read: 0, write: 0 }, total: 151_500 },
    } as MessageV2.Assistant,
    parts: [],
  }

  const continueUser: MessageV2.WithParts = {
    info: userInfo(CONTINUE_USER),
    parts: [
      {
        ...basePart(CONTINUE_USER, "p1"),
        type: "text",
        text: "Continue if you have next steps...",
        synthetic: true,
        metadata: { compaction_continue: true },
      },
    ] as MessageV2.Part[],
  }

  // Regression for double auto-compaction. The reorder in filterCompacted
  // (#27145) returns [compaction-user, summary, ...tail..., continue-user],
  // so picking lastFinished by array position landed on the pre-compaction
  // overflow assistant and bypassed the `summary !== true` overflow guard
  // in SessionPrompt.runLoop, firing a second compaction.create immediately.
  test("finished is the chronologically-latest finished assistant, not the array-latest", () => {
    const filtered = MessageV2.filterCompacted([
      continueUser,
      summaryAssistant,
      compactionUser,
      overflowAssistant,
      tailUser,
    ])

    const state = MessageV2.latest(filtered)

    expect(state.finished?.id).toBe(SUMMARY_ASSISTANT)
    expect(state.finished?.summary).toBe(true)
    expect(state.user?.id).toBe(CONTINUE_USER)
    expect(state.tasks).toEqual([])
  })

  test("a fresh compaction-user newer than the latest summary surfaces in tasks", () => {
    const newCompactionUser: MessageV2.WithParts = {
      info: userInfo(NEW_COMPACTION_USER),
      parts: [
        {
          ...basePart(NEW_COMPACTION_USER, "p1"),
          type: "compaction",
          auto: true,
        },
      ] as MessageV2.Part[],
    }

    const state = MessageV2.latest([
      tailUser,
      overflowAssistant,
      compactionUser,
      summaryAssistant,
      continueUser,
      newCompactionUser,
    ])

    expect(state.finished?.id).toBe(SUMMARY_ASSISTANT)
    expect(state.user?.id).toBe(NEW_COMPACTION_USER)
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]).toMatchObject({ type: "compaction", auto: true })
  })

  // 261013 Red 真实流中断会写 error/completed，但没有 provider finish。
  for (const name of ["UnknownError", "MessageAbortedError"] as const) {
    test(`a terminal ${name} summary retires only its own compaction task`, () => {
      const failed: MessageV2.WithParts = {
        info: {
          ...assistantInfo(SUMMARY_ASSISTANT, COMPACTION_USER),
          summary: true,
          time: { created: 4, completed: 5 },
          error: { name, data: { message: "Interrupted summary" } },
        },
        parts: [],
      }
      const unrelated: MessageV2.WithParts = {
        info: { ...userInfo(NEW_COMPACTION_USER), time: { created: 6 } },
        parts: [{ ...basePart(NEW_COMPACTION_USER, "fresh"), type: "compaction", auto: false }],
      }
      const pendingSubtask: MessageV2.SubtaskPart = {
        ...basePart(COMPACTION_USER, "subtask"),
        type: "subtask",
        prompt: "pending work",
        description: "pending work",
        agent: "explore",
      }
      const state = MessageV2.latest([
        {
          ...compactionUser,
          info: { ...compactionUser.info, time: { created: 3 } },
          parts: [...compactionUser.parts, pendingSubtask],
        },
        failed,
        unrelated,
      ])
      expect(state.tasks.map((part) => part.id)).toEqual([pendingSubtask.id, unrelated.parts[0]!.id])
      expect(state.user?.id).toBe(NEW_COMPACTION_USER)
      expect(state.finished).toBeUndefined()
      expect("finish" in failed.info).toBe(false)
    })
  }

  test("an unfinished summary does not discard a recoverable compaction task", () => {
    const state = MessageV2.latest([
      compactionUser,
      { info: { ...assistantInfo(SUMMARY_ASSISTANT, COMPACTION_USER), summary: true }, parts: [] },
    ])
    expect(state.tasks.map((part) => part.id)).toEqual(compactionUser.parts.map((part) => part.id))
  })

  // 260903 cc filterCompacted 拆成两个入口：数组入参先排序（filterCompacted），
  // 逆序流直接懒扫（filterCompactedOrdered）。这一组守两件事：两条路结果一致，
  // 且懒扫真的在压缩边界处停止拉取、不会把整个生成器抽干。
  describe("filterCompactedOrdered 懒扫", () => {
    const shown = [continueUser, summaryAssistant, compactionUser, overflowAssistant, tailUser]
    const newestFirst = [...shown].sort((a, b) => MessageV2.compareTime(b.info, a.info))

    test("逆序懒扫与排序全扫结果逐条相同", () => {
      const viaArray = MessageV2.filterCompacted(shown)
      const viaOrdered = MessageV2.filterCompactedOrdered(newestFirst)
      expect(viaOrdered.map((m) => m.info.id)).toEqual(viaArray.map((m) => m.info.id))
    })

    test("入参顺序被打乱时 filterCompacted 仍归一化到同一结果", () => {
      const base = MessageV2.filterCompacted(shown).map((m) => m.info.id)
      for (const order of [
        [tailUser, overflowAssistant, compactionUser, summaryAssistant, continueUser],
        [summaryAssistant, tailUser, continueUser, compactionUser, overflowAssistant],
      ]) {
        expect(MessageV2.filterCompacted(order).map((m) => m.info.id)).toEqual(base)
      }
    })

    test("命中压缩边界后不再从生成器取值", () => {
      let pulled = 0
      function* source() {
        for (const msg of newestFirst) {
          pulled++
          yield msg
        }
        // 边界之后还有一大截历史；懒扫不该碰到它们
        for (let i = 0; i < 500; i++) {
          pulled++
          yield newestFirst[newestFirst.length - 1]!
        }
      }
      const out = MessageV2.filterCompactedOrdered(source())
      expect(out.length).toBeGreaterThan(0)
      expect(pulled).toBeLessThanOrEqual(newestFirst.length)
    })
  })
})

describe("ProviderTransform.unsupportedParts - 附件落盘", () => {
  // 260808 Red 回归：不支持图片的模型收到用户附件时，必须把图片写进临时目录、
  // 并在占位文本里给出**真实可读的路径**。
  //
  // 曾经断在两处：① v7 把 file part 载荷包成 `data: { type:"url", url: URL }`，
  // savePartToTemp 只认字符串/字节，三个分支都不匹配直接 return null —— 图片根本没落盘；
  // ② 文案却无条件写 "…at the path below" 再拼一个空的 pathHint，于是模型被告知
  // "去读下面那个路径"但下面什么都没有，只能自己去 prompt-history.jsonl 刨 base64
  // 手动解码。两处都修了，这个用例把"路径存在且文件可读"钉死。
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

  test("图片写入临时文件，占位文本给出真实路径", async () => {
    const mid = "m-attach"
    const msgs = await MessageV2.toModelMessages(
      [
        {
          info: userInfo(mid),
          parts: [
            {
              ...basePart(mid, "p1"),
              type: "file",
              mime: "image/png",
              filename: "clipboard",
              url: `data:image/png;base64,${PNG}`,
            },
          ] as MessageV2.Part[],
        },
      ],
      model,
    )

    const out = ProviderTransform.message(msgs, model, {})
    const text = (out[0]!.content as any[]).find((part: any) => part.type === "text")?.text ?? ""

    const match = text.match(/read this file: (.+)$/)
    expect(match).not.toBeNull()
    const filepath = match![1]!
    expect(existsSync(filepath)).toBe(true)
    // 落盘的必须是原图字节，不是空文件或占位
    expect(readFileSync(filepath)).toEqual(Buffer.from(PNG, "base64"))
    // 文件名按内容哈希，同一张图恒定同一路径（前缀缓存依赖这点，见 260804）
    expect(filepath).toMatch(/redcode-vision-[0-9a-f]{16}\.png$/)
  })
})

// 260814 Red head+tail 截断纯函数测试（改造自 head-only，参考 DSH tool-result-pruner）
describe("truncateToolOutput", () => {
  test("returns text unchanged when within budget or no budget", () => {
    expect(MessageV2.truncateToolOutput("short", 100)).toBe("short")
    expect(MessageV2.truncateToolOutput("anything", undefined)).toBe("anything")
  })

  test("keeps head and tail at 4:1 with an omitted-count marker", () => {
    const text = "H".repeat(900) + "T".repeat(100)
    const out = MessageV2.truncateToolOutput(text, 100)
    expect(out.startsWith("H".repeat(80))).toBe(true)
    expect(out.endsWith("T".repeat(20))).toBe(true)
    expect(out).toContain("[... tool output middle omitted for compaction: 900 chars ...]")
  })

  test("tail survives so error conclusions stay visible to the summarizer", () => {
    const text = "x".repeat(5000) + "\nERROR: exit code 1"
    const out = MessageV2.truncateToolOutput(text, 2000)
    expect(out).toContain("ERROR: exit code 1")
  })

  test("result is strictly smaller than the input", () => {
    const text = "y".repeat(10_000)
    const out = MessageV2.truncateToolOutput(text, 2000)
    expect(out.length).toBeLessThan(text.length)
  })
})

// 260814 Red MessageID 48 位编码 795 天回绕回归：2026-08-14 19:19:55.136 第 26 次回绕后，
// 新 ID 字典序小于回绕前旧 ID（ffff 前缀 → 0000 前缀）。「先后」必须走 compareTime
// 的 time.created，ID 只做 identity——曾因 latest() 用 ID 字典序致 runLoop 219 步空转死循环。
describe("session.message-v2.compareTime id wrap-around", () => {
  // 真实回绕现场的两条 ID（ses_0053f5027f...，19:18:23 vs 19:21:07）
  const preWrap = MessageID.make("msg_ffffe99de001q1YxL03nJcwemG")
  const postWrap = MessageID.make("msg_000011a87001hSDtPmoH")

  const withCreated = (info: MessageV2.User | MessageV2.Assistant, created: number) => {
    info.time.created = created
    return info
  }

  test("created decides order even when ID lexicographic order is inverted", () => {
    const old = withCreated(userInfo(preWrap), 1_786_706_303_698)
    const fresh = withCreated(userInfo(postWrap), 1_786_706_407_000)
    expect(fresh.id < old.id).toBe(true) // 字典序已失真（这是 bug 的现场条件）
    expect(MessageV2.compareTime(fresh, old)).toBeGreaterThan(0)
    expect(MessageV2.compareTime(old, fresh)).toBeLessThan(0)
  })

  test("same-ms tie-break falls back to id lexicographic order", () => {
    const a = withCreated(userInfo("msg_fffffffff0001AA"), 1_000)
    const b = withCreated(userInfo("msg_fffffffff0002BB"), 1_000)
    expect(MessageV2.compareTime(b, a)).toBeGreaterThan(0)
  })

  test("latest() picks newest user by created, not by id", () => {
    const msgs: MessageV2.WithParts[] = [
      { info: withCreated(userInfo(preWrap), 1_786_706_303_698), parts: [] },
      { info: withCreated(userInfo(postWrap), 1_786_706_407_000), parts: [] },
    ]
    const { user } = MessageV2.latest(msgs)
    expect(user?.id).toBe(postWrap)
  })

  test("latest() picks newest finished assistant by created, not by id", () => {
    const msgs: MessageV2.WithParts[] = [
      {
        info: withCreated({ ...assistantInfo(preWrap, preWrap), finish: "stop" }, 1_786_706_303_700),
        parts: [],
      },
      {
        info: withCreated({ ...assistantInfo(postWrap, postWrap), finish: "stop" }, 1_786_706_407_100),
        parts: [],
      },
    ]
    const { assistant, finished } = MessageV2.latest(msgs)
    expect(assistant?.id).toBe(postWrap)
    expect(finished?.id).toBe(postWrap)
  })

  test("tasks filter uses created boundary: compaction on newer user stays a task", () => {
    const olderFinished = withCreated({ ...assistantInfo("msg_ffffffffffff01AA", preWrap), finish: "stop" }, 2_000)
    const newerUser = withCreated(userInfo(postWrap), 3_000)
    const compactionPart: MessageV2.CompactionPart = {
      ...basePart(postWrap, "p-compact"),
      type: "compaction",
      auto: false,
      tail_start_id: undefined,
    }
    const msgs: MessageV2.WithParts[] = [
      { info: olderFinished, parts: [] },
      { info: newerUser, parts: [compactionPart] },
    ]
    // postWrap(id 0000) 字典序 < finished(id ffff)，若按 ID 比较会把 task 误判为已处理
    expect(postWrap < olderFinished.id).toBe(true)
    const { tasks } = MessageV2.latest(msgs)
    expect(tasks).toHaveLength(1)
  })
})

// 261007 Red steer 场景下重复 tool-result 被复制发出的 wire bug（DeepSeek 400）。
const assistantCalling = (...ids: string[]): ModelMessage => ({
  role: "assistant",
  content: ids.map((toolCallId) => ({
    type: "tool-call" as const,
    toolCallId,
    toolName: "bash",
    input: {},
  })),
})
const toolResults = (...ids: string[]): ModelMessage => ({
  role: "tool",
  content: ids.map((toolCallId) => ({
    type: "tool-result" as const,
    toolCallId,
    toolName: "bash",
    output: { type: "text" as const, value: "ok" },
  })),
})

describe("sanitizeToolResultPairing", () => {
  test("drops duplicated tool-results when a single declaration is answered twice", () => {
    const messages = [assistantCalling("a", "b"), toolResults("a", "b"), toolResults("a", "b")]
    const out = MessageV2.sanitizeToolResultPairing(messages)
    expect(out.messages).toHaveLength(2)
    expect(out.droppedIds).toEqual(["a", "b"])
  })

  test("drops orphan tool-result that has no preceding declaration", () => {
    const out = MessageV2.sanitizeToolResultPairing([toolResults("orphan")])
    expect(out.messages).toHaveLength(0)
    expect(out.droppedIds).toEqual(["orphan"])
  })

  test("passes correct data through unchanged (identity, same references)", () => {
    const messages = [
      assistantCalling("a", "b"),
      toolResults("a", "b"),
      { role: "assistant" as const, content: "done" },
    ]
    const out = MessageV2.sanitizeToolResultPairing(messages)
    expect(out.messages).toHaveLength(3)
    expect(out.messages[0]).toBe(messages[0])
    expect(out.messages[1]).toBe(messages[1])
    expect(out.droppedIds).toEqual([])
  })

  test("keeps matched results and drops unmatched ones inside one tool message", () => {
    const out = MessageV2.sanitizeToolResultPairing([assistantCalling("a"), toolResults("a", "b")])
    expect(out.messages).toHaveLength(2)
    expect(out.messages[1]?.content).toEqual([
      { type: "tool-result", toolCallId: "a", toolName: "bash", output: { type: "text", value: "ok" } },
    ])
    expect(out.droppedIds).toEqual(["b"])
  })

  test("re-declaration lets the same id be answered again (paired blocks stay)", () => {
    const messages = [assistantCalling("a"), toolResults("a"), assistantCalling("a"), toolResults("a")]
    const out = MessageV2.sanitizeToolResultPairing(messages)
    expect(out.messages).toHaveLength(4)
    expect(out.droppedIds).toEqual([])
  })

  // 261021 Red 中断（abort）后迟到的同一 callID 事件会在**同一条** assistant 消息里建出第二个
  // tool part，出站就成了一条 assistant 带两个同 id 的 tool-call —— DeepSeek 直接 400
  // "Duplicate value for 'tool_call_id' of … in message[N]"（ses_ffe5ea3f9fc6affeVuOAbr0ti96vsW 实证）。
  test("drops duplicated tool-calls inside one assistant message", () => {
    const out = MessageV2.sanitizeToolResultPairing([assistantCalling("a", "a", "b"), toolResults("a", "b")])
    expect(out.messages).toHaveLength(2)
    expect(out.messages[0]?.content).toHaveLength(2)
    expect(out.droppedCallIds).toEqual(["a"])
    expect(out.droppedIds).toEqual([])
  })
})

// 261015 Red 审计 A01：净化与缓存拼接的**组合**。净化放在拼接之前，但后缀原本取自未净化的
// 原始数组 —— 等于把净化刚丢掉的重复/孤儿 result 又拼回去，出站数组重新违反配对协议
// （与 261007 那条 "Messages with role 'tool' must be a response to a preceding message with
// 'tool_calls'" 同一形状）。这些用例用真实现驱动，不复刻一份净化逻辑。
describe("stitchModelMessages", () => {
  test("缓存命中且无丢弃时沿用缓存对象（前缀字节不变）", () => {
    const first = [assistantCalling("a"), toolResults("a")]
    const cached = MessageV2.sanitizeToolResultPairing(first).messages
    const raw = [...first, { role: "assistant" as const, content: "next" }]
    const sanitized = MessageV2.sanitizeToolResultPairing(raw)
    const out = MessageV2.stitchModelMessages(cached, raw, sanitized)
    expect(out).toHaveLength(3)
    expect(out[0]).toBe(cached[0])
    expect(out[1]).toBe(cached[1])
    expect(out[2]).toBe(raw[2])
  })

  test("净化丢弃重复 result 时，不得从原始数组把它拼回来", () => {
    const first = [assistantCalling("a"), toolResults("a")]
    const cached = MessageV2.sanitizeToolResultPairing(first).messages
    const raw = [...first, toolResults("a")] // 本轮转换多出一条重复 result
    const sanitized = MessageV2.sanitizeToolResultPairing(raw)
    expect(sanitized.messages).toHaveLength(2) // 净化本身是对的
    const out = MessageV2.stitchModelMessages(cached, raw, sanitized)
    expect(out).toHaveLength(2)
    expect(out).toBe(sanitized.messages)
  })

  test("孤儿 result 整条被丢时同样不得拼回", () => {
    const cached: ModelMessage[] = [{ role: "assistant", content: "hi" }]
    const raw: ModelMessage[] = [{ role: "assistant" as const, content: "hi" }, toolResults("orphan")]
    const sanitized = MessageV2.sanitizeToolResultPairing(raw)
    expect(sanitized.messages).toHaveLength(1)
    const out = MessageV2.stitchModelMessages(cached, raw, sanitized)
    expect(out).toHaveLength(1)
    expect(out).toBe(sanitized.messages)
  })

  test("单条 tool message 内混有合法与无效 result 时，只丢无效那条", () => {
    const first = [assistantCalling("a")]
    const cached = MessageV2.sanitizeToolResultPairing(first).messages
    const raw = [...first, toolResults("a", "b")]
    const sanitized = MessageV2.sanitizeToolResultPairing(raw)
    expect(sanitized.droppedIds).toEqual(["b"])
    const out = MessageV2.stitchModelMessages(cached, raw, sanitized)
    expect(out).toHaveLength(2)
    expect(out[1]).toBe(sanitized.messages[1])
  })

  test("同 ID 在后续 assistant 合法重声明时，合法配对不被丢弃", () => {
    const first = [assistantCalling("a"), toolResults("a")]
    const cached = MessageV2.sanitizeToolResultPairing(first).messages
    const raw = [...first, assistantCalling("a"), toolResults("a")]
    const sanitized = MessageV2.sanitizeToolResultPairing(raw)
    expect(sanitized.droppedIds).toEqual([])
    const out = MessageV2.stitchModelMessages(cached, raw, sanitized)
    expect(out).toHaveLength(4)
    expect(out[2]).toBe(raw[2])
    expect(out[3]).toBe(raw[3])
  })

  test("没有缓存时原样返回本次规范化结果", () => {
    const raw = [assistantCalling("a"), toolResults("a")]
    const sanitized = MessageV2.sanitizeToolResultPairing(raw)
    expect(MessageV2.stitchModelMessages(undefined, raw, sanitized)).toBe(sanitized.messages)
  })

  test("缓存比本次结果长（历史缩短）时不拼接", () => {
    const cached: ModelMessage[] = [
      { role: "assistant", content: "a" },
      { role: "assistant", content: "b" },
      { role: "assistant", content: "c" },
    ]
    const raw: ModelMessage[] = [
      { role: "assistant" as const, content: "a" },
      { role: "assistant" as const, content: "b" },
    ]
    const sanitized = MessageV2.sanitizeToolResultPairing(raw)
    expect(MessageV2.stitchModelMessages(cached, raw, sanitized)).toBe(sanitized.messages)
  })
})

// 261024 Red 历史图片驱逐（experimental.mediaEviction）：占位符、附件丢弃、窗口边界、关闭态。
describe("media eviction (keepRecentMedia)", () => {
  const imagePart = (msgID: string, pid: string, name: string) =>
    ({ ...basePart(msgID, pid), type: "file", mime: "image/png", filename: name, url: "data:image/png;base64,Zm9v" }) as MessageV2.Part

  const flatText = (content: unknown) =>
    Array.isArray(content)
      ? content.flatMap((p) => (p && typeof p === "object" && (p as { type: string }).type === "text" ? [(p as { text: string }).text] : []))
      : typeof content === "string"
        ? [content]
        : []
  const hasFilePart = (content: unknown) =>
    Array.isArray(content) && content.some((p) => p && typeof p === "object" && (p as { type: string }).type.startsWith("file"))

  test("evicts user images beyond the keep window with a named placeholder", async () => {
    const input: MessageV2.WithParts[] = [
      { info: userInfo("m-mev-u1"), parts: [imagePart("m-mev-u1", "p1", "old.png")] },
      { info: userInfo("m-mev-u2"), parts: [imagePart("m-mev-u2", "p2", "new.png")] },
    ]
    const out = await MessageV2.toModelMessages(input, model, { keepRecentMedia: 1 })
    expect(flatText(out[0]?.content)).toContain("[Historical image removed: old.png]")
    expect(hasFilePart(out[0]?.content)).toBe(false)
    expect(hasFilePart(out[1]?.content)).toBe(true)
  })

  test("evicts old tool-result image attachments and says so in the output", async () => {
    const assistantID = "m-mev-a"
    const toolPart = (pid: string, callID: string) =>
      ({
        ...basePart(assistantID, pid),
        type: "tool",
        callID,
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "x.png" },
          output: "Image read successfully",
          title: "Read",
          metadata: {},
          time: { start: 0, end: 1 },
          attachments: [imagePart(assistantID, `${pid}-img`, `${callID}.png`)],
        },
      }) as MessageV2.Part
    const input: MessageV2.WithParts[] = [
      { info: userInfo("m-mev-u3"), parts: [{ ...basePart("m-mev-u3", "t"), type: "text", text: "compare" }] as MessageV2.Part[] },
      { info: assistantInfo(assistantID, "m-mev-u3"), parts: [toolPart("old", "call-1"), toolPart("new", "call-2")] },
    ]
    const out = await MessageV2.toModelMessages(input, model, { keepRecentMedia: 1 })
    // 两个 tool-result 同在一条 tool 消息里——按 toolCallId 逐条取，别按消息取
    const results = out
      .filter((m) => m.role === "tool")
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    const old = JSON.stringify(results.find((r) => (r as { toolCallId?: string }).toolCallId === "call-1"))
    const recent = JSON.stringify(results.find((r) => (r as { toolCallId?: string }).toolCallId === "call-2"))
    expect(old).toContain("[historical image attachment removed]")
    expect(old).not.toContain("file-data")
    expect(recent).toContain("file-data")
    expect(recent).not.toContain("[historical image attachment removed]")
  })

  test("off without the option — byte-identical to before", async () => {
    const input: MessageV2.WithParts[] = [
      { info: userInfo("m-mev-u4"), parts: [imagePart("m-mev-u4", "p1", "old.png")] },
      { info: userInfo("m-mev-u5"), parts: [imagePart("m-mev-u5", "p2", "new.png")] },
    ]
    const out = await MessageV2.toModelMessages(input, model)
    expect(hasFilePart(out[0]?.content)).toBe(true)
    expect(hasFilePart(out[1]?.content)).toBe(true)
    expect(flatText(out[0]?.content).some((t) => t.includes("Historical image removed"))).toBe(false)
  })

  test("non-image attachments never occupy the window", async () => {
    const pdf = (msgID: string, pid: string) =>
      ({ ...basePart(msgID, pid), type: "file", mime: "application/pdf", filename: "doc.pdf", url: "data:application/pdf;base64,Zm9v" }) as MessageV2.Part
    const input: MessageV2.WithParts[] = [
      { info: userInfo("m-mev-u6"), parts: [pdf("m-mev-u6", "p1"), imagePart("m-mev-u6", "p2", "shot.png")] },
    ]
    // 窗口 0：图片全驱逐，pdf 不受影响
    const out = await MessageV2.toModelMessages(input, model, { keepRecentMedia: 0 })
    expect(flatText(out[0]?.content)).toContain("[Historical image removed: shot.png]")
    expect(hasFilePart(out[0]?.content)).toBe(true)
  })
})
