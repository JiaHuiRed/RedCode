import { beforeEach, describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { get, label, record, reset } from "../../src/session/context-snapshot"

const base = {
  sessionID: "ses_context_snapshot",
  providerID: "deepseek",
  modelID: "deepseek-chat",
  system: [] as string[],
  tools: {} as Record<string, unknown>,
  messages: [] as ModelMessage[],
}

beforeEach(() => reset())

describe("context-snapshot.label", () => {
  test("整块包裹的取标签名", () => {
    expect(label("<env>\n  Platform: win32\n</env>")).toBe("env")
  })

  test("剥掉行首的项目符号与 markdown 记号", () => {
    expect(label("▸ WORK RULES (CORE):\n 1. READ CODE FIRST")).toBe("WORK RULES (CORE):")
    expect(label("## AGENTS.md\nbody")).toBe("AGENTS.md")
  })

  test("首行过长时截断并留省略号", () => {
    const long = label("x".repeat(200))
    expect(long.length).toBe(48)
    expect(long.endsWith("…")).toBe(true)
  })

  test("空段不返回空字符串", () => {
    expect(label("   \n\n")).toBe("(empty)")
  })
})

describe("context-snapshot.record", () => {
  test("三块分别计数，total 是三者之和", () => {
    const snapshot = record({
      ...base,
      system: ["a".repeat(400)],
      tools: { read: { description: "b".repeat(400) } },
      messages: [{ role: "user", content: "c".repeat(400) }],
    })
    expect(snapshot.system.tokens).toBe(100)
    expect(snapshot.messages.tokens).toBe(100)
    expect(snapshot.tools.tokens).toBeGreaterThan(100)
    expect(snapshot.total).toBe(snapshot.system.tokens + snapshot.tools.tokens + snapshot.messages.tokens)
  })

  test("system 段按大小降序，空段被剔除", () => {
    const snapshot = record({
      ...base,
      system: ["<small>", "▸ BIG BLOCK\n" + "x".repeat(1000), ""],
    })
    expect(snapshot.system.segments.map((s) => s.label)).toEqual(["BIG BLOCK", "small"])
  })

  test("工具按 schema 成本降序，只留最贵的 8 个", () => {
    const tools: Record<string, unknown> = { cheap: { description: "x" } }
    for (let i = 0; i < 10; i++) tools[`big${i}`] = { description: "y".repeat(100 * (i + 1)) }
    const snapshot = record({ ...base, tools })
    expect(snapshot.tools.count).toBe(11)
    expect(snapshot.tools.top).toHaveLength(8)
    expect(snapshot.tools.top[0]!.label).toBe("big9")
    expect(snapshot.tools.top.at(-1)!.label).not.toBe("cheap")
  })

  test("消息按角色归并，同角色多条累加", () => {
    const snapshot = record({
      ...base,
      messages: [
        { role: "user", content: "a".repeat(40) },
        { role: "assistant", content: "b".repeat(400) },
        { role: "user", content: "c".repeat(40) },
      ],
    })
    expect(snapshot.messages.count).toBe(3)
    expect(snapshot.messages.byRole.map((r) => r.label)).toEqual(["assistant", "user"])
    expect(snapshot.messages.byRole.find((r) => r.label === "user")!.tokens).toBe(20)
  })

  test("非字符串 content（工具调用/结果）按序列化后的长度算", () => {
    const snapshot = record({
      ...base,
      messages: [
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "c1",
              toolName: "read",
              output: { type: "text", value: "z".repeat(400) },
            },
          ],
        } as ModelMessage,
      ],
    })
    expect(snapshot.messages.tokens).toBeGreaterThan(100)
  })

  test("get 取回最后一次快照，按 sessionID 隔离", () => {
    record({ ...base, system: ["a".repeat(40)] })
    record({ ...base, sessionID: "ses_other", system: ["b".repeat(4000)] })
    expect(get(base.sessionID)!.total).toBe(10)
    expect(get("ses_other")!.total).toBe(1000)
    expect(get("ses_missing")).toBeUndefined()
  })

  test("同一会话再记一次就覆盖——快照是「现在装了什么」，不是历史", () => {
    record({ ...base, system: ["a".repeat(4000)] })
    record({ ...base, system: ["a".repeat(40)] })
    expect(get(base.sessionID)!.total).toBe(10)
  })

  // 稳态成本的来源：钉死的前缀每轮是同一批对象引用（prompt.ts 的 stabilizedMsgs 直接
  // 展开缓存数组），按引用记忆后只算新增的那几条。这里验的是「同一对象不重算」这个前提。
  test("同一条消息对象重复出现时复用已算的 token 数", () => {
    const pinned: ModelMessage = { role: "user", content: "a".repeat(400) }
    const first = record({ ...base, messages: [pinned] })
    const second = record({ ...base, messages: [pinned, { role: "assistant", content: "b".repeat(400) }] })
    expect(first.messages.tokens).toBe(100)
    expect(second.messages.tokens).toBe(200)
  })

  test("空输入不报错，total 为 0", () => {
    const snapshot = record({ ...base })
    expect(snapshot.total).toBe(0)
    expect(snapshot.system.segments).toEqual([])
    expect(snapshot.tools.top).toEqual([])
    expect(snapshot.messages.byRole).toEqual([])
  })
})

// 260828 cc：用量面板的"messages 占多少"曾被一张截图完全带偏 —— 图片在 ModelMessage
// 里是内联 data URL，chars/4 把 400KB 的 JPEG 记成约 13 万 token。
describe("context-snapshot 图片计价", () => {
  const imageMessage = (bytes: number): ModelMessage => ({
    role: "user",
    content: [
      { type: "text", text: "看这张图" },
      { type: "file", mediaType: "image/jpeg", data: `data:image/jpeg;base64,${"A".repeat(bytes)}` },
    ],
  })

  test("一张图不再按 base64 长度计入 messages", () => {
    const info = record({ ...base, messages: [imageMessage(200 * 1024)] })
    expect(info.messages.tokens).toBeLessThan(1000)
    expect(info.messages.tokens).toBeGreaterThanOrEqual(384)
  })

  test("图片载荷变大不改变记账", () => {
    const small = record({ ...base, messages: [imageMessage(10 * 1024)] }).messages.tokens
    reset()
    const large = record({ ...base, messages: [imageMessage(256 * 1024)] }).messages.tokens
    expect(large).toBe(small)
  })

  test("纯文本消息的记账不受影响", () => {
    const info = record({
      ...base,
      messages: [{ role: "user", content: "hello world" } as ModelMessage],
    })
    expect(info.messages.tokens).toBe(3)
  })
})
