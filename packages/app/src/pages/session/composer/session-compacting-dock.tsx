import { onCleanup, onMount, createMemo, createSignal, Show } from "solid-js"
import { DockTray } from "@redcode-ai/ui/dock-surface"
import { Spinner } from "@redcode-ai/ui/spinner"
import { useLanguage } from "@/context/language"

// 261013 Red 压缩中 dock：session.time.compacting 非空 = 正在压缩（与 home-kanban 卡片徽标
// 同源读法）。TUI 对应 CompactingIndicator（输入区常驻显示当前尝试与耗时），GUI 此前只有
// 看板徽标，会话页内毫无指示。结构仿 session-followup-dock 的 DockTray；秒表沿用
// TimelineThinkingRow 的 setInterval 先例。
export function SessionCompactingDock(props: { start: number }) {
  const language = useLanguage()
  const [now, setNow] = createSignal(Date.now())
  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  const elapsed = createMemo(() => {
    const seconds = Math.max(0, Math.round((now() - props.start) / 1000))
    const minutes = Math.floor(seconds / 60)
    return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
  })

  return (
    <Show when={Number.isFinite(props.start)}>
      <DockTray data-component="session-compacting-dock">
        <div class="flex items-center gap-2 px-3 py-2" role="status" aria-live="polite">
          <Spinner class="size-3.5 shrink-0 text-text-weak" />
          <span class="text-13-medium text-text-strong">{language.t("ui.messagePart.compaction.compacting")}</span>
          <span class="ml-auto shrink-0 text-12-regular text-text-weak tabular-nums">{elapsed()}</span>
        </div>
      </DockTray>
    </Show>
  )
}
