import { describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { SYSTEM_TABS } from "@/context/layout"
import { createSessionTabs } from "./session-layout"

// 261024 Red 自 pages/session/helpers.test.ts 随实现一同迁入。

describe("SYSTEM_TABS", () => {
  test("pins the five fixed tabs", () => {
    expect([...SYSTEM_TABS].sort()).toEqual(["context", "outline", "plan", "review", "status"])
  })

  // 260923 Red C5：strip 按这个顺序渲染（审查 | 上下文 | 轮次 | 计划 | 状态）。
  // Set 本身保序，所以顺序也是契约的一部分，别让人随手改乱。
  test("keeps the documented strip order", () => {
    expect([...SYSTEM_TABS]).toEqual(["review", "context", "outline", "plan", "status"])
  })
})

describe("createSessionTabs", () => {
  test("normalizes the effective file tab", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: ["file://src/a.ts", "context"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: (tab) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
        normalizeTab: (tab) => (tab.startsWith("file://") ? `norm:${tab.slice("file://".length)}` : tab),
      })

      expect(result.activeTab()).toBe("norm:src/a.ts")
      expect(result.activeFileTab()).toBe("norm:src/a.ts")
      expect(result.closableTab()).toBe("norm:src/a.ts")
      dispose()
    })
  })

  test("prefers context and review fallbacks when no file tab is active", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: ["context"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: () => undefined,
        normalizeTab: (tab) => tab,
        review: () => true,
        hasReview: () => true,
      })

      expect(result.activeTab()).toBe("context")
      // 260923 Red C4：Context 成为固定 system tab 后也不再可关闭（此前是唯一例外）
      expect(result.closableTab()).toBeUndefined()
      dispose()
    })

    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: [],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: () => undefined,
        normalizeTab: (tab) => tab,
        review: () => true,
        hasReview: () => true,
      })

      expect(result.activeTab()).toBe("review")
      expect(result.activeFileTab()).toBeUndefined()
      expect(result.closableTab()).toBeUndefined()
      dispose()
    })
  })

  test("keeps status active as the fifth fixed tab", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: "status",
        all: ["status", "context"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: () => undefined,
        normalizeTab: (tab) => tab,
      })

      expect(result.activeTab()).toBe("status")
      expect(result.activeFileTab()).toBeUndefined()
      expect(result.closableTab()).toBeUndefined()
      dispose()
    })
  })

  // 260923 Red C2：五个固定 system tab 都不进 openedTabs（此前 outline 漏网，会被当成
  // 文件标签渲染进 SortableProvider——可拖拽、可关闭，且 strip 上出现两份标签）。
  test("keeps every system tab out of openedTabs", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: "outline" as string | undefined,
        all: ["context", "review", "outline", "plan", "status", "file://src/a.ts"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: (tab) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
        normalizeTab: (tab) => tab,
        review: () => true,
        hasReview: () => true,
      })

      expect(result.openedTabs()).toEqual(["file://src/a.ts"])
      expect(result.activeTab()).toBe("outline")
      expect(result.activeFileTab()).toBeUndefined()
      expect(result.closableTab()).toBeUndefined()
      dispose()
    })
  })

  test("normalizes an old session whose stored tabs still contain outline", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: "outline" as string | undefined,
        all: ["outline", "context"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: () => undefined,
        normalizeTab: (tab) => tab,
      })

      expect(result.openedTabs()).toEqual([])
      expect(result.activeTab()).toBe("outline")
      dispose()
    })
  })
})
