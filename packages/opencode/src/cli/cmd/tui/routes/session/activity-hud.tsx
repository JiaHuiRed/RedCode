import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { AssistantMessage as AssistantMessageInfo } from "@redcode-ai/sdk/v2"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { deriveActivity, formatElapsed, type ActivityPart } from "./activity"

// 261109 Karina UX-02：TUI 实时工作状态台。
//
// 挂在输入框上方、CompactingIndicator 之前：根会话与子会话都能看到（不依赖侧边栏
// 是否展开）。只显示可观察事实——当前 running 工具、已加载范围内的读/改/命令计数、
// 失败数、待确认与子代理进度；空闲时整块不渲染，不长期占屏。
export function SessionActivityHud(props: { sessionID: string }) {
  const sync = useSync()
  const { theme } = useTheme()
  const [now, setNow] = createSignal(Date.now())

  const working = createMemo(() => (sync.data.session_status[props.sessionID]?.type ?? "idle") !== "idle")
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])
  const started = createMemo(() => {
    const pending = messages().findLast(
      (message): message is AssistantMessageInfo => message.role === "assistant" && !message.time.completed,
    )
    return pending?.time.created
  })
  const parts = createMemo<ActivityPart[]>(() =>
    messages().flatMap((message) => (sync.data.part[message.id] ?? []) as unknown as ActivityPart[]),
  )
  const activity = createMemo(() => deriveActivity(parts()))
  const permissions = createMemo(() => (sync.data.permission[props.sessionID] ?? []).length)
  const children = createMemo(() => (sync.data.session ?? []).filter((item) => item.parentID === props.sessionID))
  const runningChildren = createMemo(
    () =>
      children().filter((child) => (sync.data.session_status[child.id]?.type ?? "idle") !== "idle").length,
  )

  createEffect(() => {
    if (!working()) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const elapsed = createMemo(() => {
    if (!working()) return undefined
    const start = started()
    if (!start) return "00:00"
    return formatElapsed(now() - start)
  })

  const target = (value: string) => {
    const normalized = value.replaceAll("\\", "/")
    const index = normalized.lastIndexOf("/")
    return index === -1 ? normalized : normalized.slice(index + 1)
  }

  return (
    <Show when={working() || permissions() > 0 || runningChildren() > 0}>
      <box flexShrink={0} paddingLeft={1}>
        <Show when={working()}>
          <text fg={theme.textMuted}>
            {"● "}
            {elapsed() ?? "00:00"}
            {" · "}
            {activity().running
              ? `${activity().running!.tool}${activity().running!.target ? ` ${target(activity().running!.target!)}` : ""}`
              : "…"}
            {` · 读 ${activity().counts.read} 改 ${activity().counts.edit} 命令 ${activity().counts.command}`}
            <Show when={activity().counts.failed > 0}>
              <span style={{ fg: theme.error }}>{` · 失败 ${activity().counts.failed}`}</span>
            </Show>
          </text>
        </Show>
        <Show when={permissions() > 0 || runningChildren() > 0}>
          <text fg={permissions() > 0 ? theme.warning : theme.textMuted}>
            {permissions() > 0 ? "需要你的确认" : ""}
            {permissions() > 0 && runningChildren() > 0 ? " · " : ""}
            {runningChildren() > 0 ? `子代理 ${runningChildren()}/${children().length}` : ""}
          </text>
        </Show>
      </box>
    </Show>
  )
}
