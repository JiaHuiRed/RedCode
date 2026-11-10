import { Show, createMemo } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSync } from "@/context/sync"
import { useSessionKey } from "@/context/session-layout"
import { deriveActivity, targetLabel, targetTitle, type ActivityPart } from "./activity"

// 261109 Karina UX-02：输入框上方的实时工作状态台（GUI）。
//
// 数据全部来自已加载的 part / session_status / permission，不需要模型配合，也不做
// 百分比进度。会话空闲时整块隐藏，只在真正工作时占据一行；失败数与待确认数永远
// 单独显示，不能被折叠掉。
// 261110 Red 字号接 token：固定 11px 换 --font-size-x-small，随外观字号档等比缩放。
// 261110 Red 统计范围收敛到当前用户回合：上一轮的失败不再挂在下一轮的状态里；
// 回合起点不在已加载窗口时明示统计不完整。target 显示按 kind 走（命令不做 basename）。
export function SessionActivityHud() {
  const sync = useSync()
  const { params } = useSessionKey()
  const language = useLanguage()

  const session = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const status = createMemo(() => (params.id ? (sync.data.session_status[params.id]?.type ?? "idle") : "idle"))
  const working = createMemo(() => status() !== "idle")

  // 回合范围：最后一条用户消息及其后的消息才算本轮；找不到说明起点不在已加载窗口里。
  const turnStart = createMemo(() => {
    if (!params.id) return -1
    return (sync.data.message[params.id] ?? []).findLastIndex((message) => message.role === "user")
  })
  const parts = createMemo<ActivityPart[]>(() => {
    if (!params.id || turnStart() === -1) return []
    const messages = sync.data.message[params.id] ?? []
    return messages.slice(turnStart()).flatMap((message) => sync.data.part[message.id] ?? [])
  })
  const turnIncomplete = createMemo(() => working() && turnStart() === -1)
  const activity = createMemo(() => deriveActivity(parts()))
  const permissions = createMemo(() => (params.id ? (sync.data.permission[params.id]?.length ?? 0) : 0))
  const children = createMemo(() => {
    if (!params.id || session()?.parentID) return []
    return (sync.data.session ?? []).filter((item) => item.parentID === params.id)
  })
  const runningChildren = createMemo(
    () =>
      children().filter((child) => {
        const state = sync.data.session_status[child.id]?.type ?? "idle"
        return state !== "idle"
      }).length,
  )

  return (
    <Show when={working() || permissions() > 0 || runningChildren() > 0}>
      <div
        class="mb-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-1 text-[length:var(--font-size-x-small)] leading-[1.3] text-[var(--v2-text-text-muted)]"
        role="status"
        aria-live="polite"
      >
        <Show when={working()}>
          <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-[var(--v2-background-bg-accent)] motion-reduce:animate-none" />
        </Show>
        <Show when={activity().running} keyed>
          {(running) => (
            <span
              class="min-w-0 truncate text-[var(--v2-text-text-base)]"
              title={running.target ? targetTitle(running.target) : undefined}
            >
              {running.tool}
              <Show when={running.target}>
                <span class="text-[var(--v2-text-text-muted)]"> · {targetLabel(running.target!)}</span>
              </Show>
            </span>
          )}
        </Show>
        <span class="shrink-0 tabular-nums">
          {language.t("session.activity.read")} {activity().counts.read} · {language.t("session.activity.edit")}{" "}
          {activity().counts.edit} · {language.t("session.activity.command")} {activity().counts.command}
        </span>
        <Show when={activity().counts.failed > 0}>
          <span class="shrink-0 text-[var(--v2-text-text-danger,var(--text-danger))]">
            {language.t("session.activity.failed")} {activity().counts.failed}
          </span>
        </Show>
        <Show when={permissions() > 0}>
          <span class="shrink-0 font-[530] text-[var(--v2-text-text-warning,var(--text-warning))]">
            {language.t("session.activity.permission")}
          </span>
        </Show>
        <Show when={runningChildren() > 0}>
          <span class="shrink-0">
            {language.t("session.activity.subagents")} {runningChildren()}/{children().length}
          </span>
        </Show>
        <Show when={turnIncomplete()}>
          <span class="shrink-0">{language.t("session.activity.incomplete")}</span>
        </Show>
      </div>
    </Show>
  )
}
