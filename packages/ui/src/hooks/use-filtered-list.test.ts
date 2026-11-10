import { describe, test, expect } from "bun:test"
import { createRoot } from "solid-js"
import { useFilteredList } from "./use-filtered-list"

/** hook 不渲染 DOM，Enter 分支只读这几个字段，够用。 */
const enterEvent = () => ({ key: "Enter", isComposing: false, preventDefault: () => {} }) as unknown as KeyboardEvent

/** 让 solid 的 resource 把该跑的微任务跑完。 */
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe("useFilteredList 的 Enter 闸门", () => {
  test("新查询在途时 Enter 不选中陈旧行，settle 之后才选", async () => {
    let releaseSearch: (rows: string[]) => void = () => {}
    const picked: (string | undefined)[] = []

    let api!: ReturnType<typeof useFilteredList<string>>
    const dispose = createRoot((dispose) => {
      api = useFilteredList<string>({
        items: (filter) =>
          filter === ""
            ? ["seed-alpha"]
            : new Promise<string[]>((resolve) => {
                releaseSearch = resolve
              }),
        key: (x) => x,
        onSelect: (value) => picked.push(value),
      })
      return dispose
    })

    await settle()
    expect(api.flat()).toEqual(["seed-alpha"])
    expect(api.loading()).toBe(false)

    // 敲下一个字符：新查询发出去，flat() 仍是上一次的结果（stale-while-revalidate）
    api.onInput("x")
    await settle()
    expect(api.loading()).toBe(true)
    expect(api.flat()).toEqual(["seed-alpha"])

    // 这个窗口里 Enter 必须是空操作——否则就是静默插入一个用户没挑的候选
    api.onKeyDown(enterEvent())
    expect(picked).toEqual([])

    releaseSearch(["xray-beta"])
    await settle()
    expect(api.loading()).toBe(false)
    expect(api.flat()).toEqual(["xray-beta"])

    api.onKeyDown(enterEvent())
    expect(picked).toEqual(["xray-beta"])

    dispose()
  })

  test("同步 items 不受影响：没有在途查询，Enter 立即生效", async () => {
    const picked: (string | undefined)[] = []
    let api!: ReturnType<typeof useFilteredList<string>>
    const dispose = createRoot((dispose) => {
      api = useFilteredList<string>({
        items: ["alpha", "beta"],
        key: (x) => x,
        onSelect: (value) => picked.push(value),
      })
      return dispose
    })

    await settle()
    expect(api.loading()).toBe(false)
    api.onKeyDown(enterEvent())
    expect(picked).toEqual(["alpha"])

    dispose()
  })

  // 261110 Red 调用方改为「本地条目同步、远程结果后台补充」后，远程落地会让
  // grouped 再刷一次：用户已选中的行只要还在新列表里，高亮就不能被重置到行 0。
  test("结果刷新保留仍存在的选中项，消失时才落回首行", async () => {
    let api!: ReturnType<typeof useFilteredList<string>>
    const dispose = createRoot((dispose) => {
      api = useFilteredList<string>({
        items: ["alpha", "beta"],
        key: (x) => x,
      })
      return dispose
    })

    await settle()
    api.setActive("beta")

    api.onInput("t") // 触发按 filter 重新过滤
    await settle()
    // beta 仍在结果里：高亮保持，没有被拉回行 0
    expect(api.active()).toBe("beta")

    api.onInput("alph")
    await settle()
    // beta 已被过滤掉：落回（过滤后的）首行
    expect(api.active()).toBe("alpha")

    dispose()
  })
})
