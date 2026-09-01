import { describe, expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import {
  canNavigateHistoryAtCursor,
  clonePromptParts,
  normalizePromptHistoryEntry,
  navigatePromptHistory,
  prependHistoryEntry,
  promptLength,
  type PromptHistoryComment,
  serializePromptHistory,
  stripPromptHistoryImages,
} from "./history"

const DEFAULT_PROMPT: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]

const text = (value: string): Prompt => [{ type: "text", content: value, start: 0, end: value.length }]
const comment = (id: string, value = "note"): PromptHistoryComment => ({
  id,
  path: "src/a.ts",
  selection: { start: 2, end: 4 },
  comment: value,
  time: 1,
  origin: "review",
  preview: "const a = 1",
})

describe("prompt-input history", () => {
  test("prependHistoryEntry skips empty prompt and deduplicates consecutive entries", () => {
    const first = prependHistoryEntry([], DEFAULT_PROMPT)
    expect(first).toEqual([])

    const commentsOnly = prependHistoryEntry([], DEFAULT_PROMPT, [comment("c1")])
    expect(commentsOnly).toHaveLength(1)

    const withOne = prependHistoryEntry([], text("hello"))
    expect(withOne).toHaveLength(1)

    const deduped = prependHistoryEntry(withOne, text("hello"))
    expect(deduped).toBe(withOne)

    const dedupedComments = prependHistoryEntry(commentsOnly, DEFAULT_PROMPT, [comment("c1")])
    expect(dedupedComments).toBe(commentsOnly)
  })

  test("navigatePromptHistory restores saved prompt when moving down from newest", () => {
    const entries = [text("third"), text("second"), text("first")]
    const up = navigatePromptHistory({
      direction: "up",
      entries,
      historyIndex: -1,
      currentPrompt: text("draft"),
      currentComments: [comment("draft")],
      savedPrompt: null,
    })
    expect(up.handled).toBe(true)
    if (!up.handled) throw new Error("expected handled")
    expect(up.historyIndex).toBe(0)
    expect(up.cursor).toBe("start")
    expect(up.entry.comments).toEqual([])

    const down = navigatePromptHistory({
      direction: "down",
      entries,
      historyIndex: up.historyIndex,
      currentPrompt: text("ignored"),
      currentComments: [],
      savedPrompt: up.savedPrompt,
    })
    expect(down.handled).toBe(true)
    if (!down.handled) throw new Error("expected handled")
    expect(down.historyIndex).toBe(-1)
    expect(down.entry.prompt[0]?.type === "text" ? down.entry.prompt[0].content : "").toBe("draft")
    expect(down.entry.comments).toEqual([comment("draft")])
  })

  test("navigatePromptHistory keeps entry comments when moving through history", () => {
    const entries = [
      {
        prompt: text("with comment"),
        comments: [comment("c1")],
      },
    ]

    const up = navigatePromptHistory({
      direction: "up",
      entries,
      historyIndex: -1,
      currentPrompt: text("draft"),
      currentComments: [],
      savedPrompt: null,
    })

    expect(up.handled).toBe(true)
    if (!up.handled) throw new Error("expected handled")
    expect(up.entry.prompt[0]?.type === "text" ? up.entry.prompt[0].content : "").toBe("with comment")
    expect(up.entry.comments).toEqual([comment("c1")])
  })

  test("normalizePromptHistoryEntry supports legacy prompt arrays", () => {
    const entry = normalizePromptHistoryEntry(text("legacy"))
    expect(entry.prompt[0]?.type === "text" ? entry.prompt[0].content : "").toBe("legacy")
    expect(entry.comments).toEqual([])
  })

  test("helpers clone prompt and count text content length", () => {
    const original: Prompt = [
      { type: "text", content: "one", start: 0, end: 3 },
      {
        type: "file",
        path: "src/a.ts",
        content: "@src/a.ts",
        start: 3,
        end: 12,
        selection: { startLine: 1, startChar: 1, endLine: 2, endChar: 1 },
      },
      { type: "image", id: "1", filename: "img.png", mime: "image/png", dataUrl: "data:image/png;base64,abc" },
    ]
    const copy = clonePromptParts(original)
    expect(copy).not.toBe(original)
    expect(promptLength(copy)).toBe(12)
    if (copy[1]?.type !== "file") throw new Error("expected file")
    copy[1].selection!.startLine = 9
    if (original[1]?.type !== "file") throw new Error("expected file")
    expect(original[1].selection?.startLine).toBe(1)
  })

  test("canNavigateHistoryAtCursor only allows prompt boundaries", () => {
    const value = "a\nb\nc"

    expect(canNavigateHistoryAtCursor("up", value, 0)).toBe(false)
    expect(canNavigateHistoryAtCursor("down", value, 0)).toBe(false)

    expect(canNavigateHistoryAtCursor("up", value, 2)).toBe(false)
    expect(canNavigateHistoryAtCursor("down", value, 2)).toBe(false)

    expect(canNavigateHistoryAtCursor("up", value, 5)).toBe(false)
    expect(canNavigateHistoryAtCursor("down", value, 5)).toBe(true)

    expect(canNavigateHistoryAtCursor("up", "abc", 0)).toBe(false)
    expect(canNavigateHistoryAtCursor("down", "abc", 3)).toBe(true)
    expect(canNavigateHistoryAtCursor("up", "abc", 1)).toBe(false)
    expect(canNavigateHistoryAtCursor("down", "abc", 1)).toBe(false)

    expect(canNavigateHistoryAtCursor("up", "", 0)).toBe(true)
    expect(canNavigateHistoryAtCursor("down", "", 0)).toBe(true)

    expect(canNavigateHistoryAtCursor("up", "abc", 0, true)).toBe(true)
    expect(canNavigateHistoryAtCursor("up", "abc", 3, true)).toBe(true)
    expect(canNavigateHistoryAtCursor("down", "abc", 0, true)).toBe(true)
    expect(canNavigateHistoryAtCursor("down", "abc", 3, true)).toBe(true)
    expect(canNavigateHistoryAtCursor("up", "abc", 1, true)).toBe(false)
    expect(canNavigateHistoryAtCursor("down", "abc", 1, true)).toBe(false)
  })
})

