import {
  TextareaRenderable,
  TextAttributes,
  PasteEvent,
  decodePasteBytes,
  MouseButton,
  type MouseEvent,
} from "@opentui/core"
import { createEffect, createMemo, createSignal, Match, onCleanup, onMount, Show, Switch, type JSX } from "solid-js"
import { errorMessage } from "@/util/error"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useTuiConfig } from "@tui/context/tui-config"
import { useBindings, useCommandShortcut } from "../keymap"
import * as Clipboard from "../util/clipboard"
import {
  clearSteerDraft,
  getSteerDraft,
  saveSteerText,
  steerDelivery,
  steerRequest,
  steerStateText,
  validateSteerMessage,
  type SteerDelivery,
} from "./subagent-steer"

type Phase =
  | { kind: "edit" }
  | { kind: "sending" }
  | { kind: "sent"; text: string; requestID: string; messageID: string; state: SteerDelivery }
  | { kind: "failed"; text: string; requestID: string; error: string }

// 261116 Red A03：运行中子任务的「补充要求」编辑与回执。
// - 只走专用 HTTP（background.steer），不借普通聊天入口——已结束的 Explore 不自动续跑。
// - 发送前草稿按目标会话保留；失败保留原文并用同一个 requestID 重试。
// - 「已送达」只代表投递；回执以持久化消息的 delivery 为准（排队→送达会在面板里跟进）。
export function DialogSubagentSteer(props: {
  sessionID: string
  taskTitle?: string
  parentSessionID?: string
  parentTitle?: string
  /** 从后台面板进入时用来回到原面板；缺省关闭对话框。 */
  onDone?: () => void
}) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()
  const { theme } = useTheme()
  const [phase, setPhase] = createSignal<Phase>({ kind: "edit" })
  const [draftText, setDraftText] = createSignal(getSteerDraft(props.sessionID).text)

  const taskTitle = createMemo(() => props.taskTitle ?? sync.session.get(props.sessionID)?.title ?? props.sessionID)
  const parentID = createMemo(() => props.parentSessionID ?? sync.session.get(props.sessionID)?.parentID)
  const parentLabel = createMemo(() => {
    const id = parentID()
    if (!id) return "未知（会话没有记录父任务）"
    return `${props.parentTitle ?? sync.session.get(id)?.title ?? id}（${id}）`
  })

  let timer: ReturnType<typeof setInterval> | undefined
  function stopPolling() {
    if (!timer) return
    clearInterval(timer)
    timer = undefined
  }
  let closed = false
  onCleanup(() => {
    closed = true
    stopPolling()
  })

  function close() {
    closed = true
    stopPolling()
    if (props.onDone) {
      props.onDone()
      return
    }
    dialog.clear()
  }

  async function readBack(messageID: string, fallback: SteerDelivery): Promise<SteerDelivery> {
    const page = await sdk.client.session.messages({ sessionID: props.sessionID, limit: 100 }).catch(() => undefined)
    const info = page?.data?.find((item) => item.info.id === messageID)?.info
    if (!info || info.role !== "user") return fallback
    return steerDelivery(info.delivery)
  }

  // 排队只在下一个安全执行点转送达；面板开着时有界跟进，不把排队谎报成已执行。
  function pollDelivery(messageID: string) {
    if (closed) return
    stopPolling()
    let attempts = 0
    timer = setInterval(() => {
      attempts += 1
      if (attempts > 15) {
        stopPolling()
        return
      }
      void readBack(messageID, "queued").then((next) => {
        if (closed || next !== "delivered") return
        const current = phase()
        if (current.kind === "sent") setPhase({ ...current, state: "delivered" })
        stopPolling()
      })
    }, 1000)
  }

  async function send(text: string) {
    const draft = steerRequest(props.sessionID, text)
    setDraftText(draft.text)
    const invalid = validateSteerMessage(draft.text, draft.requestID)
    if (invalid) {
      setPhase({ kind: "failed", text: draft.text, requestID: draft.requestID, error: invalid })
      return
    }
    setPhase({ kind: "sending" })
    const running = await sdk.client.background.list().then(
      (result) =>
        result.error || !result.data
          ? undefined
          : result.data.some((job) => job.sessionID === props.sessionID && job.status === "running"),
      () => undefined,
    )
    if (closed) return
    if (running === false) {
      setPhase({
        kind: "failed",
        text: draft.text,
        requestID: draft.requestID,
        error: "该子任务当前没有运行中的后台任务（可能已结束），未发送；不会自动续跑。",
      })
      return
    }
    const response = await sdk.client.background
      .steer({
        sessionID: props.sessionID,
        message: draft.text,
        requestID: draft.requestID,
        directory: sync.path.directory || sdk.directory,
      })
      .then(
        (value): { messageID?: string; state?: SteerDelivery; error?: string } => ({
          messageID: value.data?.messageID,
          state: value.data?.state,
          error: value.error ? errorMessage(value.error) : undefined,
        }),
        (error): { messageID?: string; state?: SteerDelivery; error?: string } => ({
          messageID: undefined,
          state: undefined,
          error: errorMessage(error),
        }),
      )
    if (response.error || !response.messageID || !response.state) {
      if (closed) return
      setPhase({
        kind: "failed",
        text: draft.text,
        requestID: draft.requestID,
        error: response.error ?? "服务端未返回投递回执",
      })
      return
    }
    const currentDraft = getSteerDraft(props.sessionID)
    if (currentDraft.requestID === draft.requestID && currentDraft.text === draft.text) clearSteerDraft(props.sessionID)
    if (closed) return
    const state = await readBack(response.messageID, response.state)
    if (closed) return
    setPhase({
      kind: "sent",
      text: draft.text,
      requestID: draft.requestID,
      messageID: response.messageID,
      state,
    })
    if (state === "queued") pollDelivery(response.messageID)
  }

  function retry() {
    const current = phase()
    if (current.kind !== "failed") return
    void send(current.text)
  }

  function edit() {
    setDraftText(getSteerDraft(props.sessionID).text)
    setPhase({ kind: "edit" })
  }

  useBindings(() => ({
    priority: 2,
    bindings: [{ key: "escape", desc: "返回后台（保留草稿）", group: "Dialog", cmd: close }],
  }))
  useBindings(() => ({
    enabled: phase().kind === "failed",
    priority: 2,
    bindings: [
      { key: "r", desc: "重试补充要求", group: "Dialog", cmd: retry },
      { key: "e", desc: "编辑补充要求", group: "Dialog", cmd: edit },
    ],
  }))

  onMount(() => {
    dialog.setSize("medium")
  })

  return (
    // Keep the dialog factory rooted in a node: a root Switch accessor is unwrapped
    // by OpenTUI and would rerun the factory (resetting phase) when its branch changes.
    <box>
      <Switch>
        <Match when={phase().kind === "edit" || phase().kind === "sending"}>
          <SteerEditor
            sessionID={props.sessionID}
            title={`补充要求 · ${taskTitle()}`}
            busy={phase().kind === "sending"}
            value={draftText()}
            description={
              <box>
                <text fg={theme.textMuted} wrapMode="word">
                  {`所属主任务：${parentLabel()}`}
                </text>
                <text fg={theme.textMuted} wrapMode="word">
                  {`目标会话：${props.sessionID}`}
                </text>
                <text fg={theme.textMuted} wrapMode="word">
                  补充要求会在下一个安全执行点送达，不打断正在运行的工具；已结束的任务不会自动续跑。
                </text>
              </box>
            }
            onSend={(text) => void send(text)}
            onCancel={close}
          />
        </Match>
        <Match when={phase().kind === "sent" || phase().kind === "failed"}>
          {(() => {
            const current = () => phase() as Extract<Phase, { kind: "sent" | "failed" }>
            const state = () =>
              phase().kind === "sent" ? (phase() as Extract<Phase, { kind: "sent" }>).state : "failed"
            const color = () =>
              phase().kind === "failed" ? theme.error : state() === "delivered" ? theme.success : theme.warning
            return (
              <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.text} attributes={TextAttributes.BOLD}>{`补充要求 · ${taskTitle()}`}</text>
                  <text fg={theme.textMuted} onMouseUp={close}>
                    esc
                  </text>
                </box>
                <text fg={theme.textMuted} wrapMode="word">{`所属主任务：${parentLabel()}`}</text>
                <text fg={theme.textMuted} wrapMode="word">{`目标会话：${props.sessionID}`}</text>
                <text fg={color()} wrapMode="word">
                  {steerStateText(phase().kind === "failed" ? "failed" : state())}
                </text>
                <Show when={phase().kind === "failed"}>
                  <text fg={theme.error} wrapMode="word">
                    {(phase() as Extract<Phase, { kind: "failed" }>).error}
                  </text>
                </Show>
                <Show when={phase().kind === "sent"}>
                  <text fg={theme.textMuted} wrapMode="word">
                    {`message ${(current() as Extract<Phase, { kind: "sent" }>).messageID.slice(-8)} · request ${current().requestID.slice(0, 8)}`}
                  </text>
                </Show>
                <text fg={theme.textMuted} wrapMode="word">
                  {current().text}
                </text>
                <box flexDirection="row" justifyContent="flex-end" gap={2}>
                  <Show when={phase().kind === "failed"}>
                    <box paddingLeft={2} paddingRight={2} onMouseUp={edit}>
                      <text fg={theme.textMuted}>e 编辑</text>
                    </box>
                    <box paddingLeft={2} paddingRight={2} backgroundColor={theme.primary} onMouseUp={retry}>
                      <text fg={theme.selectedListItemText}>r 重试</text>
                    </box>
                  </Show>
                  <box paddingLeft={2} paddingRight={2} backgroundColor={theme.primary} onMouseUp={close}>
                    <text fg={theme.selectedListItemText}>esc 返回</text>
                  </box>
                </box>
              </box>
            )
          })()}
        </Match>
      </Switch>
    </box>
  )
}

