import { describe, expect, test } from "bun:test"
import { createOpenReviewFile, createOpenSessionFileTab, getTabReorderIndex } from "./helpers"

// 261024 Red focusTerminalById / shouldFocusTerminalOnKeyDown 随实现迁到
// @/utils/terminal-focus.test.ts；createSessionTabs / SYSTEM_TABS 迁到
// @/context/session-layout.test.ts。本文件只测留在 pages 层的胶水。

describe("createOpenReviewFile", () => {
  test("opens and loads selected review file", () => {
    const calls: string[] = []
    const openReviewFile = createOpenReviewFile({
      showAllFiles: () => calls.push("show"),
      tabForPath: (path) => {
        calls.push(`tab:${path}`)
        return `file://${path}`
      },
      openTab: (tab) => calls.push(`open:${tab}`),
      setActive: (tab) => calls.push(`active:${tab}`),
      loadFile: (path) => calls.push(`load:${path}`),
    })

    openReviewFile("src/a.ts")

    expect(calls).toEqual(["show", "tab:src/a.ts", "open:file://src/a.ts", "active:file://src/a.ts", "load:src/a.ts"])
  })

  // 261115 Red UX-18 复审：已打开的常驻标签不能因为从 Diff 再打开一次就被标成预览
  // （否则下一次一次性浏览会把常驻标签关掉）；新标签才进预览槽。
  test("keeps an already-open tab resident instead of marking it preview", () => {
    const previewed: (string | undefined)[] = []
    const openReviewFile = createOpenReviewFile({
      showAllFiles: () => {},
      tabForPath: (path) => `file://${path}`,
      openTab: () => {},
      setActive: () => {},
      loadFile: () => {},
      previewTab: () => undefined,
      setPreviewTab: (tab) => previewed.push(tab),
      isTabOpen: (tab) => tab === "file://src/a.ts",
    })

    openReviewFile("src/a.ts")

    expect(previewed).toEqual([])
  })

  test("marks a fresh tab as the preview slot", () => {
    const previewed: (string | undefined)[] = []
    const openReviewFile = createOpenReviewFile({
      showAllFiles: () => {},
      tabForPath: (path) => `file://${path}`,
      openTab: () => {},
      setActive: () => {},
      loadFile: () => {},
      previewTab: () => undefined,
      setPreviewTab: (tab) => previewed.push(tab),
      isTabOpen: () => false,
    })

    openReviewFile("src/a.ts")

    expect(previewed).toEqual(["file://src/a.ts"])
  })
})

describe("createOpenSessionFileTab", () => {
  test("activates the opened file tab", () => {
    const calls: string[] = []
    const openTab = createOpenSessionFileTab({
      normalizeTab: (value) => {
        calls.push(`normalize:${value}`)
        return `file://${value}`
      },
      openTab: (tab) => calls.push(`open:${tab}`),
      pathFromTab: (tab) => {
        calls.push(`path:${tab}`)
        return tab.slice("file://".length)
      },
      loadFile: (path) => calls.push(`load:${path}`),
      openReviewPanel: () => calls.push("review"),
      setActive: (tab) => calls.push(`active:${tab}`),
    })

    openTab("src/a.ts")

    expect(calls).toEqual([
      "normalize:src/a.ts",
      "open:file://src/a.ts",
      "path:file://src/a.ts",
      "load:src/a.ts",
      "review",
      "active:file://src/a.ts",
    ])
  })
})

describe("getTabReorderIndex", () => {
  test("returns target index for valid drag reorder", () => {
    expect(getTabReorderIndex(["a", "b", "c"], "a", "c")).toBe(2)
  })

  test("returns undefined for unknown droppable id", () => {
    expect(getTabReorderIndex(["a", "b", "c"], "a", "missing")).toBeUndefined()
  })
})
