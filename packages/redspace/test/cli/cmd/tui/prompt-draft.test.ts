import { describe, expect, test } from "bun:test"
import {
  appendDraftChunk,
  appendDraftText,
  consumeSubmittedDraft,
  sameDraftScope,
  type DraftPart,
} from "../../../../src/cli/cmd/tui/component/prompt/draft"

// 261110 Red 项目切换草稿：异步附件/粘贴在归属变了之后要原样落回原格子，
// 这里直接测真实现（draft.ts），不挂整棵 TUI。判据是恢复时 restoreExtmarksFromParts
// 依赖的三元组：input 里的占位文本 + part.source.text 区间 + 光标位置。

function filePart(mime: string, virtual: string, start: number, end: number): DraftPart {
  return {
    type: "file",
    mime,
    filename: "shot.png",
    url: `data:${mime};base64,AAAA`,
    source: { type: "file", path: "C:/tmp/shot.png", text: { start, end, value: virtual } },
  }
}

describe("prompt draft ownership", () => {
  test("离开项目后提交成功，只清除仍未被改写的原草稿", () => {
    const submitted = appendDraftText(undefined, "sent")
    expect(consumeSubmittedDraft(submitted, submitted)?.prompt).toEqual({ input: "", parts: [] })
    const edited = appendDraftText(submitted, " + new")
    expect(consumeSubmittedDraft(edited, submitted)).toBe(edited)
    expect(consumeSubmittedDraft(undefined, submitted)).toBeUndefined()
  })

  test("sameDraftScope 只认传入值本身（规范化交给 navigation）", () => {
    const a = { directory: "E:\\AI\\RedCode", sessionID: "ses_1" }
    expect(sameDraftScope(a, { directory: "E:\\AI\\RedCode", sessionID: "ses_1" })).toBe(true)
    expect(sameDraftScope(a, { directory: "E:\\AI\\RedCode", sessionID: undefined })).toBe(false)
    expect(sameDraftScope(a, { directory: "D:\\KLX\\CWB", sessionID: "ses_1" })).toBe(false)
  })

  test("空归属追加短文本：一个字也留得住", () => {
    const draft = appendDraftText(undefined, "a")
    expect(draft.prompt.input).toBe("a")
    expect(draft.prompt.parts).toEqual([])
    expect(draft.cursor).toBe(1)
    expect(draft.mode).toBe("normal")

    const next = appendDraftText(draft, "b")
    expect(next.prompt.input).toBe("ab")
    expect(next.cursor).toBe(2)
  })

  test("附件落回原格子：占位符追加在末尾，区间跟着搬", () => {
    const draft = appendDraftChunk(undefined, { virtual: "[Image 1]", part: filePart("image/png", "[Image 1]", 0, 0) })
    expect(draft.prompt.input).toBe("[Image 1] ")
    expect(draft.cursor).toBe(10)
    const part = draft.prompt.parts[0]
    if (part.type !== "file" || !part.source) throw new Error("expected file part")
    expect(part.source.text).toEqual({ start: 0, end: 9, value: "[Image 1]" })
  })

  test("连续追加的第二个附件从第一个占位后开始", () => {
    const first = appendDraftChunk(undefined, { virtual: "[Image 1]", part: filePart("image/png", "[Image 1]", 0, 0) })
    const second = appendDraftChunk(first, {
      virtual: "[Image 2]",
      part: filePart("image/png", "[Image 2]", 0, 0),
    })
    expect(second.prompt.input).toBe("[Image 1] [Image 2] ")
    expect(second.prompt.parts).toHaveLength(2)
    const part = second.prompt.parts[1]
    if (part.type !== "file" || !part.source) throw new Error("expected file part")
    expect(part.source.text).toEqual({ start: 10, end: 19, value: "[Image 2]" })
  })

  test("有内容/有模式的草稿被保留，只追加", () => {
    const base = {
      prompt: {
        input: "draft",
        parts: [
          {
            type: "text" as const,
            text: "pasted",
            source: { text: { start: 0, end: 5, value: "[Pasted]" } },
          },
        ],
      },
      cursor: 2,
      mode: "shell" as const,
    }
    const next = appendDraftChunk(base, { virtual: "[Image 1]", part: filePart("image/png", "[Image 1]", 0, 0) })
    expect(next.prompt.input).toBe("draft[Image 1] ")
    expect(next.prompt.parts).toHaveLength(2)
    expect(next.mode).toBe("shell")
    const added = next.prompt.parts[1]
    if (added.type !== "file" || !added.source) throw new Error("expected file part")
    expect(added.source.text.start).toBe(5)
    expect(added.source.text.end).toBe(14)
    // 原有部件区间不被改动
    const kept = next.prompt.parts[0]
    if (kept.type !== "text" || !kept.source) throw new Error("expected text part")
    expect(kept.source.text).toEqual({ start: 0, end: 5, value: "[Pasted]" })
  })

  test("agent 占位区在 source 顶层，一起搬迁", () => {
    const draft = appendDraftChunk(undefined, {
      virtual: "[agent]",
      part: { type: "agent", name: "build", source: { value: "[agent]", start: 0, end: 7 } },
    })
    const part = draft.prompt.parts[0]
    expect(part.type).toBe("agent")
    expect(part.type === "agent" ? part.source : undefined).toEqual({ value: "[agent]", start: 0, end: 7 })
  })
})
