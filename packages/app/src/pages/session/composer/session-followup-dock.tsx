import { For, Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@redcode-ai/ui/button"
import { useLanguage } from "@/context/language"
import { CollapsibleDock } from "./collapsible-dock"

export function SessionFollowupDock(props: {
  items: { id: string; text: string; source: "legacy" | "server" }[]
  sending?: string
  action?: string
  onSend: (id: string) => void
  onEdit: (id: string) => void
  onUpdate: (id: string, text: string) => Promise<boolean>
  onCancel: (id: string) => void
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({
    collapsed: false,
    editing: undefined as string | undefined,
    editText: "",
  })

  const toggle = () => setStore("collapsed", (value) => !value)
  const save = async (id: string) => {
    if (await props.onUpdate(id, store.editText)) setStore({ editing: undefined, editText: "" })
  }
  const total = createMemo(() => props.items.length)
  const label = createMemo(() =>
    language.t(total() === 1 ? "session.followupDock.summary.one" : "session.followupDock.summary.other", {
      count: total(),
    }),
  )
  const preview = createMemo(() => props.items[0]?.text ?? "")

  return (
    <CollapsibleDock
      dataComponent="session-followup-dock"
      label={label()}
      preview={preview()}
      collapsed={store.collapsed}
      onToggle={toggle}
      labelClass="text-13-medium"
      previewClass="text-13-regular"
      trayStyle={{
        "margin-bottom": "-0.875rem",
        "border-bottom-left-radius": 0,
        "border-bottom-right-radius": 0,
      }}
    >
      <For each={props.items}>
        {(item) => (
          <div class="flex min-w-0 items-center gap-2 py-1">
            {/* 261106 Red 折叠外壳抽到 CollapsibleDock，此处只留条目内容（编辑/三键操作） */}
            <Show
              when={store.editing === item.id}
              fallback={<span class="min-w-0 flex-1 truncate text-13-regular text-text-strong">{item.text}</span>}
            >
              <textarea
                rows={2}
                value={store.editText}
                class="min-w-0 flex-1 resize-y rounded-md border border-border-weak-base bg-background-base px-2 py-1 text-13-regular text-text-strong outline-none focus:border-border-weak-hover"
                onInput={(event) => setStore("editText", event.currentTarget.value)}
                onKeyDown={(event) => {
                  event.stopPropagation()
                  if (!event.ctrlKey && !event.metaKey) return
                  if (event.key !== "Enter") return
                  event.preventDefault()
                  void save(item.id)
                }}
              />
            </Show>
            <Show
              when={store.editing === item.id}
              fallback={
                <>
                  <Button
                    size="small"
                    variant="secondary"
                    class="shrink-0"
                    disabled={props.sending === item.id || props.action === item.id}
                    onClick={() => props.onSend(item.id)}
                  >
                    {language.t("session.followupDock.sendNow")}
                  </Button>
                  <Button
                    size="small"
                    variant="ghost"
                    class="shrink-0"
                    disabled={props.sending === item.id || props.action === item.id}
                    onClick={() => {
                      if (item.source === "legacy") {
                        props.onEdit(item.id)
                        return
                      }
                      setStore({ editing: item.id, editText: item.text })
                    }}
                  >
                    {language.t("session.followupDock.edit")}
                  </Button>
                  <Button
                    size="small"
                    variant="ghost"
                    class="shrink-0"
                    disabled={props.sending === item.id || props.action === item.id}
                    onClick={() => props.onCancel(item.id)}
                  >
                    {language.t("session.followupDock.cancel")}
                  </Button>
                </>
              }
            >
              <Button
                size="small"
                variant="secondary"
                class="shrink-0"
                disabled={props.action === item.id}
                onClick={() => void save(item.id)}
              >
                {language.t("session.followupDock.save")}
              </Button>
              <Button
                size="small"
                variant="ghost"
                class="shrink-0"
                onClick={() => setStore({ editing: undefined, editText: "" })}
              >
                {language.t("session.followupDock.cancel")}
              </Button>
            </Show>
          </div>
        )}
      </For>
    </CollapsibleDock>
  )
}
