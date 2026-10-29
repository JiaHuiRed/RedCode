import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { asSchema, jsonSchema, type JSONSchema7 } from "ai"
import { PromptPin } from "../../src/session/prompt-pin"

// 261029 Red prompt-pin：会话级 prompt 钉住的磁盘延伸（重启续接防 MCP 升级打穿前缀缓存）。
// 测试用独立目录，绝不碰 live 数据目录里的 prompt-pin/。

const pinDir = path.join(os.tmpdir(), "redcode-prompt-pin-test")

const defs = () =>
  new Map([
    [
      "bash",
      { description: "run shell", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
    ],
    ["grep", { description: "search files", inputSchema: { type: "object", properties: { pattern: {} } } }],
  ])

beforeEach(async () => {
  process.env["REDCODE_PROMPT_PIN_DIR"] = pinDir
  await fs.rm(pinDir, { recursive: true, force: true })
})

afterAll(async () => {
  delete process.env["REDCODE_PROMPT_PIN_DIR"]
  await fs.rm(pinDir, { recursive: true, force: true })
})

describe("prompt-pin", () => {
  test("save→load 往返，tools 序列化逐字节一致（前缀稳定的硬要求）", async () => {
    PromptPin.save({ sessionID: "ses_a", tools: defs(), mcpGuide: "mcp guide text" })
    await PromptPin.flush()
    const pin = PromptPin.load("ses_a")
    expect(pin).toBeDefined()
    expect(pin!.sessionID).toBe("ses_a")
    expect(pin!.mcpGuide).toBe("mcp guide text")
    // JSON 往返键序保持插入序：恢复后再序列化必须与首轮序列化逐字节一致，
    // 否则 overlay 后发出去的工具 schema 字节变了，pin 就白做
    expect(JSON.stringify(pin!.tools)).toBe(JSON.stringify(Object.fromEntries(defs())))
  })

  test("mcpGuide 为 undefined 时往返保持 undefined（不回退成现算）", async () => {
    PromptPin.save({ sessionID: "ses_a", tools: defs(), mcpGuide: undefined })
    await PromptPin.flush()
    const pin = PromptPin.load("ses_a")
    expect(pin).toBeDefined()
    expect(pin!.mcpGuide).toBeUndefined()
  })

  test("会话隔离：别的会话读不到", async () => {
    PromptPin.save({ sessionID: "ses_a", tools: defs(), mcpGuide: undefined })
    await PromptPin.flush()
    expect(PromptPin.load("ses_b")).toBeUndefined()
  })

  test("损坏的 JSON 弃用不抛错", async () => {
    PromptPin.save({ sessionID: "ses_a", tools: defs(), mcpGuide: undefined })
    await PromptPin.flush()
    await fs.writeFile(path.join(pinDir, "ses_a.json"), "{not json", "utf-8")
    expect(PromptPin.load("ses_a")).toBeUndefined()
  })

  test("版本或 sessionID 不匹配弃用", async () => {
    await fs.mkdir(pinDir, { recursive: true })
    await fs.writeFile(
      path.join(pinDir, "ses_a.json"),
      JSON.stringify({ version: 999, sessionID: "ses_a", savedAt: 0, tools: {} }),
      "utf-8",
    )
    await fs.writeFile(
      path.join(pinDir, "ses_c.json"),
      JSON.stringify({ version: 1, sessionID: "ses_other", savedAt: 0, tools: {} }),
      "utf-8",
    )
    expect(PromptPin.load("ses_a")).toBeUndefined()
    expect(PromptPin.load("ses_c")).toBeUndefined()
  })

  test("drop 之后读不到", async () => {
    PromptPin.save({ sessionID: "ses_a", tools: defs(), mcpGuide: undefined })
    await PromptPin.flush()
    expect(PromptPin.load("ses_a")).toBeDefined()
    PromptPin.drop("ses_a")
    await PromptPin.flush()
    expect(PromptPin.load("ses_a")).toBeUndefined()
  })

  test("无 pin 目录时 load 静默返回 undefined", () => {
    expect(PromptPin.load("ses_never")).toBeUndefined()
  })

  // 261029 Red P1 回归：真实 AI SDK Schema 对象直接 stringify 会丢 Symbol 标记只剩
  // { jsonSchema: ... } 残缺对象，消费端 prepareTools 的 asSchema() 分派会把它当函数
  // 调用直接 TypeError。落盘前必须提取纯数据，恢复端重建成 Schema 对象。
  test("真实 AI SDK Schema 回环：落盘纯数据，重建后可过 asSchema 且内容一致", async () => {
    const rawSchema = { type: "object", properties: { command: { type: "string" } } }
    const schema = jsonSchema(rawSchema as JSONSchema7)
    PromptPin.save({
      sessionID: "ses_real",
      tools: new Map([["bash", { description: "run shell", inputSchema: schema }]]),
      mcpGuide: undefined,
    })
    await PromptPin.flush()
    const pin = PromptPin.load("ses_real")
    expect(pin).toBeDefined()
    // 落盘的是纯 JSON Schema 数据，不是残缺的 { jsonSchema: ... } 包装
    expect(pin!.tools["bash"]!.inputSchema).toEqual(rawSchema)
    // 消费端重建后走 prepareTools 同款 asSchema 路径不抛，且与原始 Schema 数据一致
    const rebuilt = jsonSchema(pin!.tools["bash"]!.inputSchema as JSONSchema7)
    expect(await asSchema(rebuilt).jsonSchema).toEqual(await asSchema(schema).jsonSchema)
  })

  // 261029 Red P2 回归：JSON 语法合法但结构损坏的 pin 必须弃用回退，
  // 不能流到消费端的 Object.entries/overlay 上炸掉冷启动轮
  test("合法 JSON 但结构损坏弃用", async () => {
    await fs.mkdir(pinDir, { recursive: true })
    const write = (name: string, content: unknown) =>
      fs.writeFile(path.join(pinDir, name), JSON.stringify(content), "utf-8")
    const base = { version: 2, savedAt: 0 }
    await write("ses_null.json", { ...base, sessionID: "ses_null", tools: null })
    await write("ses_arr.json", { ...base, sessionID: "ses_arr", tools: [] })
    await write("ses_nodsc.json", {
      ...base,
      sessionID: "ses_nodsc",
      tools: { bash: { inputSchema: { type: "object" } } }, // 缺 description
    })
    await write("ses_nosch.json", { ...base, sessionID: "ses_nosch", tools: { bash: { description: "x" } } }) // 缺 inputSchema
    expect(PromptPin.load("ses_null")).toBeUndefined()
    expect(PromptPin.load("ses_arr")).toBeUndefined()
    expect(PromptPin.load("ses_nodsc")).toBeUndefined()
    expect(PromptPin.load("ses_nosch")).toBeUndefined()
  })

  // 261029 Red v1 格式（残缺 inputSchema）靠版本号整体弃用，不产生双层嵌套 schema
  test("旧版本格式弃用", async () => {
    await fs.mkdir(pinDir, { recursive: true })
    await fs.writeFile(
      path.join(pinDir, "ses_v1.json"),
      JSON.stringify({ version: 1, sessionID: "ses_v1", savedAt: 0, tools: { bash: { description: "x", inputSchema: {} } } }),
      "utf-8",
    )
    expect(PromptPin.load("ses_v1")).toBeUndefined()
  })
})
