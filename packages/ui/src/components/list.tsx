import { type FilteredListProps, useFilteredList } from "@redcode-ai/ui/hooks"
import { createEffect, createMemo, createSignal, For, type JSX, on, type Accessor, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { Virtualizer, type VirtualizerHandle } from "virtua/solid"
import { useI18n } from "../context/i18n"
import { Icon, type IconProps } from "./icon"
import { IconButton } from "./icon-button"
import { TextField } from "./text-field"
import { flattenListGroups, itemIndexByKey, type FlatListEntry } from "./list-flat"

const EMPTY_ENTRIES: FlatListEntry<never>[] = []

function findByKey(container: HTMLElement, key: string) {
  const nodes = container.querySelectorAll<HTMLElement>('[data-slot="list-item"][data-key]')
  for (const node of nodes) {
    if (node.getAttribute("data-key") === key) return node
  }
}

export interface ListSearchProps {
  placeholder?: string
  autofocus?: boolean
  hideIcon?: boolean
  class?: string
  action?: JSX.Element
}

export interface ListAddProps {
  class?: string
  render: () => JSX.Element
}

export interface ListAddProps {
  class?: string
  render: () => JSX.Element
}

export interface ListProps<T> extends FilteredListProps<T> {
  class?: string
  children: (item: T) => JSX.Element
  emptyMessage?: string
  loadingMessage?: string
  onKeyEvent?: (event: KeyboardEvent, item: T | undefined) => void
  onMove?: (item: T | undefined) => void
  onFilter?: (value: string) => void
  activeIcon?: IconProps["name"]
  filter?: string
  search?: ListSearchProps | boolean
  itemWrapper?: (item: T, node: JSX.Element) => JSX.Element
  divider?: boolean
  add?: ListAddProps
  groupHeader?: (group: { category: string; items: T[] }) => JSX.Element
  /**
   * 261106 Red opt-in 虚拟化。开启后分组结构摊平（flattenListGroups）交给 virtua
   * Virtualizer 逐窗渲染，键盘高亮经扁平 index 映射滚动；sticky 分组头在该分支不启用。
   * 默认 false，非虚拟路径行为不变。
   */
  virtual?: boolean
}

export interface ListRef {
  onKeyDown: (e: KeyboardEvent) => void
  setScrollRef: (el: HTMLDivElement | undefined) => void
  setFilter: (value: string) => void
}

export function List<T>(props: ListProps<T> & { ref?: (ref: ListRef) => void }) {
  const i18n = useI18n()
  let inputRef: HTMLInputElement | HTMLTextAreaElement | undefined
  const [store, setStore] = createStore({
    mouseActive: false,
    scrollRef: undefined as HTMLDivElement | undefined,
    internalFilter: "",
  })
  const scrollRef = () => store.scrollRef
  const setScrollRef = (el: HTMLDivElement | undefined) => setStore("scrollRef", el)
  const internalFilter = () => store.internalFilter
  const setInternalFilter = (value: string) => setStore("internalFilter", value)

  const scrollIntoView = (container: HTMLDivElement, node: HTMLElement, block: "center" | "nearest") => {
    const containerRect = container.getBoundingClientRect()
    const nodeRect = node.getBoundingClientRect()
    const top = nodeRect.top - containerRect.top + container.scrollTop
    const bottom = top + nodeRect.height
    const viewTop = container.scrollTop
    const viewBottom = viewTop + container.clientHeight
    const target =
      block === "center"
        ? top - container.clientHeight / 2 + nodeRect.height / 2
        : top < viewTop
          ? top
          : bottom > viewBottom
            ? bottom - container.clientHeight
            : viewTop
    const max = Math.max(0, container.scrollHeight - container.clientHeight)
    container.scrollTop = Math.max(0, Math.min(target, max))
  }

  const { filter, grouped, flat, active, setActive, onKeyDown, onInput, refetch } = useFilteredList<T>(props)

  const searchProps = () => (typeof props.search === "object" ? props.search : {})
  const searchAction = () => searchProps().action
  const addProps = () => props.add
  const showAdd = () => !!addProps()

  // 261106 Red 虚拟分支状态：handle 供 scrollToIndex 导航；非 virtual 时 memo 短路成空数组，
  //   其余消费者不为扁平化付成本。虚拟下不再 querySelectorAll——未渲染条目不在 DOM 里，
  //   定位一律走「扁平数组 index 映射」（virtualIndexByKey）。
  const [virtualizer, setVirtualizer] = createSignal<VirtualizerHandle>()

  const virtualEntries = createMemo<readonly FlatListEntry<T>[]>(() => {
    if (!props.virtual) return EMPTY_ENTRIES
    return flattenListGroups(grouped.latest, { key: props.key, add: showAdd() })
  })

  const virtualIndexByKey = createMemo<ReadonlyMap<string, number>>(() => itemIndexByKey(virtualEntries()))

  const moved = (event: MouseEvent) => event.movementX !== 0 || event.movementY !== 0

  const applyFilter = (value: string, options?: { ref?: boolean }) => {
    const prev = filter()
    setInternalFilter(value)
    onInput(value)
    props.onFilter?.(value)

    if (!options?.ref) return

    // Force a refetch even if the value is unchanged.
    // This is important for programmatic changes like Tab completion.
    if (prev === value) {
      void refetch()
      return
    }
    queueMicrotask(() => refetch())
  }

  createEffect(() => {
    if (props.filter === undefined) return
    if (props.filter === internalFilter()) return
    setInternalFilter(props.filter)
    onInput(props.filter)
  })

  createEffect(
    on(
      filter,
      () => {
        scrollRef()?.scrollTo(0, 0)
      },
      { defer: true },
    ),
  )

  // 261028 Red 依赖里加 flat()：模型这类列表异步到达，挂载时 rAF 找不到 current
  //   项就静默返回，而列表到达后本效果不会重跑（依赖没变）——当前模型留在原处，
  //   常在视野外或边缘，用户只能滚轮找。centeredKey 保证每个 current 只居中一次，
  //   过滤时不跟用户的滚动抢位置（当前项被滤掉时也不记，滤回来再居中）。
  let centeredKey: string | undefined
  createEffect(() => {
    const scroll = scrollRef()
    if (!scroll) return
    if (!props.current) return
    const key = props.key(props.current)
    flat()
    if (centeredKey === key) return
    // 261106 Red 虚拟分支没有全量 DOM，居中走 handle.scrollToIndex；条目高度未测得时
    //   virtua 用估算值滚动并在测量后校正。handle 未就绪时先不记 centeredKey，
    //   等 handle 信号触发本效果重跑。
    if (props.virtual) {
      const handle = virtualizer()
      const index = virtualIndexByKey().get(key)
      if (!handle || index === undefined) return
      centeredKey = key
      handle.scrollToIndex(index, { align: "center" })
      return
    }
    requestAnimationFrame(() => {
      const element = findByKey(scroll, key)
      if (!element) return
      centeredKey = key
      scrollIntoView(scroll, element, "center")
    })
  })

  createEffect(() => {
    const all = flat()
    if (store.mouseActive || all.length === 0) return
    const scroll = scrollRef()
    if (!scroll) return
    // 261106 Red 虚拟分支：高亮跟随不走 querySelectorAll，改经扁平 index 映射
    //   + handle.scrollToIndex；首项对齐顶端与非虚拟的 scroll.scrollTo(0,0) 等价。
    if (props.virtual) {
      const handle = virtualizer()
      if (!handle) return
      const key = active()
      if (!key) return
      if (key === props.key(all[0])) {
        handle.scrollTo(0)
        return
      }
      const index = virtualIndexByKey().get(key)
      if (index === undefined) return
      handle.scrollToIndex(index, { align: "center" })
      return
    }
    if (active() === props.key(all[0])) {
      scroll.scrollTo(0, 0)
      return
    }
    const key = active()
    if (!key) return
    const element = findByKey(scroll, key)
    if (!element) return
    scrollIntoView(scroll, element, "center")
  })

  createEffect(() => {
    const all = flat()
    const current = active()
    const item = all.find((x) => props.key(x) === current)
    props.onMove?.(item)
  })

  const handleSelect = (item: T | undefined, index: number) => {
    props.onSelect?.(item, index)
  }

  const handleKey = (e: KeyboardEvent) => {
    setStore("mouseActive", false)
    if (e.key === "Escape") return

    const all = flat()
    const selected = all.find((x) => props.key(x) === active())
    const index = selected ? all.indexOf(selected) : -1
    props.onKeyEvent?.(e, selected)

    if (e.defaultPrevented) return

    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault()
      if (selected) handleSelect(selected, index)
    } else if (props.search) {
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.key === "n" || e.key === "p")) {
        onKeyDown(e)
        return
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        onKeyDown(e)
      }
    } else {
      onKeyDown(e)
    }
  }

  props.ref?.({
    onKeyDown: handleKey,
    setScrollRef,
    setFilter: (value) => applyFilter(value, { ref: true }),
  })

  // 261106 Red 条目节点抽成单一实现，虚拟/非虚拟共用：data-key/active/selected、
  //   itemWrapper（Tooltip 包装）、分隔线、current 勾选全部保持原语义，避免两份 JSX 漂移。
  //   index/showDivider/dataLast 用 accessor 传——非虚拟的组内下标来自 For，是响应式的。
  const renderItem = (
    item: T,
    index: () => number,
    showDivider: () => boolean | undefined,
    dataLast?: () => boolean,
  ) => {
    const node = (
      <button
        data-slot="list-item"
        data-key={props.key(item)}
        data-active={props.key(item) === active()}
        data-selected={item === props.current}
        data-last={dataLast?.() ? "true" : undefined}
        onClick={() => handleSelect(item, index())}
        onKeyDown={handleKey}
        type="button"
        onMouseMove={(event) => {
          if (!moved(event)) return
          setStore("mouseActive", true)
          setActive(props.key(item))
        }}
        onMouseLeave={() => {
          if (!store.mouseActive) return
          setActive(null)
        }}
      >
        {props.children(item)}
        <Show when={item === props.current}>
          <span data-slot="list-item-selected-icon">
            <Icon name="check-small" />
          </span>
        </Show>
        <Show when={props.activeIcon}>
          {(icon) => (
            <span data-slot="list-item-active-icon">
              <Icon name={icon()} />
            </span>
          )}
        </Show>
        {showDivider() && <span data-slot="list-item-divider" />}
      </button>
    )
    if (props.itemWrapper) return props.itemWrapper(item, node)
    return node
  }

  // 261106 Red 虚拟分支逐条渲染：header 不走 GroupHeader（sticky 与 virtua 的绝对定位
  //   条目冲突，滚动监听不启用）；item 复用 renderItem；add 行在扁平数组末尾。
  const renderVirtualEntry = (entry: FlatListEntry<T>, index: Accessor<number>): JSX.Element => {
    const last = () => index() === virtualEntries().length - 1
    if (entry.type === "header") {
      return (
        <div
          data-slot="list-header"
          data-first={index() === 0 ? "true" : undefined}
          data-last={last() ? "true" : undefined}
        >
          {props.groupHeader?.(entry.group) ?? entry.category}
        </div>
      )
    }
    if (entry.type === "item") {
      return renderItem(
        entry.item,
        () => entry.index,
        () => props.divider && (entry.index !== entry.groupSize - 1 || (showAdd() && entry.lastGroup)),
        last,
      )
    }
    return renderAdd(last)
  }

  // 261106 Red dataLast：虚拟分支给最后一个扁平条目补 12px 底部留白（对齐非虚拟
  //   .list-group:last-child 的 padding-bottom），非虚拟不传即无该属性。
  const renderAdd = (dataLast?: () => boolean) => {
    const add = addProps()
    if (!add) return null
    return (
      <div
        data-slot="list-item-add"
        data-last={dataLast?.() ? "true" : undefined}
        classList={{ [add.class ?? ""]: !!add.class }}
      >
        {add.render()}
      </div>
    )
  }

  function GroupHeader(groupProps: { group: { category: string; items: T[] } }): JSX.Element {
    const [state, setState] = createStore({
      stuck: false,
      header: undefined as HTMLDivElement | undefined,
    })

    createEffect(() => {
      const scroll = scrollRef()
      const node = state.header
      if (!scroll || !node) return

      const handler = () => {
        const rect = node.getBoundingClientRect()
        const scrollRect = scroll.getBoundingClientRect()
        setState("stuck", rect.top <= scrollRect.top + 1 && scroll.scrollTop > 0)
      }

      makeEventListener(scroll, "scroll", handler, { passive: true })
      handler()
    })

    return (
      <div data-slot="list-header" data-stuck={state.stuck} ref={(el) => setState("header", el)}>
        {props.groupHeader?.(groupProps.group) ?? groupProps.group.category}
      </div>
    )
  }

  const emptyMessage = () => {
    if (grouped.loading) return props.loadingMessage ?? i18n.t("ui.list.loading")
    if (props.emptyMessage) return props.emptyMessage

    const query = filter()
    if (!query) return i18n.t("ui.list.empty")

    const suffix = i18n.t("ui.list.emptyWithFilter.suffix")
    return (
      <>
        <span>{i18n.t("ui.list.emptyWithFilter.prefix")}</span>
        <span data-slot="list-filter">&quot;{query}&quot;</span>
        <Show when={suffix}>
          <span>{suffix}</span>
        </Show>
      </>
    )
  }

  return (
    <div data-component="list" classList={{ [props.class ?? ""]: !!props.class }}>
      <Show when={!!props.search}>
        <div data-slot="list-search-wrapper">
          <div
            data-slot="list-search"
            classList={{ [searchProps().class ?? ""]: !!searchProps().class }}
            onPointerDown={(event) => {
              const container = event.currentTarget
              if (!(container instanceof HTMLElement)) return

              const node = container.querySelector("input, textarea")
              const input = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node : inputRef
              input?.focus()

              // Prevent global listeners (e.g. dnd sensors) from cancelling focus.
              event.stopPropagation()
            }}
          >
            <div data-slot="list-search-container">
              <Show when={!searchProps().hideIcon}>
                <Icon name="magnifying-glass" />
              </Show>
              <TextField
                autofocus={searchProps().autofocus}
                variant="ghost"
                data-slot="list-search-input"
                type="text"
                ref={(el: HTMLInputElement | HTMLTextAreaElement) => {
                  inputRef = el
                }}
                value={internalFilter()}
                onChange={(value) => applyFilter(value)}
                onKeyDown={handleKey}
                placeholder={searchProps().placeholder}
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
              />
            </div>
            <Show when={internalFilter()}>
              <IconButton
                icon="circle-x"
                variant="ghost"
                onClick={() => {
                  setInternalFilter("")
                  queueMicrotask(() => inputRef?.focus())
                }}
                aria-label={i18n.t("ui.list.clearFilter")}
              />
            </Show>
          </div>
          {searchAction()}
        </div>
      </Show>
      <div ref={setScrollRef} data-slot="list-scroll" data-virtual={props.virtual ? "true" : undefined}>
        <Show
          when={flat().length > 0 || showAdd()}
          fallback={
            <div data-slot="list-empty-state">
              <div data-slot="list-message">{emptyMessage()}</div>
            </div>
          }
        >
          {/* 261106 Red 分支选择用三元而不是 <Show>：Solid 的 Show fallback/children 是
              在父组件渲染时求值的，嵌套 Show 会让非虚拟 <For> 在虚拟模式下照样全量建树，
              虚拟化等于白做。三元只执行被选中的分支（virtual 按消费点是静态 prop）。 */}
          {props.virtual ? (
            /* 261106 Red 虚拟分支：条目高度动态（header 矮 item 高），不传 itemSize 让 virtua
                自行测量；scrollRef 指向 list-scroll，复用既有滚动语义。 */
            <Virtualizer data={virtualEntries()} scrollRef={scrollRef()} ref={(handle) => setVirtualizer(handle)}>
              {(entry, index) => renderVirtualEntry(entry, index)}
            </Virtualizer>
          ) : (
            <>
              <For each={grouped.latest}>
                {(group, groupIndex) => {
                  const isLastGroup = () => groupIndex() === grouped.latest.length - 1
                  return (
                    <div data-slot="list-group">
                      <Show when={group.category}>
                        <GroupHeader group={group} />
                      </Show>
                      <div data-slot="list-items">
                        <For each={group.items}>
                          {(item, i) =>
                            renderItem(
                              item,
                              i,
                              () => props.divider && (i() !== group.items.length - 1 || (showAdd() && isLastGroup())),
                            )
                          }
                        </For>
                        <Show when={showAdd() && isLastGroup()}>{renderAdd()}</Show>
                      </div>
                    </div>
                  )
                }}
              </For>
              <Show when={grouped.latest.length === 0 && showAdd()}>
                <div data-slot="list-group">
                  <div data-slot="list-items">{renderAdd()}</div>
                </div>
              </Show>
            </>
          )}
        </Show>
      </div>
    </div>
  )
}
