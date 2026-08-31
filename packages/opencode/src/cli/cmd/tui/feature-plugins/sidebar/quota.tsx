import type { TuiPlugin, TuiPluginApi } from "@redcode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createMemo, For, Show } from "solid-js"

const id = "internal:sidebar-quota"

// 260831 Red 额度面板：GET /provider/quota + provider.quota.updated 全局事件
// （服务端 quota.ts 捕获 x-codex-* 响应头；该数据只在此展示，无定时器、无轮询）
function View(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.provider_quota())

  const color = (pct: number) => {
    if (pct >= 90) return theme().error
    if (pct >= 60) return theme().warning
    return theme().info
  }

  const bar = (pct: number, width = 10) => {
    const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width)
    return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled))
  }

  // 时长：>1440 显示 d，>60 显示 h，否则 m
  const duration = (minutes: number) => {
    if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`
    if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`
    return `${minutes}m`
  }

  // 重置时刻：unix 秒 ×1000 转本地 HH:mm（绝对时刻，不做倒计时）
  const reset = (resetAt: number) => {
    if (!resetAt) return ""
    return new Date(resetAt * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  }

  // 260831 Red hey-api 把数字字段生成成 number | 字符串三元组，统一归一化为 number
  const WindowRow = (props: {
    label: string
    window: { usedPercent?: number | string; windowMinutes?: number | string; resetAt?: number | string }
  }) => {
    const pct = () => Number(props.window.usedPercent ?? 0)
    const minutes = () => Number(props.window.windowMinutes ?? 0)
    const at = () => Number(props.window.resetAt ?? 0)
    return (
      <box flexDirection="row" gap={1}>
        <text flexShrink={0} fg={theme().textMuted}>
          {props.label}
        </text>
        <text flexShrink={0} fg={color(pct())}>
          {pct()}%
        </text>
        <text fg={theme().textMuted}>{bar(pct())}</text>
        <Show when={minutes() > 0}>
          <text fg={theme().textMuted}>{duration(minutes())}</text>
        </Show>
        <Show when={at() > 0}>
          <text fg={theme().textMuted}>→ {reset(at())}</text>
        </Show>
      </box>
    )
  }

  return (
    <Show when={list().length > 0}>
      {/* 260615 Red section with border title */}
      <box
        border={["top"]}
        borderColor={theme().borderSubtle ?? theme().textMuted}
        title=" Quota "
        titleAlignment="left"
        paddingTop={0}
      >
        <For each={list()}>
          {(q) => (
            <box flexDirection="column" gap={0}>
              <box flexDirection="row" justifyContent="space-between">
                <text fg={theme().text}>
                  <b>{q.planType}</b>
                </text>
                <text fg={theme().textMuted}>{q.accountID}</text>
              </box>
              <Show when={q.primary}>
                <WindowRow label="Primary" window={q.primary!} />
              </Show>
              <Show when={q.secondary}>
                <WindowRow label="Weekly" window={q.secondary!} />
              </Show>
              <Show when={q.reserve}>
                <WindowRow label={q.reserveName ?? "Reserve"} window={q.reserve!} />
              </Show>
              <Show when={!q.primary && !q.secondary && !q.reserve}>
                <text fg={theme().textMuted}>—</text>
              </Show>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 250,
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