function SteerEditor(props: {
  sessionID: string
  title: string
  busy: boolean
  value: string
  description: JSX.Element
  onSend: (text: string) => void
  onCancel: () => void
}) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const submitShortcut = useCommandShortcut("dialog.prompt.submit")
  const [textareaTarget, setTextareaTarget] = createSignal<TextareaRenderable>()
  let textarea: TextareaRenderable

  function confirm() {
    if (props.busy) return
    if (!textarea || textarea.isDestroyed) return
    props.onSend(textarea.plainText)
  }

  useBindings(() => ({
    target: textareaTarget,
    enabled: textareaTarget() !== undefined && !props.busy,
    priority: 1,
    commands: [
      {
        name: "dialog.prompt.submit",
        title: "提交补充要求",
        category: "Dialog",
        run: confirm,
      },
    ],
    bindings: tuiConfig.keybinds.gather("dialog.prompt", ["dialog.prompt.submit"]),
  }))

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      if (props.busy) return
      textarea.focus()
    }, 1)
    textarea.gotoLineEnd()
  })

  createEffect(() => {
    if (!textarea || textarea.isDestroyed) return
    textarea.traits = props.busy ? { suspend: true, status: "BUSY" } : {}
    if (props.busy) {
      textarea.blur()
      return
    }
    textarea.focus()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={props.onCancel}>
          esc
        </text>
      </box>
      <box gap={1}>
        {props.description}
        <textarea
          height={4}
          ref={(value: TextareaRenderable) => {
            textarea = value
            setTextareaTarget(value)
          }}
          initialValue={props.value}
          placeholder="例如：先别查归档，重点看 data_sync.py"
          placeholderColor={theme.textMuted}
          textColor={props.busy ? theme.textMuted : theme.text}
          focusedTextColor={props.busy ? theme.textMuted : theme.text}
          cursorColor={props.busy ? theme.backgroundElement : theme.text}
          onContentChange={() => {
            if (!textarea || textarea.isDestroyed) return
            saveSteerText(props.sessionID, textarea.plainText)
          }}
          onPaste={(event: PasteEvent) => {
            event.preventDefault()
            const text = decodePasteBytes(event.bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n")
            if (text && textarea && !textarea.isDestroyed) textarea.insertText(text)
          }}
          onMouseDown={(event: MouseEvent) => {
            if (event.button !== MouseButton.RIGHT) return
            event.preventDefault()
            event.stopPropagation()
            Clipboard.read().then((content) => {
              if (content?.mime !== "text/plain") return
              if (!textarea || textarea.isDestroyed) return
              textarea.insertText(content.data)
            })
          }}
        />
        <Show when={props.busy}>
          <text fg={theme.textMuted}>发送中…</text>
        </Show>
      </box>
      <box paddingBottom={1} gap={1} flexDirection="row">
        <Show when={!props.busy} fallback={<text fg={theme.textMuted}>processing...</text>}>
          <Show when={submitShortcut()}>
            <text fg={theme.text}>
              {submitShortcut()} <span style={{ fg: theme.textMuted }}>submit</span>
            </text>
          </Show>
          <text fg={theme.textMuted}>esc 返回（保留草稿）</text>
        </Show>
      </box>
    </box>
  )
}
