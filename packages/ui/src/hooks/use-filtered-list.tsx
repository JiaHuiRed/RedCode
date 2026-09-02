import fuzzysort from "fuzzysort"
import { entries, flatMap, groupBy, map, pipe } from "remeda"
import { createEffect, createMemo, createResource, on } from "solid-js"
import { createStore } from "solid-js/store"
import { createList } from "solid-list"

export interface FilteredListProps<T> {
  items: T[] | ((filter: string) => T[] | Promise<T[]>)
  key: (item: T) => string
  filterKeys?: string[]
  current?: T
  groupBy?: (x: T) => string
  sortBy?: (a: T, b: T) => number
  sortGroupsBy?: (a: { category: string; items: T[] }, b: { category: string; items: T[] }) => number
  onSelect?: (value: T | undefined, index: number) => void
  noInitialSelection?: boolean
}

export function useFilteredList<T>(props: FilteredListProps<T>) {
  const [store, setStore] = createStore<{ filter: string }>({ filter: "" })

  type Group = { category: string; items: [T, ...T[]] }
  const empty: Group[] = []

  const [grouped, { refetch }] = createResource(
    () => ({
      filter: store.filter,
      items: typeof props.items === "function" ? props.items(store.filter) : props.items,
    }),
    async ({ filter, items }) => {
      const query = filter ?? ""
      const needle = query.toLowerCase()
      const all = (await Promise.resolve(items)) || []
      const result = pipe(
        all,
        (x) => {
          if (!needle) return x
          if (!props.filterKeys && Array.isArray(x) && x.every((e) => typeof e === "string")) {
            return fuzzysort.go(needle, x).map((x) => x.target) as T[]
          }
          return fuzzysort.go(needle, x, { keys: props.filterKeys! }).map((x) => x.obj)
        },
        groupBy((x) => (props.groupBy ? props.groupBy(x) : "")),
        entries(),
        map(([k, v]) => ({ category: k, items: props.sortBy ? v.sort(props.sortBy) : v })),
        (groups) => (props.sortGroupsBy ? groups.sort(props.sortGroupsBy) : groups),
      )
      return result
    },
    { initialValue: empty },
  )

  const flat = createMemo(() => {
    return pipe(
      grouped.latest || [],
      flatMap((x) => x.items),
    )
  })

  function initialActive() {
    if (props.noInitialSelection) return ""
    if (props.current) return props.key(props.current)

    const items = flat()
    if (items.length === 0) return ""
    return props.key(items[0])
  }

  const list = createList({
    items: () => flat().map(props.key),
    initialActive: initialActive(),
    loop: true,
  })

  const reset = () => {
    if (props.noInitialSelection) {
      list.setActive("")
      return
    }
    const all = flat()
    if (all.length === 0) return
    list.setActive(props.key(all[0]))
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault()
      // 260901 cc 新查询在途时 flat() 读的是 grouped.latest —— 上一次查询的结果。
      //   这个 stale-while-revalidate 是有意的（否则每敲一个字列表就塌成空白），但
      //   **陈旧行只能看不能选**：此刻高亮的那一行是为上一个 filter 算出来的，直接
      //   选中就等于静默插入一个用户没挑的候选。这个窗口里 Enter 是显式空操作 ——
      //   调用方（prompt-input.tsx 的 keydown 分发）在 popover 打开时对 Enter 一律
      //   preventDefault + return，所以这里返回不会漏成"提交草稿"。
      //   代价是快打时可能吞掉一次 Enter，再按一次即可；换来的是不会选错。
      //   刻意不给"加载中"的视觉反馈：陈旧行本来就是对的样子，而按键级的明暗切换
      //   会变成逐字符闪动。来源 DSH `2026-08-28-trigger-menu-stale-while-revalidate`。
      if (grouped.loading) return
      const selectedIndex = flat().findIndex((x) => props.key(x) === list.active())
      const selected = flat()[selectedIndex]
      if (selected) props.onSelect?.(selected, selectedIndex)
    } else if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
      if (event.key === "n" || event.key === "p") {
        event.preventDefault()
        const navEvent = new KeyboardEvent("keydown", {
          key: event.key === "n" ? "ArrowDown" : "ArrowUp",
          bubbles: true,
        })
        list.onKeyDown(navEvent)
      }
    } else {
      // Skip list navigation for text editing shortcuts (e.g., Option+Arrow, Option+Backspace on macOS)
      if (event.altKey || event.metaKey) return
      list.onKeyDown(event)
    }
  }

  createEffect(
    on(grouped, () => {
      reset()
    }),
  )

  const onInput = (value: string) => {
    setStore("filter", value)
  }

  return {
    grouped,
    /** 新查询在途。此时 `flat()` 是上一次的结果，别拿它做选中类动作。 */
    loading: () => grouped.loading,
    filter: () => store.filter,
    flat,
    reset,
    refetch,
    clear: () => setStore("filter", ""),
    onKeyDown,
    onInput,
    active: list.active,
    setActive: list.setActive,
  }
}
