import { describe, expect, test } from "bun:test"
import { extractPartialJsonString } from "../../src/cli/cmd/tui/util/partial-json-string"

describe("util.extractPartialJsonString", () => {
  test("complete value", () => {
    const raw = `{"filePath":"docs/a.md","content":"# Title\\n\\nbody"}`
    const parsed = extractPartialJsonString(raw, "content")
    expect(parsed).toEqual({ value: "# Title\n\nbody", complete: true })
  })

  test("truncated mid-string returns partial", () => {
    const raw = `{"filePath":"docs/a.md","content":"# Title\\n## Section\\n- item`
    const parsed = extractPartialJsonString(raw, "content")
    expect(parsed).toEqual({ value: "# Title\n## Section\n- item", complete: false })
  })

  test("truncated mid simple escape drops the dangling escape only", () => {
    const raw = `{"content":"line1\\nline2\\`
    const parsed = extractPartialJsonString(raw, "content")
    expect(parsed).toEqual({ value: "line1\nline2", complete: false })
  })

  test("truncated mid unicode escape drops the dangling escape only", () => {
    const raw = `{"content":"ok\\u4f60\\u0`
    const parsed = extractPartialJsonString(raw, "content")
    expect(parsed).toEqual({ value: "ok你", complete: false })
  })

  test("escaped quotes and backslashes decode", () => {
    const raw = `{"content":"a \\"quoted\\" \\\\ path"}`
    const parsed = extractPartialJsonString(raw, "content")
    expect(parsed).toEqual({ value: `a "quoted" \\ path`, complete: true })
  })

  test("missing key returns undefined", () => {
    expect(extractPartialJsonString(`{"filePath":"a.md"}`, "content")).toBeUndefined()
  })

  test("empty raw returns undefined", () => {
    expect(extractPartialJsonString("", "content")).toBeUndefined()
  })

  test("key arrived but value not opened yet returns undefined", () => {
    expect(extractPartialJsonString(`{"content":`, "content")).toBeUndefined()
    expect(extractPartialJsonString(`{"content":"`, "content")).toEqual({ value: "", complete: false })
  })

  test("non-string value returns undefined", () => {
    expect(extractPartialJsonString(`{"content":123}`, "content")).toBeUndefined()
  })

  test("first occurrence wins: key text inside content does not confuse the scan", () => {
    const raw = `{"filePath":"x","content":"json body {\\"content\\": \\"nested\\"} done"}`
    const parsed = extractPartialJsonString(raw, "content")
    expect(parsed).toEqual({ value: `json body {"content": "nested"} done`, complete: true })
  })

  test("streaming growth: value grows as raw accumulates", () => {
    const chunks = [`{"filePath"`, `:"a.md","cont`, `ent":"# H`, `ello\\nWor`, `ld"}`]
    let raw = ""
    const seen: string[] = []
    for (const chunk of chunks) {
      raw += chunk
      const parsed = extractPartialJsonString(raw, "content")
      seen.push(parsed?.value ?? "")
    }
    expect(seen).toEqual(["", "", "# H", "# Hello\nWor", "# Hello\nWorld"])
  })
})
