import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@redcode-ai/ui/icon"
import { FileIcon } from "@redcode-ai/ui/file-icon"
import { getFilename } from "@redcode-ai/core/util/path"
import { useLanguage } from "@/context/language"
import type { TurnDeliverable } from "./turn-deliverables"
import "./turn-deliverables.css"

type Language = ReturnType<typeof useLanguage>

const actionLabel = (file: TurnDeliverable, language: Language) =>
  language.t(
    file.kind === "document"
      ? "session.deliverables.read"
      : file.kind === "file" || file.kind === "page"
        ? "session.deliverables.open"
        : "session.deliverables.preview",
  )

const directoryOf = (path: string) => {
  const dir = path.slice(0, path.length - getFilename(path).length)
  return dir.endsWith("/") ? dir : ""
}

// 261121 Red 单文件紧凑卡（方案四）：第一行 图标+文件名+主动作 是同一主按钮，
// 第二行 目录·变更状态 与「查看来源」分列两端；来源是独立按钮，Tab 按视觉顺序聚焦，
// 悬停/键盘聚焦经 title 看完整路径。文件级 aria-label 保留完整路径。
function CompactDeliverable(props: { file: TurnDeliverable; language: Language; onOpen: () => void; onSource: () => void }) {
  return (
    <article class="turn-deliverable-compact" data-kind={props.file.kind}>
      <button
        type="button"
        class="turn-deliverable-compact-open"
        aria-label={`${actionLabel(props.file, props.language)} ${props.file.path}`}
        title={props.file.path}
        onClick={props.onOpen}
      >
        <span class="turn-deliverable-compact-icon">
          <FileIcon node={{ path: props.file.path, type: "file" }} />
        </span>
        <strong class="turn-deliverable-compact-name">{getFilename(props.file.path)}</strong>
        <span class="turn-deliverable-compact-action">
          {actionLabel(props.file, props.language)}
          <Icon name="arrow-right" size="small" />
        </span>
      </button>
      <div class="turn-deliverable-compact-meta">
        <Show when={directoryOf(props.file.path)}>
          <>
            <span class="turn-deliverable-compact-dir" dir="auto" title={props.file.path}>
              {directoryOf(props.file.path)}
            </span>
            <span aria-hidden="true">·</span>
          </>
        </Show>
        <span class="turn-deliverable-compact-change">
          {props.language.t(`session.deliverables.change.${props.file.change}`)}
        </span>
        <button
          type="button"
          class="turn-deliverable-compact-source"
          aria-label={`${props.language.t("session.deliverables.source")} ${props.file.path}`}
          title={props.file.path}
          onClick={props.onSource}
        >
          <Icon name="arrow-undo-down" size="small" />
          {props.language.t("session.deliverables.source")}
        </button>
      </div>
    </article>
  )
}

export function TurnDeliverables(props: {
  files: TurnDeliverable[]
  onOpen: (file: TurnDeliverable) => void
  onSource: (file: TurnDeliverable) => void
}) {
  const language = useLanguage()
  const [state, setState] = createStore({ limit: 4 })
  const visible = createMemo(() => props.files.slice(0, state.limit))
  const remaining = () => Math.max(0, props.files.length - state.limit)
  // 261121 Red 布局按成果总数选：0 隐藏、1 紧凑横卡、2+ 沿用网格与分页。
  const single = () => props.files.length === 1
  const file = () => props.files[0]!

  return (
    <Show when={props.files.length > 0}>
      <section
        data-component="turn-deliverables"
        data-single={single() ? "" : undefined}
        aria-label={language.t("session.deliverables.title")}
      >
        <Show
          when={!single()}
          fallback={
            <CompactDeliverable
              file={file()}
              language={language}
              onOpen={() => props.onOpen(file())}
              onSource={() => props.onSource(file())}
            />
          }
        >
          <header class="turn-deliverables-header">
            <div class="turn-deliverables-heading">
              <span class="turn-deliverables-mark">
                <Icon name="folder" size="normal" />
              </span>
              <div>
                <h3>
                  {language.t("session.deliverables.title")}{" "}
                  <span class="turn-deliverables-count">{props.files.length}</span>
                </h3>
                <p>{language.t("session.deliverables.subtitle")}</p>
              </div>
            </div>
          </header>
          <div class="turn-deliverables-grid">
            <For each={visible()}>
              {(file) => (
                <article class="turn-deliverable" data-kind={file.kind}>
                  <button
                    type="button"
                    class="turn-deliverable-open"
                    aria-label={`${actionLabel(file, language)} ${file.path}`}
                    title={file.path}
                    onClick={() => props.onOpen(file)}
                  >
                    <span class="turn-deliverable-topline">
                      <span class="turn-deliverable-icon">
                        <FileIcon node={{ path: file.path, type: "file" }} />
                      </span>
                      <span class="turn-deliverable-kind">{language.t(`session.deliverables.kind.${file.kind}`)}</span>
                    </span>
                    <strong>{getFilename(file.path)}</strong>
                    <span class="turn-deliverable-path" dir="auto">
                      {file.path}
                    </span>
                    <span class="turn-deliverable-action">
                      {actionLabel(file, language)}
                      <Icon name="arrow-right" size="small" />
                    </span>
                  </button>
                  <footer>
                    <span>{language.t(`session.deliverables.change.${file.change}`)}</span>
                    <button
                      type="button"
                      aria-label={`${language.t("session.deliverables.source")} ${file.path}`}
                      onClick={() => props.onSource(file)}
                    >
                      <Icon name="arrow-undo-down" size="small" />
                      {language.t("session.deliverables.source")}
                    </button>
                  </footer>
                </article>
              )}
            </For>
          </div>
          <div class="turn-deliverables-footer">
            <span>{language.t("session.deliverables.currentVersion")}</span>
            <div class="turn-deliverables-pagination">
              <Show when={state.limit > 4}>
                <button type="button" onClick={() => setState("limit", 4)}>
                  {language.t("session.deliverables.less")}
                </button>
              </Show>
              <Show when={remaining() > 0}>
                <button type="button" onClick={() => setState("limit", state.limit + 8)}>
                  {language.t("session.deliverables.more", { count: Math.min(8, remaining()) })}
                  <Icon name="chevron-down" size="small" />
                </button>
              </Show>
            </div>
          </div>
        </Show>
      </section>
    </Show>
  )
}
