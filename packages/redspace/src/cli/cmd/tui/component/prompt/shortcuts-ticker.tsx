import { createSignal, createMemo, onMount, onCleanup, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useKV } from "@tui/context/kv"
import { useCommandShortcut } from "../../keymap"

// 260702 Red 输入框下方空白区滚动展示常用快捷键，弱化"很长留空"的观感
const TICK_MS = 220
const SEPARATOR = "   ·   "

const ITEMS: { command: string; label: string }[] = [
  { command: "session.new", label: "新会话" },
  { command: "session.list", label: "会话列表" },
  { command: "model.list", label: "切换模型" },
  { command: "mcp.list", label: "MCP 状态" },
  { command: "theme.switch", label: "切换主题" },
  { command: "help.show", label: "帮助" },
]

export function ShortcutsTicker() {
  const { theme } = useTheme()
  const kv = useKV()
  const shortcuts = ITEMS.map((item) => ({ label: item.label, key: useCommandShortcut(item.command) }))

  const text = createMemo(() =>
    shortcuts
      .flatMap((item) => {
        const key = item.key()
        return key ? [`${key} ${item.label}`] : []
      })
      .join(SEPARATOR),
  )

  const [offset, setOffset] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | undefined
  onMount(() => {
    timer = setInterval(() => {
      const base = text()
      if (!base) return
      setOffset((prev) => (prev + 1) % (base.length + SEPARATOR.length))
    }, TICK_MS)
  })
  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  const display = createMemo(() => {
    const base = text()
    if (!base) return ""
    return (base + SEPARATOR + base).slice(offset())
  })

  return (
    <Show when={text()}>
      <box flexGrow={1} flexShrink={1} overflow="hidden">
        <Show
          when={kv.get("animations_enabled", true)}
          fallback={
            <text wrapMode="none" overflow="hidden" fg={theme.textMuted}>
              {text()}
            </text>
          }
        >
          <text wrapMode="none" overflow="hidden" fg={theme.textMuted}>
            {display()}
          </text>
        </Show>
      </box>
    </Show>
  )
}
