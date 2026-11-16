import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Icon } from "@redcode-ai/ui/icon"
import { FileIcon } from "@redcode-ai/ui/file-icon"
import { getFilename } from "@redcode-ai/core/util/path"
import { useLanguage } from "@/context/language"
import type { TurnDeliverable } from "./turn-deliverables"
import "./turn-deliverables.css"

export function TurnDeliverables(props: {
  files: TurnDeliverable[]
  onOpen: (file: TurnDeliverable) => void
  onSource: (file: TurnDeliverable) => void
}) {
  const language = useLanguage()
  const [state, setState] = createStore({ limit: 4 })
  const visible = createMemo(() => props.files.slice(0, state.limit))
  const remaining = () => Math.max(0, props.files.length - state.limit)
  const action = (file: TurnDeliverable) =>
    language.t(
      file.kind === "document"
        ? "session.deliverables.read"
        : file.kind === "file" || file.kind === "page"
          ? "session.deliverables.open"
          : "session.deliverables.preview",
    )

  return (
    <Show when={props.files.length > 0}>
      <section data-component="turn-deliverables" aria-label={language.t("session.deliverables.title")}>
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
                  aria-label={`${action(file)} ${file.path}`}
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
                    {action(file)}
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
      </section>
    </Show>
  )
}
