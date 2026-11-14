import { describe, expect, test } from "bun:test"
import { filterCannedAgreement as clean } from "../../src/util/canned-agreement"

describe("assistant display: canned assent only", () => {
  test.each([
    ["你说得对。是我把条件写反了。", "是我把条件写反了。"],
    ["哥哥，你说得对，我认。遗漏的是首次打开的状态。", "哥哥，遗漏的是首次打开的状态。"],
    ["哥哥说的对，我认。", ""],
    ["我认，来源弄错了。", "来源弄错了。"],
    ["你说的对，已经修复。", "已经修复。"],
    ["你说得对", ""],
    ["我认", ""],
  ])("removes standalone formula in %s", (raw, expected) => {
    expect(clean(raw)).toBe(expected)
  })

  test.each([
    "对不起，是我弄错了。",
    "哥哥，改动漏掉了一个分支，我补上。",
    "我认错了，抱歉。",
    "我认识这个问题。",
    "我认定这个方案有风险。",
    "如果你说得对，我们再看数据。",
    "你说得对吗？这还没有证据。",
    "这段代码写着 `你说得对`，请检查。",
    "“你说得对”是讨厌的口头禅。",
    "「我认」不是成熟的道歉。",
    "> 你说得对，这是用户原话。",
    "    你说得对",
    "```markdown\n你说得对\n我认\n```",
    "“原文是：\n你说得对\n我认”",
  ])("preserves legitimate prose and quoted text: %s", (raw) => {
    expect(clean(raw)).toBe(raw)
  })

  test("works on cumulative streaming chunks", () => {
    const frames = ["你", "你说", "你说得", "你说得对", "你说得对。", "你说得对。这里是我改错了。"]
    expect(frames.map(clean)).toEqual(["你", "你说", "你说得", "", "", "这里是我改错了。"])
  })

  test("never modifies stored input and is idempotent", () => {
    const raw = "哥哥，你说得对，我认。这里是我改错了。"
    const copy = raw
    const filtered = clean(raw)
    expect(raw).toBe(copy)
    expect(clean(filtered)).toBe(filtered)
  })
})
