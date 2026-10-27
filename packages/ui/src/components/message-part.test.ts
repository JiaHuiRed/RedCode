import { describe, expect, test } from "bun:test"
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
