import { describe, expect, test } from "bun:test"
import { MAX_ENTRIES, MAX_ENTRY_BYTES, context, parse } from "../../src/companion/memory-flush"
import { MessageID } from "../../src/session/schema"

const message = (id: string, text: string) => ({
  info: { role: "user" as const, id: MessageID.make(id), time: { created: 1000 } },
  parts: [{ type: "text", text }],
})

describe("memory flush parse", () => {
  test("reads entries as strings or objects", () => {
    const raw = JSON.stringify({ entries: ["记得他怕冷", { text: "下周三复诊" }] })
    expect(parse(raw)).toEqual(["记得他怕冷", "下周三复诊"])
  })

  test("accepts a fenced json block", () => {
    expect(parse("```json\n" + JSON.stringify({ entries: ["一条"] }) + "\n```")).toEqual(["一条"])
  })

  test("caps the entry count and bytes", () => {
    const raw = JSON.stringify({ entries: Array.from({ length: 10 }, () => "你".repeat(2000)) })
    const entries = parse(raw)
    expect(entries).toHaveLength(MAX_ENTRIES)
    for (const entry of entries) expect(Buffer.byteLength(entry)).toBeLessThanOrEqual(MAX_ENTRY_BYTES)
  })

  test("returns empty on bad json", () => {
    expect(parse("not json")).toEqual([])
  })
})

describe("memory flush context", () => {
  test("keeps the most recent text within the byte budget", () => {
    const { text } = context([message("msg_first", "第一段"), message("msg_recent", '第三段\n"'.repeat(30))], 140)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(140)
    expect(text).not.toContain("第一段")
    expect(JSON.parse(text)).toMatchObject({ messageID: "msg_recent", role: "user" })
    expect(JSON.parse(text).text).toStartWith('第三段\n"')
  })

  test("preserves original speaker, message ID and time and distinguishes summaries", () => {
    const user = message("msg_user", "我不喜欢跑步")
    const assistant = message("msg_assistant", "我喜欢跑步")
    const summary = message("msg_summary", "曾提到跑步")
    const { text } = context([
      user,
      { ...assistant, info: { ...assistant.info, role: "assistant", time: { created: 2000 } } },
      { ...summary, info: { ...summary.info, role: "assistant", summary: true, time: { created: 3000 } } },
    ])
    expect(text.split("\n").map((line) => JSON.parse(line))).toEqual([
      { role: "user", messageID: "msg_user", createdAt: 1000, text: "我不喜欢跑步" },
      { role: "assistant", messageID: "msg_assistant", createdAt: 2000, text: "我喜欢跑步" },
      { role: "summary", messageID: "msg_summary", createdAt: 3000, text: "曾提到跑步" },
    ])
  })

  test("skips queued messages and synthetic or ignored parts", () => {
    const user = message("msg_user", "未投递")
    const { text } = context([
      { ...user, info: { ...user.info, delivery: "queued" } },
      { ...user, parts: [{ type: "text", text: "隐藏", synthetic: true }, { type: "text", text: "忽略", ignored: true }] },
    ])
    expect(text).toBe("")
  })
})
