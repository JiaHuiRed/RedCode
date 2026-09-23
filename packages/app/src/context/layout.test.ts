import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import {
  DEFAULT_SESSION_TABS,
  createSessionKeyReader,
  ensureSessionKey,
  nextSessionTabsForOpen,
  pruneSessionKeys,
  sessionTabsForOpen,
} from "./layout"

describe("layout session-key helpers", () => {
  test("couples touch and scroll seed in order", () => {
    const calls: string[] = []
    const result = ensureSessionKey(
      "dir/a",
      (key) => calls.push(`touch:${key}`),
      (key) => calls.push(`seed:${key}`),
    )

    expect(result).toBe("dir/a")
    expect(calls).toEqual(["touch:dir/a", "seed:dir/a"])
  })

  test("reads dynamic accessor keys lazily", () => {
    const seen: string[] = []

    createRoot((dispose) => {
      const [key, setKey] = createSignal("dir/one")
      const read = createSessionKeyReader(key, (value) => seen.push(value))

      expect(read()).toBe("dir/one")
      setKey("dir/two")
      expect(read()).toBe("dir/two")

      dispose()
    })

    expect(seen).toEqual(["dir/one", "dir/two"])
  })
})

describe("pruneSessionKeys", () => {
  test("keeps active key and drops lowest-used keys", () => {
    const drop = pruneSessionKeys({
      keep: "k4",
      max: 3,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
        ["k3", 3],
        ["k4", 4],
      ]),
      view: ["k1", "k2", "k4"],
      tabs: ["k1", "k3", "k4"],
    })

    expect(drop).toEqual(["k1"])
    expect(drop.includes("k4")).toBe(false)
  })

  test("does not prune without keep key", () => {
    const drop = pruneSessionKeys({
      keep: undefined,
      max: 1,
      used: new Map([
        ["k1", 1],
        ["k2", 2],
      ]),
      view: ["k1"],
      tabs: ["k2"],
    })

    expect(drop).toEqual([])
  })
})

// 260923 Red C1：sessionTabs 的 getter 虚拟默认与写入路径 seed 共用 DEFAULT_SESSION_TABS。
// 回归场景：store.sessionTabs[session] 还是 undefined 时 tabs().open("outline")——
// 修复前 nextSessionTabsForOpen 从 current?.all ?? [] 出发得到 ["outline"]，虚拟默认里的
// context 被丢掉，contextOpen() 转 false，Context 入口整个卸载。
describe("DEFAULT_SESSION_TABS", () => {
  test("carries an explicit active tab so the virtual default matches the seeded store", () => {
    expect(DEFAULT_SESSION_TABS.all).toEqual(["context"])
    expect(DEFAULT_SESSION_TABS.active).toBe("context")
  })

  test("opening outline from the default keeps context in the tab list", () => {
    const next = nextSessionTabsForOpen(DEFAULT_SESSION_TABS, "outline")

    expect(next.all).toEqual(["context", "outline"])
    expect(next.active).toBe("outline")
    expect(next.all.includes("context")).toBe(true)
  })

  test("tabs().open from a store without sessionTabs seeds context instead of dropping it", () => {
    const next = sessionTabsForOpen(undefined, "outline")

    expect(next.all).toEqual(["context", "outline"])
    expect(next.active).toBe("outline")
    expect(next.all.includes("context")).toBe(true)
  })

  test("tabs().open still appends to an existing tab list", () => {
    const next = sessionTabsForOpen({ all: ["context", "outline"], active: "outline" }, "plan")

    expect(next.all).toEqual(["context", "outline", "plan"])
    expect(next.active).toBe("plan")
  })

  test("opening context from the default keeps it first and active", () => {
    const next = nextSessionTabsForOpen(DEFAULT_SESSION_TABS, "context")

    expect(next.all).toEqual(["context"])
    expect(next.active).toBe("context")
  })

  test("review stays out of the persisted list", () => {
    const next = nextSessionTabsForOpen(DEFAULT_SESSION_TABS, "review")

    expect(next.all).toEqual(["context"])
    expect(next.all.includes("review")).toBe(false)
    expect(next.active).toBe("review")
  })
})
