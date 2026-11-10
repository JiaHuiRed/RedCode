import { For, createMemo, createSignal, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import { useLayout } from "@/context/layout"
import { LAYOUT_PRESETS, type LayoutPreset } from "@/context/layout-preset"
import { useSessionKey } from "@/context/session-layout"
import { useLanguage } from "@/context/language"

// 261109 Karina UX-01：会话顶栏的布局预设切换（专注 / 开发 / 审查）。
// 挂在 titlebar 的 #redcode-session-actions 槽位，不新开一行、不动聊天区几何；
// 点击只走 layout.view(...).preset.apply，宽度与滚动由用户决定，预设不覆盖。
// 261110 Red 字号接 token：固定 11px 换 --font-size-x-small，随外观字号档等比缩放。
export function SessionLayoutPreset() {
  const layout = useLayout()
  const { sessionKey } = useSessionKey()
  const language = useLanguage()
  const view = createMemo(() => layout.view(sessionKey))
  const current = createMemo(() => view().preset.current())
  const [mount, setMount] = createSignal<HTMLElement>()

  onMount(() => setMount(document.getElementById("redcode-session-actions") ?? undefined))

  const label = (preset: LayoutPreset) =>
    preset === "focus"
      ? language.t("session.layout.preset.focus")
      : preset === "build"
        ? language.t("session.layout.preset.build")
        : language.t("session.layout.preset.review")

  return (
    <Portal mount={mount()}>
      <div
        class="mr-1 hidden items-center gap-0.5 rounded-md bg-surface-base/60 p-0.5 md:flex"
        role="group"
        aria-label={language.t("session.layout.preset.label")}
      >
        <For each={LAYOUT_PRESETS}>
          {(preset) => (
            <button
              type="button"
              class="h-6 rounded px-2 text-[length:var(--font-size-x-small)] font-[530] leading-[1.1] transition-colors"
              classList={{
                "bg-[var(--v2-background-bg-accent)] text-[var(--v2-text-text-contrast)]": current() === preset,
                "text-[var(--v2-text-text-muted)] hover:text-[var(--v2-text-text-base)]": current() !== preset,
              }}
              title={label(preset)}
              aria-pressed={current() === preset}
              onClick={() => view().preset.apply(preset)}
            >
              {label(preset)}
            </button>
          )}
        </For>
      </div>
    </Portal>
  )
}
