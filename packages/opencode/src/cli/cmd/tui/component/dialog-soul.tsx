import { createMemo } from "solid-js"
import { useLocal } from "@tui/context/local"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"

export function DialogSoul(props: { onSelect?: (id: string) => void }) {
  const local = useLocal()
  const dialog = useDialog()

  const options = createMemo(() =>
    local.soul.list().map((item) => ({
      value: item.id,
      title: item.displayName ?? item.name,
      description: item.displayName ? item.name : item.id,
    })),
  )
  const title = createMemo(() => {
    const saved = local.soul.saved()
    const fallback = local.soul.default()
    const status = saved
      ? `Last: ${local.soul.label(saved) ?? saved}`
      : `Default: ${local.soul.label(fallback) ?? fallback ?? "server"}`
    return `Soul · ${status}`
  })

  return (
    <DialogSelect
      title={title()}
      current={local.soul.current()?.id}
      options={options()}
      onSelect={(option) => {
        local.soul.select(option.value)
        props.onSelect?.(option.value)
        dialog.clear()
      }}
    />
  )
}
