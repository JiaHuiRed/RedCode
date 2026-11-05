import { For, createEffect, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@redcode-ai/ui/button"
import { useLanguage } from "@/context/language"
import { CollapsibleDock } from "./collapsible-dock"

export function SessionRevertDock(props: {
  items: { id: string; text: string }[]
  restoring?: string
  disabled?: boolean
  onRestore: (id: string) => void
}) {
  const language = useLanguage()
  const [store, setStore] = createStore({
    collapsed: true,
  })

  createEffect(() => {
    props.items.length
    props.items[0]?.id
    setStore("collapsed", true)
  })

  const toggle = () => setStore("collapsed", (value) => !value)
  const total = createMemo(() => props.items.length)
  const label = createMemo(() =>
    language.t(total() === 1 ? "session.revertDock.summary.one" : "session.revertDock.summary.other", {
      count: total(),
    }),
  )
  const preview = createMemo(() => props.items[0]?.text ?? "")

  return (
    <CollapsibleDock
      dataComponent="session-revert-dock"
      label={label()}
      preview={preview()}
      collapsed={store.collapsed}
      onToggle={toggle}
      ariaKeyPrefix="session.revertDock"
      labelClass="text-14-regular"
      previewClass="text-14-regular"
    >
      <For each={props.items}>
        {(item) => (
          <div class="flex items-center gap-2 min-w-0 py-1">
            {/* 261106 Red 折叠外壳抽到 CollapsibleDock，此处只留条目内容 */}
            <span class="min-w-0 flex-1 truncate text-13-regular text-text-strong">{item.text}</span>
            <Button
              size="small"
              variant="secondary"
              class="shrink-0"
              disabled={props.disabled || !!props.restoring}
              onClick={() => props.onRestore(item.id)}
            >
              {language.t("session.revertDock.restore")}
            </Button>
          </div>
        )}
      </For>
    </CollapsibleDock>
  )
}
