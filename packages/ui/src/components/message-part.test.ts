import { describe, expect, test } from "bun:test"
import { groupParts } from "./message-part-groups"
import { readPartText } from "./message-part-text"
import { viewSections } from "./basic-tool"
import { countTurnToolCalls } from "./turn-tool-count"

test("generic tool falls back when no section is renderable", () => {
  expect(viewSections({ view: { sections: [{ type: "custom" }, null, { type: "text" }] } })).toEqual([])
  const text = { type: "text", text: "details" }
  expect(viewSections({ view: { sections: [{ type: "custom" }, text] } })).toEqual([text])
})

test("counts this turn's tool calls across assistant messages", () => {
  const messages = [
    { id: "u1", role: "user", time: { created: 1 } },
    { id: "a1", role: "assistant", parentID: "u1", time: { created: 2 } },
    { id: "a2", role: "assistant", parentID: "u1", time: { created: 3 } },
    { id: "other", role: "assistant", parentID: "u2", time: { created: 3 } },
    { id: "later", role: "assistant", parentID: "u1", time: { created: 5 } },
  ]
  const parts = {
    a1: [
      { type: "tool", callID: "same" },
      { type: "tool", callID: "same" },
      { type: "tool", callID: "other" },
      { type: "text" },
    ],
    a2: [{ type: "tool", callID: "same" }],
    other: [{ type: "tool", callID: "unrelated" }],
    later: [{ type: "tool", callID: "later" }],
  }
  expect(countTurnToolCalls(messages as never, parts as never, "u1", 4)).toBe(3)
  expect(countTurnToolCalls(messages as never, parts as never, "u2", 4)).toBe(1)
  expect(countTurnToolCalls(messages as never, parts as never, "missing", 4)).toBe(0)
})

describe("readPartText", () => {
  test("returns empty string when accum is undefined and part text is undefined", () => {
    expect(readPartText(undefined, { id: "part_1" })).toBe("")
  })

  test("returns trimmed part text when accum is undefined", () => {
    expect(readPartText(undefined, { id: "part_1", text: "  hello  " })).toBe("hello")
  })

  test("prefers accum value over part text when accum has a hit", () => {
    expect(readPartText({ part_1: "  from accum  " }, { id: "part_1", text: "from part" })).toBe("from accum")
  })

  test("falls back to part text when accum misses", () => {
    expect(readPartText({ other_part: "ignored" }, { id: "part_1", text: "  from part  " })).toBe("from part")
  })

  test("returns empty string for whitespace-only text", () => {
    expect(readPartText(undefined, { id: "part_1", text: "   \n\t  " })).toBe("")
  })

  test("trims leading and trailing whitespace", () => {
    expect(readPartText(undefined, { id: "part_1", text: "\n  body  \n" })).toBe("body")
  })
})

// 261115 Red A-UX-03：探索 / 修改 / 命令分段折叠。连续同类才合并，跨类各自成组；
// 组键保留「类型:首 part id」，时间线按 key 做活动组判断与 DOM 复用。
describe("groupParts", () => {
  const tool = (id: string, name: string, status: "completed" | "error" = "completed") =>
    ({ type: "tool", id, tool: name, state: { status, input: {} } }) as never
  const text = (id: string) => ({ type: "text", id, text: "body" }) as never
  const wrap = (parts: unknown[]) => parts.map((part, index) => ({ messageID: "m1", part })) as never

  test("merges consecutive exploration tools into one context group", () => {
    const groups = groupParts(wrap([tool("a", "read"), tool("b", "grep"), tool("c", "list")]))
    expect(groups).toHaveLength(1)
    expect(groups[0]?.type).toBe("context")
    expect(groups[0]?.key).toBe("context:a")
    expect(groups[0]?.type === "part" ? [] : groups[0]?.refs.map((ref) => ref.partID)).toEqual(["a", "b", "c"])
  })

  test("splits edit tools into their own group between context runs", () => {
    const groups = groupParts(wrap([tool("a", "read"), tool("b", "edit"), tool("c", "write")]))
    expect(groups.map((group) => group.type)).toEqual(["context", "edit"])
    expect(groups[1]?.key).toBe("edit:b")
  })

  test("groups shell calls as command and keeps later context separate", () => {
    const groups = groupParts(wrap([tool("a", "shell"), tool("b", "read")]))
    expect(groups.map((group) => group.type)).toEqual(["command", "context"])
    expect(groups[0]?.key).toBe("command:a")
  })

  test("text parts break groups and stay as single part rows", () => {
    const groups = groupParts(wrap([tool("a", "read"), text("t1"), tool("b", "read"), tool("c", "edit")]))
    expect(groups.map((group) => group.type)).toEqual(["context", "part", "context", "edit"])
    expect(groups[1]?.key).toBe("part:m1:t1")
  })

  test("error state does not change grouping", () => {
    const groups = groupParts(wrap([tool("a", "edit", "error"), tool("b", "edit")]))
    expect(groups).toHaveLength(1)
    expect(groups[0]?.type).toBe("edit")
  })
})
