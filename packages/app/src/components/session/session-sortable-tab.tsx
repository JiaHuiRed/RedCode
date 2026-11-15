import { createMemo, Show } from "solid-js"
import type { JSX } from "solid-js"
import { createSortable } from "@thisbeyond/solid-dnd"
import { FileIcon } from "@redcode-ai/ui/file-icon"
import { IconButton } from "@redcode-ai/ui/icon-button"
import { Tooltip, TooltipKeybind } from "@redcode-ai/ui/tooltip"
import { Tabs } from "@redcode-ai/ui/tabs"
import { getFilename } from "@redcode-ai/core/util/path"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useCommand } from "@/context/command"
import { useSessionLayout } from "@/context/session-layout"

export function FileVisual(props: { path: string; active?: boolean }): JSX.Element {
  return (
    <div class="flex items-center gap-x-1.5 min-w-0">
      <Show
        when={!props.active}
        fallback={<FileIcon node={{ path: props.path, type: "file" }} class="size-4 shrink-0" />}
      >
        <span class="relative inline-flex size-4 shrink-0">
          <FileIcon node={{ path: props.path, type: "file" }} class="absolute inset-0 size-4 tab-fileicon-color" />
          <FileIcon node={{ path: props.path, type: "file" }} mono class="absolute inset-0 size-4 tab-fileicon-mono" />
        </span>
      </Show>
      <span class="text-14-medium truncate">{getFilename(props.path)}</span>
    </div>
  )
}

export function SortableTab(props: { tab: string; onTabClose: (tab: string) => void }): JSX.Element {
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const { view } = useSessionLayout()
  const sortable = createSortable(props.tab)
  const path = createMemo(() => file.pathFromTab(props.tab))
  // 261115 Red UX-18：当前占着预览槽位的标签给一个「固定」动作——点击后清掉预览
  // 标记，之后的一次性打开（diff/工具输出）不会再顶掉它。
  const isPreview = createMemo(() => view().previewTab.current() === props.tab)
  const content = createMemo(() => {
    const value = path()
    if (!value) return
    return <FileVisual path={value} />
  })
  return (
    <div use:sortable class="h-full flex items-center" classList={{ "opacity-0": sortable.isActiveDraggable }}>
      <div class="relative">
        <Tabs.Trigger
          value={props.tab}
          closeButton={
            <div class="flex items-center">
              <Show when={isPreview()}>
                <Tooltip value={language.t("common.pinTab")} placement="bottom" gutter={4}>
                  <IconButton
                    icon="pin"
                    variant="ghost"
                    class="h-5 w-5"
                    onClick={() => view().previewTab.set(undefined)}
                    aria-label={language.t("common.pinTab")}
                  />
                </Tooltip>
              </Show>
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
                  onClick={() => props.onTabClose(props.tab)}
                  aria-label={language.t("common.closeTab")}
                />
              </TooltipKeybind>
            </div>
          }
          hideCloseButton
          onMiddleClick={() => props.onTabClose(props.tab)}
        >
          <Show when={content()}>{(value) => value()}</Show>
        </Tabs.Trigger>
      </div>
    </div>
  )
}
