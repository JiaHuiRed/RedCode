import { createMemo, Match, Show, Switch } from "solid-js"
import { Tabs } from "@redcode-ai/ui/tabs"
import { ResizeHandle } from "@redcode-ai/ui/resize-handle"
import type { SnapshotFileDiff, VcsFileDiff } from "@redcode-ai/sdk/v2"
import FileTree from "@/components/file-tree"
import { useFile } from "@/context/file"
import { FILE_TREE_WIDTH_MIN, useLayout } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { createOpenSessionFileTab, type Sizing } from "./helpers"
import { useSessionLayout } from "./session-layout"

type RenderDiff = (SnapshotFileDiff & { file: string }) | VcsFileDiff

function renderDiff(value: SnapshotFileDiff | VcsFileDiff): value is RenderDiff {
  return typeof value.file === "string"
}

export function FileTreePanel(props: {
  diffsReady: () => boolean
  diffs: () => (SnapshotFileDiff | VcsFileDiff)[]
  reviewCount: () => number
  hasReview: () => boolean
  activeDiff?: string
  focusReviewDiff: (path: string) => void
  size: Sizing
}) {
  const layout = useLayout()
  const file = useFile()
  const language = useLanguage()
  const { tabs } = useSessionLayout()

  const fileOpen = createMemo(() => layout.fileTree.opened())
  // layout.fileTree.width() 已在 context 侧钳到 FILE_TREE_WIDTH_MIN
  const treeWidth = createMemo(() => (fileOpen() ? `${layout.fileTree.width()}px` : "0px"))

  const diffs = createMemo(() => props.diffs().filter(renderDiff))
  const diffFiles = createMemo(() => diffs().map((d) => d.file))
  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }
    const normalize = (p: string) => p.replaceAll("\\\\", "/").replace(/\/+$/, "")
    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of diffs()) {
      const file = normalize(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"
      out.set(file, kind)
      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })

  const nofiles = createMemo(() => {
    const state = file.tree.state("")
    if (!state?.loaded) return false
    return file.tree.children("").length === 0
  })

  const empty = (msg: string) => (
    <div class="h-full flex flex-col">
      <div class="h-6 shrink-0" aria-hidden />
      <div class="flex-1 pb-64 flex items-center justify-center text-center">
        <div class="text-12-regular text-text-weak">{msg}</div>
      </div>
    </div>
  )

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  const openTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel: () => {},
    setActive: tabs().setActive,
  })

  const fileTreeTab = () => layout.fileTree.tab()
  const setFileTreeTabValue = (value: string) => {
    if (value !== "changes" && value !== "all") return
    layout.fileTree.setTab(value)
  }

  return (
    <div
      id="file-tree-panel"
      aria-hidden={!fileOpen()}
      inert={!fileOpen()}
      class="relative min-w-0 h-full shrink-0 overflow-hidden"
      classList={{
        "pointer-events-none": !fileOpen(),
        "transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
          !props.size.active(),
      }}
      style={{ width: treeWidth() }}
    >
      <Show when={fileOpen()}>
        <div class="h-full flex flex-col overflow-hidden group/filetree border-r border-border-weaker-base">
          <Tabs
            variant="pill"
            value={fileTreeTab()}
            onChange={setFileTreeTabValue}
            class="h-full"
            data-scope="filetree"
          >
            <Tabs.List>
              <Tabs.Trigger value="changes" class="flex-1" classes={{ button: "w-full" }}>
                {props.reviewCount()}{" "}
                {language.t(
                  props.reviewCount() === 1 ? "session.review.change.one" : "session.review.change.other",
                )}
              </Tabs.Trigger>
              <Tabs.Trigger value="all" class="flex-1" classes={{ button: "w-full" }}>
                {language.t("session.files.all")}
              </Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content value="changes" class="bg-background-stronger px-3 py-0">
              <Switch>
                <Match when={props.hasReview() || !props.diffsReady()}>
                  <Show
                    when={props.diffsReady()}
                    fallback={
                      <div class="px-2 py-2 text-12-regular text-text-weak">
                        {language.t("common.loading")}
                        {language.t("common.loading.ellipsis")}
                      </div>
                    }
                  >
                    <FileTree
                      path=""
                      class="pt-3"
                      allowed={diffFiles()}
                      kinds={kinds()}
                      draggable={false}
                      active={props.activeDiff}
                      onFileClick={(node) => props.focusReviewDiff(node.path)}
                    />
                  </Show>
                </Match>
              </Switch>
            </Tabs.Content>
            <Tabs.Content value="all" class="bg-background-stronger px-3 py-0">
              <Switch>
                <Match when={nofiles()}>{empty(language.t("session.files.empty"))}</Match>
                <Match when={true}>
                  <FileTree
                    path=""
                    class="pt-3"
                    modified={diffFiles()}
                    kinds={kinds()}
                    onFileClick={(node) => openTab(file.tab(node.path))}
                  />
                </Match>
              </Switch>
            </Tabs.Content>
          </Tabs>
        </div>
        <div onPointerDown={() => props.size.start()}>
          <ResizeHandle
            direction="horizontal"
            size={layout.fileTree.width()}
            min={FILE_TREE_WIDTH_MIN}
            max={480}
            onResize={(width) => {
              props.size.touch()
              layout.fileTree.resize(width)
            }}
          />
        </div>
      </Show>
    </div>
  )
}
