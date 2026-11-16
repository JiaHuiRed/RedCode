import { createMemo, createResource, onMount, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import stripAnsi from "strip-ansi"
import type { PtyOutput } from "@redcode-ai/sdk/v2"
import { errorMessage } from "@/util/error"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
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

  const [result] = createResource(
    () => props.pty.id,
    () =>
      sdk.client.pty
        .output({ ptyID: props.pty.id, directory: sync.path.directory || sdk.directory })
        .then(
          (value): { data?: PtyOutput; error?: string } => ({
            data: value.data,
            error: value.error ? errorMessage(value.error) : undefined,
          }),
          (error): { data?: PtyOutput; error?: string } => ({ data: undefined, error: errorMessage(error) }),
        ),
  )

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
          {`目录：${props.pty.cwd} · PID ${props.pty.pid} · ${PTY_STATUS[props.pty.status]}`}
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          {ptyStatusNote(props.pty.status)}
        </text>
        <text fg={theme.textMuted} wrapMode="word">
          {ptySourceNote()}
        </text>
      </box>
      <Show when={result()?.error}>
        {(error) => (
          <text fg={theme.error} wrapMode="word">
            {`输出不可用：${error()}`}
          </text>
        )}
      </Show>
      <Show when={view()}>
        {(output) => (
          <box gap={1}>
            <text fg={theme.textMuted}>{output().notice}</text>
            <scrollbox
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
    </box>
  )
}
