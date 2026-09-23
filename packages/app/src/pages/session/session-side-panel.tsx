import { For, Show, Suspense, createEffect, createMemo, createSignal, lazy, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { ResizeHandle } from "@redcode-ai/ui/resize-handle"
import { Tabs } from "@redcode-ai/ui/tabs"
import { IconButton } from "@redcode-ai/ui/icon-button"
import { TooltipKeybind } from "@redcode-ai/ui/tooltip"
import { Mark } from "@redcode-ai/ui/logo"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { SessionContextTab, SessionPlanTab, SortableTab, FileVisual } from "@/components/session"
import { useCommand } from "@/context/command"
import { SDKProvider } from "@/context/sdk"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { decodeDirectory } from "@/pages/directory-layout"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import {
  createOpenSessionFileTab,
  createSessionTabs,
  getTabReorderIndex,
  SYSTEM_TABS,
  type Sizing,
  type SystemTab,
} from "@/pages/session/helpers"
import { setSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"

const SessionStatusTab = lazy(() =>
  import("@/components/session/session-status-tab").then((module) => ({ default: module.SessionStatusTab })),
)

// 260924 Red 固定入口仍用 Tabs.Trigger，保留 tab/tabpanel 关联与原生方向键导航。
function SystemTabButton(props: {
  tab: SystemTab
  active: () => boolean
  children: JSX.Element
  onRepeat: () => void
}) {
  const repeat = () => {
    if (props.active()) props.onRepeat()
  }

  return (
    <Tabs.Trigger
      value={props.tab}
      data-system-tab={props.tab}
      class="session-side-panel__system-tab"
      onPointerDown={repeat}
      onKeyDown={(event) => {
        if (!props.active() || (event.key !== "Enter" && event.key !== " ")) return
        event.preventDefault()
        repeat()
      }}
    >
      {props.children}
    </Tabs.Trigger>
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
  const open = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const panelVisible = createMemo(() => isWideDesktop() || open())
  const reviewTab = createMemo(() => isDesktop())
  const sessionDirectory = createMemo(() => (params.dir ? decodeDirectory(params.dir) : undefined))
  const panelWidth = createMemo(() => {
    return `${layout.session.width()}px`
  })
  const flowPanelWidth = createMemo(() => (open() ? panelWidth() : "0px"))

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

  const changeTab = (tab: string) => {
    if (!SYSTEM_TABS.has(tab)) {
      openTab(tab)
      return
    }
    tabs().setActive(tab)
    if (!open()) view().reviewPanel.open()
  }

  const repeatSystemTab = (tab: SystemTab) => {
    if (activeTab() !== tab) return
    if (open()) view().reviewPanel.close()
    else view().reviewPanel.open()
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

  // 260924 Red 宽桌面 compact 仍要显示当前 tab 内容；中桌面收起时延迟卸载以保留关闭过渡。
  const [rendered, setRendered] = createSignal(open() || isWideDesktop())
  createEffect(() => {
    if (open() || isWideDesktop()) {
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

  createEffect(() => {
    if (!isWideDesktop() || open() || !activeFileTab()) return
    tabs().setActive("context")
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
          aria-label={language.t("session.panel.workspace")}
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
          <div class="session-side-panel__body">
            <Show when={rendered()}>
              <div
                class="session-side-panel__panel"
                aria-hidden={!panelVisible()}
                inert={!panelVisible()}
                classList={{ "pointer-events-none": !panelVisible() }}
              >
                <div class="size-full flex px-2 py-2">
                  <div
                    aria-hidden={!panelVisible()}
                    inert={!panelVisible()}
                    class="session-side-panel__surface relative min-w-0 h-full flex-1 overflow-hidden"
                    classList={{
                      "pointer-events-none": !panelVisible(),
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
                        <Tabs value={activeTab()} onChange={changeTab}>
                          <Tabs.List
                            class="session-side-panel__tab-list session-side-panel__header"
                            aria-label={language.t("session.panel.workspace")}
                            ref={(el: HTMLDivElement) => {
                              systemTabStrip = el
                              const stop = createFileTabListSync({ el, contextOpen })
                              onCleanup(stop)
                            }}
                          >
                            <SystemTabButton
                              tab="review"
                              active={() => activeTab() === "review"}
                              onRepeat={() => repeatSystemTab("review")}
                            >
                              {language.t("session.tab.review")}
                            </SystemTabButton>
                            <SystemTabButton
                              tab="context"
                              active={() => activeTab() === "context"}
                              onRepeat={() => repeatSystemTab("context")}
                            >
                              {language.t("session.tab.context")}
                            </SystemTabButton>
                            <SystemTabButton
                              tab="outline"
                              active={() => activeTab() === "outline"}
                              onRepeat={() => repeatSystemTab("outline")}
                            >
                              {language.t("session.tab.outline")}
                            </SystemTabButton>
                            <SystemTabButton
                              tab="plan"
                              active={() => activeTab() === "plan"}
                              onRepeat={() => repeatSystemTab("plan")}
                            >
                              {language.t("session.tab.plan")}
                            </SystemTabButton>
                            <SystemTabButton
                              tab="status"
                              active={() => activeTab() === "status"}
                              onRepeat={() => repeatSystemTab("status")}
                            >
                              {language.t("session.tab.status")}
                            </SystemTabButton>
                            <Show when={!isWideDesktop() || open()}>
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
                            </Show>
                          </Tabs.List>

                          {/* 260822 cc 面板自己的 Suspense 边界。少了它，任何一个 tab 里的异步读
                        （useQuery/createResource）一进入无数据 pending，就会一路抛到 app.tsx:198
                        那个包住**整个应用**的 Suspense，把整扇窗换成满屏 Splash 再换回来 ——
                        「上下文」tab 的 context-inspect 查询就这么干过（见该文件里 placeholderData
                        上方那段）。边界放在这里，最坏情况也只是面板这一块空一下。 */}
                          <Suspense fallback={<div class="flex-1 min-h-0" />}>
                            <Tabs.Content value="review" class="flex flex-col h-full overflow-hidden contain-strict">
                              <Show when={panelVisible() && activeTab() === "review"}>{props.reviewPanel()}</Show>
                            </Tabs.Content>

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

                            <Tabs.Content value="status" class="flex flex-col h-full overflow-hidden contain-strict">
                              <Show when={activeTab() === "status"}>
                                <Suspense fallback={<div class="flex-1 min-h-0" />}>
                                  <Show when={sessionDirectory()}>
                                    {(directory) => (
                                      <SDKProvider directory={directory()}>
                                        <SessionStatusTab shown={() => panelVisible() && activeTab() === "status"} />
                                      </SDKProvider>
                                    )}
                                  </Show>
                                </Suspense>
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
