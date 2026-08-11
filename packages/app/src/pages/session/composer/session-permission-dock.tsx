import { For, onCleanup, onMount, Show } from "solid-js"
import type { PermissionRequest } from "@redcode-ai/sdk/v2"
import { Button } from "@redcode-ai/ui/button"
import { DockPrompt } from "@redcode-ai/ui/dock-prompt"
import { Icon } from "@redcode-ai/ui/icon"
import { Keybind } from "@redcode-ai/ui/keybind"
import { useLanguage } from "@/context/language"

export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
}) {
  const language = useLanguage()
  const isMac = navigator.platform.includes("Mac")
  const modLabel = () => (isMac ? "⌘" : "Ctrl")

  // 260811 Red 权限弹窗键盘快捷键（哥哥需求，参照 Claude）：
  // Ctrl/Cmd+Enter = 允许一次，Ctrl/Cmd+Shift+Enter = 始终允许，Esc = 拒绝
  // 用 window 级监听而非 DockPrompt onKeyDown：焦点可能在输入框（哥哥「正在打字时也能按」），
  // dock 内 onKeyDown 只在弹窗自身捕获，输入框内按键不会冒泡到
  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (props.responding) return
      const mod = event.ctrlKey || event.metaKey
      if (event.key === "Escape") {
        event.preventDefault()
        event.stopPropagation()
        props.onDecide("reject")
      } else if (mod && event.key === "Enter" && event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        props.onDecide("always")
      } else if (mod && event.key === "Enter") {
        event.preventDefault()
        event.stopPropagation()
        props.onDecide("once")
      }
    }
    window.addEventListener("keydown", onKeyDown)
    onCleanup(() => window.removeEventListener("keydown", onKeyDown))
  })

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.permission}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{language.t("notification.permission.title")}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Button variant="ghost" size="normal" onClick={() => props.onDecide("reject")} disabled={props.responding}>
              {language.t("ui.permission.deny")}
              <Keybind>Esc</Keybind>
            </Button>
            <Button
              variant="secondary"
              size="normal"
              onClick={() => props.onDecide("always")}
              disabled={props.responding}
            >
              {language.t("ui.permission.allowAlways")}
              <Keybind>{modLabel()}+Shift+Enter</Keybind>
            </Button>
            <Button variant="primary" size="normal" onClick={() => props.onDecide("once")} disabled={props.responding}>
              {language.t("ui.permission.allowOnce")}
              <Keybind>{modLabel()}+Enter</Keybind>
            </Button>
          </div>
        </>
      }
    >
      <Show when={toolDescription()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{toolDescription()}</div>
        </div>
      </Show>

      <Show when={props.request.patterns.length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={props.request.patterns}>
              {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
            </For>
          </div>
        </div>
      </Show>
    </DockPrompt>
  )
}
