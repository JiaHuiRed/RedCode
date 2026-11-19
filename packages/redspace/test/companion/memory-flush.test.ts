import { describe, expect, test } from "bun:test"
import { MAX_ENTRIES, MAX_ENTRY_BYTES, contextText, parse } from "../../src/companion/memory-flush"

const messages = (...texts: (string | undefined)[]) =>
  texts.flatMap((text) => (text ? [{ parts: [{ type: "text", text }] }] : []))

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
    const text = contextText(messages("第一段", "第二段", "第三段"), 12)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(12)
    expect(text).toContain("第三")
  })

  test("skips synthetic parts", () => {
    const text = contextText([{ parts: [{ type: "text", text: "隐藏", synthetic: true }] }])
    expect(text).toBe("")
  })
})
