import { describe, expect, test } from "bun:test"
import { fold, type Row } from "@/session/outline"

const row = (id: string, role: string, time = 0): Row => ({ id, time, role })
const text = (pairs: Record<string, string>) => new Map(Object.entries(pairs))

describe("Session outline fold", () => {
  test("一条 user + 它之后的 assistant 折成一轮，轮次从 1 起", () => {
    const info = fold(
      "ses_1",
      [row("u1", "user", 10), row("a1", "assistant", 11), row("u2", "user", 20), row("a2", "assistant", 21)],
      text({ u1: "第一问", a1: "第一答", u2: "第二问", a2: "第二答" }),
    )
    expect(info.entries.map((e) => [e.turn, e.messageID, e.prompt, e.response])).toEqual([
      [1, "u1", "第一问", "第一答"],
      [2, "u2", "第二问", "第二答"],
    ])
    expect(info.entries[0]!.time).toBe(10)
  })

  test("一轮里多条 assistant 时，回答取**最后一条带文字**的", () => {
    const info = fold(
      "ses_1",
      [row("u1", "user"), row("a1", "assistant"), row("a2", "assistant"), row("a3", "assistant")],
      text({ u1: "问", a1: "早期草稿", a3: "定稿" }), // a2 没有文字（比如纯工具调用）
    )
    expect(info.entries).toHaveLength(1)
    expect(info.entries[0]!.response).toBe("定稿")
  })

  test("还没出回答的那一轮，response 是空串而不是缺字段", () => {
    const info = fold("ses_1", [row("u1", "user")], text({ u1: "刚发出去" }))
    expect(info.entries[0]!.response).toBe("")
    expect(info.entries[0]!.responseClipped).toBe(false)
  })

  // 历史被压缩或从中间截断时，第一条可能就是 assistant。它不属于任何轮次，
  // 凭空造一轮会让导航栏出现一条点不动的行（跳转锚点是 user 消息 id）。
  test("没有前导 user 的孤儿 assistant 不造轮次", () => {
    const info = fold("ses_1", [row("a0", "assistant"), row("u1", "user"), row("a1", "assistant")], text({ a0: "孤儿", u1: "问", a1: "答" }))
    expect(info.entries).toHaveLength(1)
    expect(info.entries[0]!.messageID).toBe("u1")
    expect(info.entries[0]!.response).toBe("答")
  })

  test("超预算时截断并置位 clipped，换行折成一行", () => {
    const long = "甲".repeat(200)
    const info = fold("ses_1", [row("u1", "user"), row("a1", "assistant")], text({ u1: `头\n\n  尾`, a1: long }))
    expect(info.entries[0]!.prompt).toBe("头 尾")
    expect(info.entries[0]!.promptClipped).toBe(false)
    expect(info.entries[0]!.responseClipped).toBe(true)
    expect(Array.from(info.entries[0]!.response)).toHaveLength(150)
  })

  // 按码点切，不按 UTF-16 码元：emoji 是代理对，按码元切会留下半个字符。
  test("截断不会切碎代理对", () => {
    const info = fold("ses_1", [row("u1", "user")], text({ u1: "🎯".repeat(100) }))
    expect(Array.from(info.entries[0]!.prompt)).toHaveLength(60)
    expect(info.entries[0]!.prompt).not.toContain("�")
    expect(info.entries[0]!.prompt.endsWith("🎯")).toBe(true)
  })

  test("空会话出空目录，不抛", () => {
    expect(fold("ses_1", [], text({}))).toEqual({ sessionID: "ses_1", entries: [] })
  })
})
