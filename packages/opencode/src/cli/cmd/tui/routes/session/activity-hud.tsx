import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { AssistantMessage as AssistantMessageInfo } from "@redcode-ai/sdk/v2"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { deriveActivity, formatElapsed, targetText, type ActivityPart } from "./activity"

// 261109 Karina UX-02：TUI 实时工作状态台。
//
// 挂在输入框上方、CompactingIndicator 之前：根会话与子会话都能看到（不依赖侧边栏
// 是否展开）。只显示可观察事实——当前 running 工具、读/改/命令计数、失败数、待确认
// 与子代理进度；空闲时整块不渲染，不长期占屏。
// 261110 Red 三处准确性收尾：计时起点改为 running 工具自己的 time.start（拿
// assistant 消息创建时间冒充任务起点，数值语义不明）；统计范围收敛到当前用户回合
// （上一轮的失败不再挂在下一轮的状态里）；回合起点不在已加载窗口时明示统计不完整。
export function SessionActivityHud(props: { sessionID: string }) {
  const sync = useSync()
  const { theme } = useTheme()
  const [now, setNow] = createSignal(Date.now())

  const working = createMemo(() => (sync.data.session_status[props.sessionID]?.type ?? "idle") !== "idle")
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])
  // 回合范围：最后一条用户消息及其后的消息才算本轮；找不到说明起点不在已加载窗口里。
  const turnParts = createMemo<ActivityPart[]>(() => {
    const all = messages()
    const start = all.findLastIndex((message) => message.role === "user")
    const slice = start === -1 ? [] : all.slice(start)
    return slice.flatMap((message) => (sync.data.part[message.id] ?? []) as unknown as ActivityPart[])
  })
  const turnIncomplete = createMemo(() => working() && messages().findLastIndex((message) => message.role === "user") === -1)
  const parts = turnParts
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

  // 计时只反映当前 running 工具自己的开始时间；没有可靠时间就不显示，不拿别的阶段冒充。
  const elapsed = createMemo(() => {
    const start = activity().running?.started
    if (!working() || !start) return undefined
    return formatElapsed(now() - start)
  })

  const runningText = createMemo(() => {
    const running = activity().running
    if (!running) return undefined
    const timer = elapsed() ? ` 已运行 ${elapsed()}` : ""
    const target = running.target ? ` · ${targetText(running.target)}` : ""
    return `${running.tool}${timer}${target}`
  })

  return (
    <Show when={working() || permissions() > 0 || runningChildren() > 0}>
      <box flexShrink={0} paddingLeft={1}>
        <Show when={working()}>
          <text fg={theme.textMuted}>
            {"● "}
            {runningText() ?? "…"}
            {` · 读 ${activity().counts.read} 改 ${activity().counts.edit} 命令 ${activity().counts.command}`}
            <Show when={activity().counts.failed > 0}>
              <span style={{ fg: theme.error }}>{` · 失败 ${activity().counts.failed}`}</span>
            </Show>
            <Show when={turnIncomplete()}>
              <span style={{ fg: theme.textMuted }}> · 统计可能不完整</span>
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