// 260901 cc 这条钉住的是「落盘不带 base64」。它有两个特别之处值得单测：
//   ① migrate 走的是读路径，persist.ts:228 会把 migrate 的结果写回磁盘 —— 也就是说
//      这个函数一旦写错，会**就地改坏他磁盘上的历史**，不是显示层的错而已；
//   ② 同一个函数同时当 serialize 用，所以必须是幂等的。
describe("stripPromptHistoryImages", () => {
  const img = (id: string) => ({
    type: "image" as const,
    id,
    filename: `${id}.png`,
    mime: "image/png",
    dataUrl: "data:image/png;base64,AAAA",
  })

  test("剔掉 image part，保留文字", () => {
    const out = stripPromptHistoryImages({ entries: [[...text("hi"), img("a")]] }) as { entries: Prompt[] }
    expect(out.entries[0]).toEqual(text("hi"))
  })

  test("PDF 附件也走 type image，一并剔掉", () => {
    const pdf = { ...img("p"), mime: "application/pdf", dataUrl: "data:application/pdf;base64,BBBB" }
    const out = stripPromptHistoryImages({ entries: [[...text("看这个"), pdf]] }) as { entries: Prompt[] }
    expect(JSON.stringify(out)).not.toContain("base64")
  })

  test("{prompt, comments} 形态的条目同样处理，comments 不动", () => {
    const entry = { prompt: [...text("hi"), img("a")], comments: [comment("c1")] }
    const out = stripPromptHistoryImages({ entries: [entry] }) as {
      entries: { prompt: Prompt; comments: PromptHistoryComment[] }[]
    }
    expect(out.entries[0].prompt).toEqual(text("hi"))
    expect(out.entries[0].comments).toEqual([comment("c1")])
  })

  test("只发了一张图的条目整条丢掉——剔完没有可回溯内容", () => {
    const out = stripPromptHistoryImages({ entries: [[...DEFAULT_PROMPT, img("a")], text("keep")] }) as {
      entries: Prompt[]
    }
    expect(out.entries).toEqual([text("keep")])
  })

  test("幂等：serialize 会反复作用在同一份数据上", () => {
    const once = stripPromptHistoryImages({ entries: [[...text("hi"), img("a")]] })
    expect(stripPromptHistoryImages(once)).toEqual(once)
  })

  test("形状不认识就原样返回，不吞数据", () => {
    expect(stripPromptHistoryImages({ entries: "nope" })).toEqual({ entries: "nope" })
    expect(stripPromptHistoryImages(undefined)).toBeUndefined()
  })

  test("serializePromptHistory 出的是剔干净的 JSON", () => {
    const json = serializePromptHistory({ entries: [[...text("hi"), img("a")]] })
    expect(json).not.toContain("base64")
    expect(JSON.parse(json)).toEqual({ entries: [text("hi")] })
  })
})
