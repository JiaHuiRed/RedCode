import { createMemo, createSignal } from "solid-js"
import { useLocal } from "@tui/context/local"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"

export function soulOptions(
  items: { id: string; name: string; displayName?: string; description?: string }[],
  query = "",
) {
  const search = query.trim().toLowerCase()
  return items
    .filter((item) => {
      if (!search) return true
      return [item.id, item.name, item.displayName, item.description]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(search))
    })
    .map((item) => ({
      value: item.id,
      title: item.displayName ?? item.name,
      description: item.description ?? (item.displayName ? item.name : item.id),
    }))
}

export function DialogSoul(props: { onSelect?: (id: string) => void }) {
  const local = useLocal()
  const dialog = useDialog()
  const [query, setQuery] = createSignal("")

  const options = createMemo(() => soulOptions(local.soul.list(), query()))
  const title = createMemo(() => {
    const saved = local.soul.saved()
    const fallback = local.soul.default()
    const status = saved
      ? `上次：${local.soul.label(saved) ?? saved}`
      : `默认：${local.soul.label(fallback) ?? fallback ?? "server"}`
    return `选择灵魂 · ${status}`
  })

  return (
    <DialogSelect
      title={title()}
      current={local.soul.current()?.id}
      options={options()}
      skipFilter
      onFilter={setQuery}
      onSelect={(option) => {
        local.soul.select(option.value)
        props.onSelect?.(option.value)
        dialog.clear()
      }}
    />
  )
}
