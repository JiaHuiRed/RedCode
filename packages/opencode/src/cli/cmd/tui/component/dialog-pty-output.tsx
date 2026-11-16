import { createEffect, createMemo, createResource, onCleanup, onMount, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import stripAnsi from "strip-ansi"
import type { PtyOutput } from "@redcode-ai/sdk/v2"
import { errorMessage } from "@/util/error"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useBindings } from "../keymap"
import {
  ptyCommandLine,
  ptyOutputNotice,
  ptySourceNote,
  ptyStatusNote,
  PTY_DISPLAY_LIMIT,
  PTY_STATUS,
  type BackgroundPty,
} from "./background-detail"

// 261116 Red A02：后台终端的只读输出详情。不创建终端、不重放启动命令、不向进程写输入；
// 返回后台是独立动作，终止仍留在后台面板的确认流程里。
export function DialogPtyOutput(props: { pty: BackgroundPty; onBack: () => void }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  onMount(() => {
    dialog.setSize("large")
  })

  type Snapshot = { data?: PtyOutput; status?: BackgroundPty["status"]; error?: string }
  const [result, { refetch }] = createResource(
    () => props.pty.id,
    async (id, previous): Promise<Snapshot> => {
      const input = { ptyID: id, directory: sync.path.directory || sdk.directory }
      const info = await sdk.client.pty.get(input).then(
        (value) => ({ status: value.data?.status, error: value.error ? errorMessage(value.error) : undefined }),
        (error) => ({ status: undefined, error: errorMessage(error) }),
      )
      if (!info.status || info.error) return { data: previous.value?.data, error: info.error ?? "终端已不存在" }
      return sdk.client.pty.output(input).then(
        (value) => ({
          data: value.data ?? previous.value?.data,
          status: info.status,
          error: value.error ? errorMessage(value.error) : undefined,
        }),
        (error) => ({ data: previous.value?.data, status: info.status, error: errorMessage(error) }),
      )
    },
  )

  const status = createMemo(() => result()?.status ?? (result()?.error ? undefined : props.pty.status))
  const refresh = () => {
    if (!result.loading) void refetch()
  }
  createEffect(() => {
    if (result.loading || result()?.error || status() !== "running") return
    const timer = setTimeout(refresh, 1000)
    onCleanup(() => clearTimeout(timer))
  })
  useBindings(() => ({
    priority: 2,
    bindings: [
      { key: "r", desc: "刷新终端输出", group: "Dialog", cmd: refresh },
      { key: "escape", desc: "返回后台", group: "Dialog", cmd: props.onBack },
    ],
  }))

  const view = createMemo(() => {
    const value = result()
    if (!value?.data) return
    const raw = value.data.output
    const over = raw.length > PTY_DISPLAY_LIMIT
    // 先按原始长度截尾再 strip：服务端已封顶 32K，但长行/多行仍会再压一遍 ANSI。
    const text = stripAnsi(over ? raw.slice(-PTY_DISPLAY_LIMIT) : raw)
    return {
      text,
      notice: ptyOutputNotice({
        truncated: over || value.data.truncated,
        shownChars: text.length,
        startCursor: value.data.startCursor,
        endCursor: value.data.endCursor,
      }),
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          {`终端 · ${props.pty.title}`}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onBack()}>
          ← 返回后台
        </text>
      </box>
      <box>
        <text fg={theme.textMuted} wrapMode="word">
          {`命令：${ptyCommandLine(props.pty)}`}
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          {`目录：${props.pty.cwd} · PID ${props.pty.pid} · ${status() ? PTY_STATUS[status()!] : "状态未知"}`}
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          {status() ? ptyStatusNote(status()!) : "无法确认终端状态，自动刷新已暂停。"}
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          {ptySourceNote()}
        </text>
      </box>
      <Show when={result()?.error}>
        {(error) => (
          <text fg={theme.error} wrapMode="word">
            {`输出刷新失败：${error()}（保留上次快照；按 r 重试）`}
          </text>
        )}
      </Show>
      <Show when={view()}>
        {(output) => (
          <box gap={1}>
            <text fg={theme.textMuted}>{output().notice}</text>
            <scrollbox
              focused
              stickyScroll
              stickyStart="bottom"
              height={Math.max(6, Math.floor(dimensions().height / 2))}
              scrollbarOptions={{ visible: false }}
            >
              <text fg={theme.text} wrapMode="word">
                {output().text || "没有已捕获的输出。"}
              </text>
            </scrollbox>
          </box>
        )}
      </Show>
      <Show when={result.loading}>
        <text fg={theme.textMuted}>加载输出…</text>
      </Show>
      <text fg={theme.textMuted}>r 刷新 · ↑/↓ 滚动 · esc 返回后台 · 仅在尾部跟随新输出</text>
    </box>
  )
}
