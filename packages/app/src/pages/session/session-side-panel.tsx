import { For, Show, Suspense, createEffect, createMemo, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
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
import { StatusPopoverBody } from "@/components/status-popover-body"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import { createOpenSessionFileTab, createSessionTabs, getTabReorderIndex, type Sizing } from "@/pages/session/helpers"
import { setSessionHandoff } from "@/pages/session/handoff"
import { useSessionLayout } from "@/pages/session/session-layout"

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
  const reviewOpen = createMemo(() => isDesktop() && view().reviewPanel.opened())
  const open = reviewOpen
  const reviewTab = createMemo(() => isDesktop())
  const panelWidth = createMemo(() => {
    if (!reviewOpen()) return "0px"
    return `${layout.session.width()}px`
  })

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
      <aside
        id="review-panel"
        aria-label={language.t("session.tab.review")}
        aria-hidden={!open()}
        inert={!open()}
        class="relative min-w-0 h-full flex shrink-0 overflow-hidden bg-background-base"
        classList={{
          "pointer-events-none": !open(),
          "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
            !props.size.active() && !props.reviewSnap,
        }}
        style={{ width: panelWidth() }}
      >
        <Show when={open()}>
          <div class="size-full flex border-l border-border-weaker-base">
            <div
              aria-hidden={!reviewOpen()}
              inert={!reviewOpen()}
              class="relative min-w-0 h-full flex-1 overflow-hidden bg-background-base"
              classList={{
                "pointer-events-none": !reviewOpen(),
              }}
            >
              <div class="size-full min-w-0 h-full bg-background-base">
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
                        <Show when={contextOpen()}>
                          <Tabs.Trigger
                            value="context"
                            closeButton={
                              <TooltipKeybind
                                title={language.t("common.closeTab")}
                                keybind={command.keybind("tab.close")}
                                placement="bottom"
                                gutter={10}
                              >
                                <IconButton
                                  icon="close-small"
                                  variant="ghost"
                                  class="h-5 w-5"
                                  onClick={() => tabs().close("context")}
                                  aria-label={language.t("common.closeTab")}
                                />
                              </TooltipKeybind>
                            }
                            hideCloseButton
                            onMiddleClick={() => tabs().close("context")}
                          >
                            <div class="flex items-center gap-2">
                              <SessionContextUsage variant="indicator" />
                              <div>{language.t("session.tab.context")}</div>
                            </div>
                          </Tabs.Trigger>
                        </Show>
                        {/* 260610 Red 服务器/MCP/LSP/插件状态标签：常驻，由标题栏圆点或点击此处打开 */}
                        <Tabs.Trigger value="status">
                          <div class="flex items-center gap-1.5">
                            <div>{language.t("session.tab.status")}</div>
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
                          <For each={openedTabs()}>{(tab) => <SortableTab tab={tab} onTabClose={tabs().close} />}</For>
                        </SortableProvider>
                        <div class="bg-background-stronger h-full shrink-0 sticky right-0 z-10 flex items-center justify-center pr-3">
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

                      <Show when={contextOpen()}>
                        <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                          <Show when={activeTab() === "context"}>
                            <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                              <SessionContextTab />
                            </div>
                          </Show>
                        </Tabs.Content>
                      </Show>

                      {/* 260610 Red status 标签页内容：复用标题栏弹层的 StatusPopoverBody（fill 自适应宽度） */}
                      <Tabs.Content value="status" class="flex flex-col h-full overflow-hidden contain-strict">
                        <Show when={activeTab() === "status"}>
                          <div class="relative pt-2 flex-1 min-h-0 overflow-auto px-2">
                            <StatusPopoverBody shown={() => true} fill />
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
        </Show>
      </aside>
    </Show>
  )
}
