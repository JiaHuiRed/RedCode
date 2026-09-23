import { For, Show, Suspense, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { CapsuleRow } from "@redcode-ai/ui/capsule"
import { Icon } from "@redcode-ai/ui/icon"
import { ResizeHandle } from "@redcode-ai/ui/resize-handle"
import { Tabs } from "@redcode-ai/ui/tabs"
import { IconButton } from "@redcode-ai/ui/icon-button"
import { TooltipKeybind } from "@redcode-ai/ui/tooltip"
import { Mark } from "@redcode-ai/ui/logo"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { SessionContextUsage } from "@/components/session-context-usage"
import { SessionContextTab, SessionPlanTab, SortableTab, FileVisual } from "@/components/session"
import { useCapsuleSummaryGroups, type CapsuleSummaryGroup } from "@/components/session/session-context-summary"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import {
  createOpenSessionFileTab,
  createSessionTabs,
  getTabReorderIndex,
  type Sizing,
  type SystemTab,
} from "@/pages/session/helpers"
import { setSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"

// 260922 Red 折叠矮胶囊的分组行。形态对齐 Codex 侧栏：收起时每段只有一行
// （图标 + 段名 + 关键数字 + chevron），点开才铺明细。数据全部来自
// useCapsuleSummaryGroups（与上下文 tab 同源），这里只管渲染。
function CapsuleSummarySection(props: { group: CapsuleSummaryGroup }) {
  const [expanded, setExpanded] = createSignal(props.group.defaultExpanded ?? false)
  const expandable = () => props.group.details.length > 0
  const primary = () => props.group.id === "context" || props.group.id === "cacheHit" || props.group.id === "cost"
  return (
    <div
      classList={{
        "session-side-panel__summary-group": true,
        "session-side-panel__summary-group--primary": primary(),
      }}
    >
      <CapsuleRow
        icon={props.group.icon}
        selected={expanded()}
        aria-expanded={expandable() ? expanded() : undefined}
        onClick={expandable() ? () => setExpanded((value) => !value) : undefined}
        trailing={
          expandable() ? (
            <Icon
              name="chevron-down"
              size="small"
              class={expanded() ? "rotate-180 transition-transform" : "transition-transform"}
            />
          ) : undefined
        }
      >
        <div class="flex items-center justify-between gap-3 w-full min-w-0">
          <span class="text-12-regular text-text-weak shrink-0">{props.group.label}</span>
          <span class="flex items-center gap-2 min-w-0">
            {/* 260922 Red 真实构成收起时只剩一个总数，看不出构成，补一条占比条 */}
            <Show when={props.group.bar && props.group.bar.length > 0}>
              <span class="session-side-panel__summary-bar">
                <For each={props.group.bar}>
                  {(segment) => <span style={{ width: `${segment.percent}%`, "background-color": segment.color }} />}
                </For>
              </span>
            </Show>
            <span
              classList={{
                "session-side-panel__summary-value": true,
                "session-side-panel__summary-value--primary": primary(),
                "text-12-regular": !primary(),
                "text-12-medium": primary(),
                "text-text-base truncate": true,
              }}
              style={props.group.valueColor ? { color: props.group.valueColor } : undefined}
            >
              {props.group.value}
            </span>
          </span>
        </div>
      </CapsuleRow>
      <Show when={expanded()}>
        <div class="session-side-panel__summary-details">
          <For each={props.group.details}>
            {(detail) => (
              <div class="session-side-panel__summary-detail">
                <span class="text-11-regular text-text-weaker">{detail.label}</span>
                <span
                  class="text-11-regular text-text-base truncate select-text"
                  style={detail.color ? { color: detail.color } : undefined}
                >
                  {detail.value}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

function SessionCapsuleSummaryRows() {
  const groups = useCapsuleSummaryGroups()
  return (
    <div class="session-side-panel__summary-rows">
      <For each={groups()}>{(group) => <CapsuleSummarySection group={group} />}</For>
    </div>
  )
}

// 260923 Red C5：固定 system tab strip 里的一个入口（文档第 7 节）。当前 tab 高亮；
// 点击后的统一行为在 selectSystemTab（文档第 8 节）。折叠态与展开态共用这一份。
function SystemTabButton(props: { tab: SystemTab; active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.active}
      data-system-tab={props.tab}
      classList={{
        "flex-1 min-w-0 truncate rounded-md px-2 py-1 text-center transition-colors": true,
        "text-12-medium text-text-base bg-surface-raised-base": props.active,
        "text-12-regular text-text-weak hover:text-text-base": !props.active,
      }}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  )
}

export function SessionSidePanel(props: {
  canReview: () => boolean
  reviewPanel: () => JSX.Element
  /** 轮次导航栏。数据与跳转都在 session.tsx（那里才有 loadThrough 与 revealMessage），这里只放槽。 */
  outlinePanel: () => JSX.Element
  reviewSnap: boolean
  size: Sizing
}) {
  const layout = useLayout()
  const platform = usePlatform()
  const settings = useSettings()
  const sync = useSync()
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const dialog = useDialog()
  const { sessionKey, tabs, view, params } = useSessionLayout()

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const isWideDesktop = createMediaQuery("(min-width: 1280px)")
  const reviewOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const open = reviewOpen
  const reviewTab = createMemo(() => isDesktop())
  const panelWidth = createMemo(() => {
    return `${layout.session.width()}px`
  })
  const flowPanelWidth = createMemo(() => (reviewOpen() ? panelWidth() : "0px"))

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const openTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel,
    setActive: tabs().setActive,
  })

  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview: props.canReview,
  })
  const contextOpen = tabState.contextOpen
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab

  // 260923 Red C5：点 system tab 的统一行为（文档第 8 节）——tab 本身就是 launcher +
  // selector：当前 tab 且已展开时再点一次即收起；否则切到该 tab，折叠态下顺带展开。
  // 有了它，strip 不需要再挂一个单独的 chevron 大开关。
  const selectSystemTab = (tab: SystemTab) => {
    if (activeTab() === tab && open()) {
      view().reviewPanel.close()
      return
    }
    tabs().setActive(tab)
    if (!open()) view().reviewPanel.open()
  }

  let drawer: HTMLElement | undefined
  let systemTabStrip: HTMLElement | undefined
  let focusFrame: number | undefined
  let wasOpen = open()
  let contextResizeObserver: ResizeObserver | undefined
  const [contextPanelHeight, setContextPanelHeight] = createSignal<number>()

  // 260922 Red 上下文 tab 保留原有 full-height 能力，但内容较短时把外层高度收至
  // 实际内容；原始消息展开后 scrollHeight 变大，min() 自动回到完整可滚动面板。
  const setContextViewport = (viewport: HTMLDivElement | undefined) => {
    contextResizeObserver?.disconnect()
    contextResizeObserver = undefined
    setContextPanelHeight(undefined)
    if (!viewport) return

    const content = viewport.firstElementChild
    if (!(content instanceof HTMLElement)) return

    const measure = () => {
      const panel = drawer?.querySelector<HTMLElement>(".session-side-panel__panel")
      if (!panel) return
      const extra = Math.max(0, panel.getBoundingClientRect().height - viewport.getBoundingClientRect().height)
      // 260922 Red 给最后一行摘要留出余量，避免测量值刚好贴住视口边缘，
      // 原始消息收起时标题落在滚动区下方，必须再向下滑才能看到。
      setContextPanelHeight(Math.ceil(viewport.scrollHeight + extra + 96))
    }

    contextResizeObserver = new ResizeObserver(measure)
    contextResizeObserver.observe(viewport)
    contextResizeObserver.observe(content)
    measure()
  }

  // 260921 Red 收起时不能立刻卸载内容：aside 上的 opacity/transform 过渡需要 DOM 载体
  // 才播得出来，直接 <Show when={open()}> 会在关闭的那一帧清空子树，视觉上就是"瞬间消失"。
  // 延后一段过渡时长再摘，展开时同步恢复。
  const [rendered, setRendered] = createSignal(open())
  createEffect(() => {
    if (open()) {
      setRendered(true)
      return
    }
    const timer = setTimeout(() => setRendered(false), 240)
    onCleanup(() => clearTimeout(timer))
  })

  createEffect(() => {
    const next = open()
    if (
      wasOpen &&
      !next &&
      typeof document !== "undefined" &&
      drawer?.contains(document.activeElement) &&
      systemTabStrip
    ) {
      if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
      focusFrame = requestAnimationFrame(() => {
        focusFrame = undefined
        // 260923 Red C5：收起入口从单个按钮变成 strip，焦点回到当前选中的那个 tab
        const target =
          systemTabStrip?.querySelector<HTMLElement>('[aria-selected="true"]') ??
          systemTabStrip?.querySelector("button")
        target?.focus()
      })
    }
    wasOpen = next
  })

  onCleanup(() => {
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    contextResizeObserver?.disconnect()
  })

  // 260921 Red 宽桌面下展开态是浮层胶囊，Esc 关闭是 popover 的标配；中等桌面仍是参与
  // 布局的面板，沿用标题栏按钮与 mod+shift+r，不在这里抢按键。
  createEffect(() => {
    if (!open() || !isWideDesktop()) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      view().reviewPanel.close()
    }
    document.addEventListener("keydown", onKeyDown)
    onCleanup(() => document.removeEventListener("keydown", onKeyDown))
  })

  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
  })

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const currentTabs = tabs().all()
    const toIndex = getTabReorderIndex(currentTabs, draggable.id.toString(), droppable.id.toString())
    if (toIndex === undefined) return
    tabs().move(draggable.id.toString(), toIndex)
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  createEffect(() => {
    if (!file.ready()) return

    setSessionHandoff(sessionKey(), {
      files: tabs()
        .all()
        .reduce<Record<string, SelectedLineRange | null>>((acc, tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return acc

          const selected = file.selectedLines(path)
          acc[path] =
            selected && typeof selected === "object" && "start" in selected && "end" in selected
              ? (selected as SelectedLineRange)
              : null

          return acc
        }, {}),
    })
  })

  return (
    <Show when={isDesktop()}>
      <div
        class="session-side-panel__rail relative min-w-0 h-full flex shrink-0 overflow-hidden bg-transparent"
        classList={{
          "session-side-panel__rail--wide": isWideDesktop(),
          "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
            !isWideDesktop() && !props.size.active() && !props.reviewSnap,
        }}
        style={{ width: isWideDesktop() ? "0px" : flowPanelWidth() }}
      >
        <aside
          ref={(el) => {
            drawer = el
          }}
          id="review-panel"
          data-component="session-side-panel"
          aria-label={language.t("session.tab.review")}
          aria-hidden={!open() && !isWideDesktop()}
          inert={!open() && !isWideDesktop()}
          class="session-side-panel__capsule relative min-w-0 h-full flex flex-col shrink-0 overflow-hidden bg-transparent"
          classList={{
            "session-side-panel__capsule--wide": isWideDesktop(),
            "session-side-panel__capsule--open": open(),
            "session-side-panel__capsule--closed": !open(),
          }}
          style={{
            "--panel-width": `${layout.session.width()}px`,
            width: isWideDesktop() ? undefined : "100%",
            // 260921 Red wide 态高度走 inline：aside class 上的 h-full（height:100%）会跟
            // CSS 里的分态高度打架，曾出现「矮胶囊内容露顶、全高壳留在下面」一屏黑。
            // inline 优先级最高，折叠矮胶囊 ↔ 展开全高从此不受类名竞争影响。
            // 折叠态刻意压到摘要内容附近：这是常态态，要做成贴边 HUD 而不是小卡片。
            // 260922 Red 折叠态收短：高度与 CSS 里的分态值保持一致，
            // 别让 inline 和 class 各说一套（这个 inline 优先级压过 CSS，改一面等于没改）。
            height: isWideDesktop()
              ? open()
                ? activeTab() === "context" && contextPanelHeight() !== undefined
                  ? `min(${contextPanelHeight()}px, calc(100% - 68px))`
                  : "calc(100% - 68px)"
                : "clamp(240px, 28vh, 320px)"
              : undefined,
          }}
        >
          {/* 260921 Red 宽桌面下的切换行：折叠态它是矮胶囊的 header，展开态它是抽屉
             顶部的一行——必须永驻可见。曾把它和四段摘要一起淡出，结果展开后再没有
             可见的收起入口，折叠态直接变成触发不到的死状态。中桌面不渲染。
             260923 Red C5：这行换成固定 system tab strip（文档第 7 节），compact 与
             expanded 都在；收起不再靠单独的 chevron 大开关，而是「再点当前 tab」
             （文档第 8 节：tab 本身就是 launcher + selector）。status 待 C6/C7 把内容
             拆进来后再补上——现在渲染它只会是一个点进去没有内容的死项。 */}
          <Show when={isWideDesktop()}>
            <div class="session-side-panel__header">
              <div
                ref={(el) => {
                  systemTabStrip = el
                }}
                role="tablist"
                aria-controls="review-panel"
                aria-label={language.t("session.panel.reviewAndFiles")}
                class="flex items-center gap-0.5 min-h-8"
              >
                <Show when={reviewTab() && props.canReview()}>
                  <SystemTabButton
                    tab="review"
                    active={activeTab() === "review"}
                    label={language.t("session.tab.review")}
                    onClick={() => selectSystemTab("review")}
                  />
                </Show>
                <SystemTabButton
                  tab="context"
                  active={activeTab() === "context"}
                  label={language.t("session.tab.context")}
                  onClick={() => selectSystemTab("context")}
                />
                <SystemTabButton
                  tab="outline"
                  active={activeTab() === "outline"}
                  label={language.t("session.tab.outline")}
                  onClick={() => selectSystemTab("outline")}
                />
                <SystemTabButton
                  tab="plan"
                  active={activeTab() === "plan"}
                  label={language.t("session.tab.plan")}
                  onClick={() => selectSystemTab("plan")}
                />
              </div>
            </div>
          </Show>

          <div class="session-side-panel__body">
            {/* 折叠态（宽桌面）：HUD 分组行，与上下文 tab 的摘要同源
                （useCapsuleSummaryGroups）。展开时淡出让位给面板层。 */}
            <Show when={isWideDesktop()}>
              <div
                class="session-side-panel__rows"
                classList={{ "session-side-panel__rows--hidden": open() }}
                aria-hidden={open()}
              >
                {/* inspect 查询首轮无缓存时会向最近的 Suspense 抛；这层在面板自己的
                    Suspense 之外，必须自带边界，否则会一路抛到 app 级 Splash */}
                <Suspense fallback={<div class="flex-1 min-h-0" />}>
                  <SessionCapsuleSummaryRows />
                </Suspense>
              </div>
            </Show>

            <Show when={rendered()}>
              <div
                class="session-side-panel__panel"
                aria-hidden={!open()}
                inert={!open()}
                classList={{ "pointer-events-none": !open() }}
              >
                <div class="size-full flex px-2 py-2">
                  <div
                    aria-hidden={!reviewOpen()}
                    inert={!reviewOpen()}
                    class="session-side-panel__surface relative min-w-0 h-full flex-1 overflow-hidden"
                    classList={{
                      "pointer-events-none": !reviewOpen(),
                    }}
                  >
                    <div class="size-full min-w-0 h-full">
                      <DragDropProvider
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
                        onDragOver={handleDragOver}
                        collisionDetector={closestCenter}
                      >
                        <DragDropSensors />
                        <ConstrainDragYAxis />
                        <Tabs value={activeTab()} onChange={openTab}>
                          <div class="sticky top-0 shrink-0 flex">
                            <Tabs.List
                              class="session-side-panel__tab-list"
                              ref={(el: HTMLDivElement) => {
                                const stop = createFileTabListSync({ el, contextOpen })
                                onCleanup(stop)
                              }}
                            >
                              <Show when={reviewTab() && props.canReview()}>
                                <Tabs.Trigger value="review">
                                  <div class="flex items-center gap-1.5">
                                    <div>{language.t("session.tab.review")}</div>
                                  </div>
                                </Tabs.Trigger>
                              </Show>
                              {/* 260923 Red C4：Context 是固定 system tab——入口永在、不可关闭
                            （文档第 14 节）。不再由 contextOpen() 决定存在，也不再挂关闭按钮与
                            中键关闭：入口的存在性从此与状态解耦。 */}
                              <Tabs.Trigger value="context">
                                <div class="flex items-center gap-2">
                                  <SessionContextUsage variant="indicator" />
                                  <div>{language.t("session.tab.context")}</div>
                                </div>
                              </Tabs.Trigger>
                              {/* 260901 cc 轮次标签：整份日志的轮次目录，点一条翻页并跳过去 */}
                              <Tabs.Trigger value="outline">
                                <div class="flex items-center gap-1.5">
                                  <div>{language.t("session.tab.outline")}</div>
                                </div>
                              </Tabs.Trigger>
                              {/* 260615 Red Plan 标签：展示当前会话 todo 计划进度 */}
                              <Tabs.Trigger value="plan">
                                <div class="flex items-center gap-1.5">
                                  <div>{language.t("session.tab.plan")}</div>
                                </div>
                              </Tabs.Trigger>
                              <SortableProvider ids={openedTabs()}>
                                <For each={openedTabs()}>
                                  {(tab) => <SortableTab tab={tab} onTabClose={tabs().close} />}
                                </For>
                              </SortableProvider>
                              <div class="session-side-panel__tab-end h-full shrink-0 sticky right-0 z-10 flex items-center justify-center pl-1 pr-2">
                                <TooltipKeybind
                                  title={language.t("command.file.open")}
                                  keybind={command.keybind("file.open")}
                                  class="flex items-center"
                                >
                                  <IconButton
                                    icon="plus-small"
                                    variant="ghost"
                                    iconSize="large"
                                    class="!rounded-md"
                                    onClick={() => {
                                      void import("@/components/dialog-select-file").then((x) => {
                                        dialog.show(() => <x.DialogSelectFile mode="files" />)
                                      })
                                    }}
                                    aria-label={language.t("command.file.open")}
                                  />
                                </TooltipKeybind>
                              </div>
                            </Tabs.List>
                          </div>

                          {/* 260822 cc 面板自己的 Suspense 边界。少了它，任何一个 tab 里的异步读
                        （useQuery/createResource）一进入无数据 pending，就会一路抛到 app.tsx:198
                        那个包住**整个应用**的 Suspense，把整扇窗换成满屏 Splash 再换回来 ——
                        「上下文」tab 的 context-inspect 查询就这么干过（见该文件里 placeholderData
                        上方那段）。边界放在这里，最坏情况也只是面板这一块空一下。 */}
                          <Suspense fallback={<div class="flex-1 min-h-0" />}>
                            <Show when={reviewTab() && props.canReview()}>
                              <Tabs.Content value="review" class="flex flex-col h-full overflow-hidden contain-strict">
                                <Show when={reviewOpen() && activeTab() === "review"}>{props.reviewPanel()}</Show>
                              </Tabs.Content>
                            </Show>

                            <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
                              <Show when={activeTab() === "empty"}>
                                <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                                  <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-6">
                                    <Mark class="w-14 opacity-10" />
                                    <div class="text-14-regular text-text-weak max-w-56">
                                      {language.t("session.files.selectToOpen")}
                                    </div>
                                  </div>
                                </div>
                              </Show>
                            </Tabs.Content>

                            {/* 260923 Red C4：内容仍按 active 挂载（文档第 15 节「内容可卸载、
                          入口不能消失」），但外层不再用 contextOpen() 门控——那层 Show 正是
                          入口被状态带走的旧耦合。 */}
                            <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                              <Show when={activeTab() === "context"}>
                                <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                                  <SessionContextTab setViewportRef={setContextViewport} />
                                </div>
                              </Show>
                            </Tabs.Content>

                            {/* 260901 cc 轮次标签页内容。Show 保证只在激活时挂载 —— 目录请求因此
                          只在真的打开这个标签时才发，不给「点开会话」那条热路径加往返。 */}
                            <Tabs.Content value="outline" class="flex flex-col h-full overflow-hidden contain-strict">
                              <Show when={activeTab() === "outline"}>
                                <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">{props.outlinePanel()}</div>
                              </Show>
                            </Tabs.Content>

                            {/* 260615 Red Plan 标签页内容 */}
                            <Tabs.Content value="plan" class="flex flex-col h-full overflow-hidden contain-strict">
                              <Show when={activeTab() === "plan"}>
                                <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                                  <SessionPlanTab />
                                </div>
                              </Show>
                            </Tabs.Content>

                            <Show when={activeFileTab()} keyed>
                              {(tab) => <FileTabContent tab={tab} />}
                            </Show>
                          </Suspense>
                        </Tabs>
                        <DragOverlay>
                          <Show when={store.activeDraggable} keyed>
                            {(tab) => {
                              const path = file.pathFromTab(tab)
                              return (
                                <div data-component="tabs-drag-preview">
                                  <Show when={path}>{(p) => <FileVisual active path={p()} />}</Show>
                                </div>
                              )
                            }}
                          </Show>
                        </DragOverlay>
                      </DragDropProvider>
                    </div>
                  </div>
                </div>
              </div>
            </Show>
            <Show when={open() && !isWideDesktop()}>
              <div onPointerDown={() => props.size.start()}>
                <ResizeHandle
                  direction="horizontal"
                  edge="start"
                  size={layout.session.width()}
                  min={340}
                  max={typeof window === "undefined" ? 1000 : window.innerWidth * 0.45}
                  onResize={(width) => {
                    props.size.touch()
                    layout.session.resize(width)
                  }}
                />
              </div>
            </Show>
          </div>
        </aside>
      </div>
    </Show>
  )
}
