import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
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
})
