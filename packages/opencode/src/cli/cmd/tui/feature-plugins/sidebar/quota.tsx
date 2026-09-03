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

  // 260902 cc 拆成 filled / rest 两段，跟 context.tsx 的 bar() 一个形状——原来整条（含已用
  // 部分）都上 textMuted，等于画了条没颜色的灰带，3% 的时候完全看不出这是个进度条。
  // 宽度仍是 10 不复用 context 的 24：这一行还要放 label / 百分比 / 窗口长度 / 重置时刻，
  // 侧栏只有 ~38 列，24 会把后面的字全挤掉。
  const bar = (pct: number, width = 10) => {
    const filled = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width)
    return { filled: "█".repeat(filled), rest: "░".repeat(Math.max(0, width - filled)) }
  }

  // 侧栏只有 ~38 列，36 字符的账号 ID 一定换行；而套餐名没写 flexShrink 时会被 flex 压缩，
  // 实测 "plus" 被压成 "plu"（末字被账号 ID 顶掉）。取 UUID 第一段足够区分账号。
  const shortAccount = (id: string) => id.split("-")[0] || id

  // 时长：>1440 显示 d，>60 显示 h，否则 m
  const duration = (minutes: number) => {
    if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`
    if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`
    return `${minutes}m`
  }

  // 260903 Red 长窗口补日期，避免 7d 的重置时间看起来像“每天同一时刻”
  const reset = (resetAt: number, includeDate: boolean) => {
    if (!resetAt) return ""
    const date = new Date(resetAt * 1000)
    const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    if (!includeDate) return time
    return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`
  }

  // 260831 Red hey-api 把数字字段生成成 number | 字符串三元组，统一归一化为 number
  const WindowRow = (props: {
    label: string
    window: { usedPercent?: number | string; windowMinutes?: number | string; resetAt?: number | string }
    showDuration?: boolean
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
        <text flexShrink={0}>
          <span style={{ fg: color(pct()) }}>{bar(pct()).filled}</span>
          <span style={{ fg: theme().textMuted }}>{bar(pct()).rest}</span>
        </text>
        <Show when={props.showDuration !== false && minutes() > 0}>
          <text fg={theme().textMuted}>{duration(minutes())}</text>
        </Show>
        <Show when={at() > 0}>
          <text fg={theme().textMuted}>→ {reset(at(), minutes() >= 1440)}</text>
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
              <box flexDirection="row" justifyContent="space-between" gap={1}>
                <text flexShrink={0} fg={theme().text}>
                  <b>{q.planType}</b>
                </text>
                <Show when={q.accountID}>
                  {(accountID) => <text fg={theme().textMuted}>{shortAccount(accountID())}</text>}
                </Show>
              </box>
              <Show when={q.primary}>
                <WindowRow label="Primary" window={q.primary!} />
              </Show>
              <Show when={q.secondary}>
                <WindowRow label="Weekly" window={q.secondary!} showDuration={false} />
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
