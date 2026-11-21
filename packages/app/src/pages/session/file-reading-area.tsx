import { ErrorBoundary, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useFileComponent } from "@redcode-ai/ui/context/file"
import { Button } from "@redcode-ai/ui/button"
import { Markdown } from "@redcode-ai/ui/markdown"
import { ScrollView } from "@redcode-ai/ui/scroll-view"
import { showToast } from "@redcode-ai/ui/toast"
import { sampledChecksum } from "@redcode-ai/core/util/encode"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { htmlPreviewDocument } from "@/utils/file-preview"

/**
 * 261121 Red 可独立挂载的文件阅读区：从 file-tabs.tsx 的 FileTabContent 分离——
 * 那边的根节点是 Kobalte Tabs.Content，必须在 Code 工作台的标签页上下文里，Chat 弹窗
 * 直接挂它正文空白并抛 useTabsContext。这里只保留「读文件」需要的部分：Markdown 阅读/
 * 源码切换、HTML 显式浏览器预览、图片与其他文件渲染、加载/错误/空态；行评论、行选中、
 * Ctrl+F、标签滚动恢复与「返回变更」都留在 Code 标签页。不依赖 Comments/Prompt/
 * SessionLayout 上下文。
 * 依据 → .redcode/temp/RedSpace-四项体验改进方案.md 方案一
 */
export function FileReadingArea(props: { path: string }) {
  const file = useFile()
  const language = useLanguage()
  const platform = usePlatform()
  const fileComponent = useFileComponent()

  const state = createMemo(() => file.get(props.path))
  const contents = createMemo(() => state()?.content?.content ?? "")
  const markdown = createMemo(() => /\.(md|markdown)$/i.test(props.path))
  const html = createMemo(() => /\.html?$/i.test(props.path))
  const [preview, setPreview] = createSignal<"reading" | "source">("reading")

  const htmlPreview = createMemo(() => {
    if (!html() || !state()?.loaded || !contents()) return
    // 261116 Red HTML only executes after an explicit click, inside an opaque-origin sandbox.
    return URL.createObjectURL(new Blob([htmlPreviewDocument(contents())], { type: "text/html;charset=utf-8" }))
  })
  createEffect(() => {
    const url = htmlPreview()
    if (url) onCleanup(() => URL.revokeObjectURL(url))
  })

  const openHtml = () => {
    const url = htmlPreview()
    if (!url) return
    if (platform.platform === "web") {
      window.open(url, "_blank", "noopener,noreferrer")
      return
    }
    if (!platform.openHtmlPreview) {
      showToast({ variant: "error", title: language.t("file.view.previewUnavailable") })
      return
    }
    void platform
      .openHtmlPreview(htmlPreviewDocument(contents()))
      .catch((error: unknown) =>
        showToast({
          variant: "error",
          title: language.t("common.requestFailed"),
          description: error instanceof Error ? error.message : String(error),
        }),
      )
  }

  const retry = () => void file.load(props.path, { force: true })

  const cacheKey = createMemo(() => sampledChecksum(contents()))

  const renderFile = (source: string) => (
    <Dynamic
      component={fileComponent}
      mode="text"
      file={{
        name: props.path,
        contents: source,
        cacheKey: cacheKey(),
      }}
      class="select-text"
      media={{
        mode: "auto",
        path: props.path,
        current: state()?.content,
        onError: (args: { kind: "image" | "audio" | "svg" | "pdf" }) => {
          if (args.kind !== "svg") return
          showToast({
            variant: "error",
            title: language.t("toast.file.loadFailed.title"),
          })
        },
      }}
    />
  )

  return (
    <div class="relative flex h-full min-h-0 flex-col">
      <Show when={state()?.loaded && (markdown() || html())}>
        <div class="mx-3 mb-2 flex shrink-0 flex-wrap items-center gap-2" data-component="file-reading-toolbar">
          <Show when={markdown()}>
            <Button size="small" variant={preview() === "source" ? "ghost" : "secondary"} onClick={() => setPreview("reading")}>
              {language.t("file.view.reading")}
            </Button>
            <Button size="small" variant={preview() === "source" ? "secondary" : "ghost"} onClick={() => setPreview("source")}>
              {language.t("file.view.source")}
            </Button>
          </Show>
          <Show when={html()}>
            <Button size="small" variant="secondary" onClick={openHtml}>
              {language.t("file.view.browser")}
            </Button>
            <Button size="small" variant="ghost" onClick={() => setPreview("source")}>
              {language.t("file.view.source")}
            </Button>
            <span class="text-sm text-text-weak">{language.t("file.view.htmlHint")}</span>
          </Show>
        </div>
      </Show>
      {/* 261121 Red 预览渲染异常只在弹窗内现错，不影响背后的聊天操作。 */}
      {/* 261121 Red 方案④：正文还在时的刷新失败只挂状态条，不接管整个视图——
          文件暂时读不到就保留旧文，恢复成功后 setLoaded 会自动替换。 */}
      <Show when={state()?.error && contents()}>
        <div class="flex shrink-0 items-center gap-3 border-b border-border-weak-base bg-surface-raised-base px-6 py-1.5">
          <p class="min-w-0 flex-1 truncate text-12-regular text-text-weak">{language.t("file.view.staleNotice")}</p>
          <Button size="small" variant="ghost" onClick={retry}>
            {language.t("common.retry")}
          </Button>
        </div>
      </Show>
      {/* 261121 Red 方案④：占位只在第一次打开（还没有任何正文）时出现。后台刷新
          （watcher 强刷 / 重试）期间保留最后成功读到的正文，正文不卸载，滚动位置
          自然保住——连续保存不再把正在读的文档顶回空白。 */}
      <ErrorBoundary
        fallback={(error) => (
          <div class="flex-1 overflow-auto px-6 py-4 text-13-regular text-text-critical-base">
            {error instanceof Error ? error.message : String(error)}
          </div>
        )}
      >
        <ScrollView class="min-h-0 flex-1">
          <Switch>
            <Match when={state()?.loading && !contents()}>
              <div class="px-6 py-4 text-text-weak">{language.t("common.loading")}...</div>
            </Match>
            <Match when={state()?.error && !contents()}>
              <div class="flex flex-col items-start gap-2 px-6 py-4">
                <p class="text-13-regular text-text-critical-base">{state()?.error}</p>
                <p class="font-mono text-12-regular text-text-weak" title={props.path}>
                  {props.path}
                </p>
                <Button size="small" variant="secondary" onClick={retry}>
                  {language.t("common.retry")}
                </Button>
              </div>
            </Match>
            <Match when={state()?.loaded && contents()}>
              <Show when={markdown() && preview() === "reading"} fallback={renderFile(contents())}>
                <Markdown
                  class="mx-auto w-full max-w-[75ch] px-6 py-4 pb-40 select-text"
                  text={contents()}
                  cacheKey={cacheKey()}
                />
              </Show>
            </Match>
            <Match when={state()?.loaded}>
              <p class="px-6 py-4 text-13-regular text-text-weak">{language.t("file.empty")}</p>
            </Match>
          </Switch>
        </ScrollView>
      </ErrorBoundary>
    </div>
  )
}
