import { describe, test, expect } from "bun:test"
import { flattenListGroups, itemIndexByKey, type FlatListEntry } from "./list-flat"

const key = (x: string) => x

describe("flattenListGroups", () => {
  test("分组结构按 头→条目→下一组 的顺序摊平，条目携带组内下标与组大小", () => {
    const groups = [
      { category: "A", items: ["a1", "a2"] },
      { category: "B", items: ["b1"] },
    ]

    const entries = flattenListGroups(groups, { key })

    expect(entries.map((e) => e.type)).toEqual(["header", "item", "item", "header", "item"])
    const [headerA, a1, a2, headerB, b1] = entries as FlatListEntry<string>[]
    expect(headerA).toMatchObject({ type: "header", category: "A" })
    expect(headerB).toMatchObject({ type: "header", category: "B" })
    expect(a1).toMatchObject({ type: "item", item: "a1", key: "a1", index: 0, groupSize: 2, lastGroup: false })
    expect(a2).toMatchObject({ type: "item", item: "a2", key: "a2", index: 1, groupSize: 2, lastGroup: false })
    expect(b1).toMatchObject({ type: "item", item: "b1", key: "b1", index: 0, groupSize: 1, lastGroup: true })
  })

  test("add 行只在末尾追加一次，位于所有分组之后", () => {
    const groups = [
      { category: "A", items: ["a1"] },
      { category: "B", items: ["b1"] },
    ]

    const withoutAdd = flattenListGroups(groups, { key })
    expect(withoutAdd.some((e) => e.type === "add")).toBe(false)

    const withAdd = flattenListGroups(groups, { key, add: true })
    expect(withAdd[withAdd.length - 1]).toMatchObject({ type: "add" })
    expect(withAdd.filter((e) => e.type === "add")).toHaveLength(1)
    expect(withAdd[withAdd.length - 2]).toMatchObject({ type: "item", key: "b1" })
  })

  test("空组：有 category 只出头，没 category 什么都不出", () => {
    const entries = flattenListGroups(
      [
        { category: "A", items: [] },
        { category: "", items: [] },
        { category: "B", items: ["b1"] },
      ],
      { key },
    )

    expect(entries).toEqual([
      { type: "header", category: "A", group: { category: "A", items: [] } },
      { type: "header", category: "B", group: { category: "B", items: ["b1"] } },
      { type: "item", item: "b1", key: "b1", index: 0, groupSize: 1, lastGroup: true },
    ] satisfies FlatListEntry<string>[])
  })

  test("无分组无条目时：add=true 只剩 add 行（对应空态只渲染 add 的分支）", () => {
    const entries = flattenListGroups([], { key, add: true })
    expect(entries).toEqual([{ type: "add" }])

    expect(flattenListGroups([], { key })).toEqual([])
  })

  test("key 函数决定条目的 key，虚拟分支用它做 index 映射", () => {
    const groups = [{ category: "A", items: [{ id: "x1" }, { id: "x2" }] }]

    const entries = flattenListGroups(groups, { key: (x: { id: string }) => x.id })

    expect(entries.filter((e) => e.type === "item").map((e) => (e.type === "item" ? e.key : ""))).toEqual(["x1", "x2"])
  })
})

describe("itemIndexByKey（虚拟分支导航映射）", () => {
  test("item key 映射到含 header 占位的扁平 index，header/add 不进映射", () => {
    const entries = flattenListGroups(
      [
        { category: "A", items: ["a1", "a2"] },
        { category: "B", items: ["b1"] },
      ],
      { key, add: true },
    )

    const map = itemIndexByKey(entries)

    expect(map.get("a1")).toBe(1) // 0 是 A 的 header
    expect(map.get("a2")).toBe(2)
    expect(map.get("b1")).toBe(4) // 3 是 B 的 header
    expect(map.size).toBe(3)
  })

  test("空数组给空映射；同 key 重复时后者覆盖", () => {
    expect(itemIndexByKey([]).size).toBe(0)

    const entries = flattenListGroups([{ category: "", items: ["dup", "dup"] }], { key })
    const map = itemIndexByKey(entries)
    expect(map.get("dup")).toBe(1)
    expect(map.size).toBe(1)
  })
})
