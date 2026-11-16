import { createMemo } from "solid-js"
import { isTaskSteerRecord } from "@redcode-ai/core/util/message-turn"
import { useSync } from "@tui/context/sync"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { useToast } from "@tui/ui/toast"
import * as Clipboard from "@tui/util/clipboard"
import * as Log from "@redcode-ai/core/util/log"
import type { PromptInfo } from "@tui/component/prompt/history"
import type { Part, ToolPart } from "@redcode-ai/sdk/v2"
import { strip } from "@tui/component/prompt/part"
import { quoteMessageText, quoteSnippet, quoteTitle } from "@tui/util/quote"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
  /** 261116 Red A04：追加到当前草稿（不发送）。缺省时仍提供复制等原有动作。 */
  quote?: (text: string) => void
}) {
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const message = createMemo(() => sync.data.message[props.sessionID]?.find((x) => x.id === props.messageID))
  const route = useRoute()

  // 261116 Red A04：工具输出也是可引用证据。只列有已完成输出的工具（末尾 4 条），
  // 每条引用带 part id 便于回查。
  const tools = createMemo(() =>
    (sync.data.part[props.messageID] ?? []).filter(
      (part): part is ToolPart => part.type === "tool" && part.state.status === "completed" && !!part.state.output,
    ),
  )

  function quote(text: string) {
    if (!props.quote) return
    const snippet = text.trim()
    if (!snippet) {
      toast.show({ message: "没有可引用的正文", variant: "warning" })
      return
    }
    props.quote(snippet)
    toast.show({ message: "已追加到草稿（不会自动发送）", variant: "success" })
  }

  // 261114 Red 消息树分支 Phase 3：本消息的兄弟版本组（含弃岛行）。无兄弟版本时不加条目。
  const versionMeta = createMemo(() => {
    const groups = sync.data.message_versions[props.sessionID]
    if (!groups) return undefined
    const group = groups.find((g) => g.versions.some((v) => v.messageID === props.messageID))
    if (!group || group.versions.length < 2) return undefined
    const index = group.versions.findIndex((v) => v.messageID === props.messageID)
    return { group, index }
  })

  const switchVersion = async (delta: number, dialog: { clear: () => void }) => {
    const meta = versionMeta()
    if (!meta) return
    const target = meta.group.versions[meta.index + delta]
    if (!target) return
    dialog.clear()
    const result = await sync.session.selectVersion({
      sessionID: props.sessionID,
      messageID: target.messageID,
    })
    if (result.error) {
      Log.Default.warn("tui select version failed", { sessionID: props.sessionID, messageID: target.messageID })
    }
  }

  return (
    <DialogSelect
      title="Message Actions"
      options={[
        ...(versionMeta()
          ? [
              {
                title: "Previous version",
                value: "session.version.prev",
                description: "switch to the previous sibling version",
                onSelect: (dialog: { clear: () => void }) => void switchVersion(-1, dialog),
              },
              {
                title: "Next version",
                value: "session.version.next",
                description: "switch to the next sibling version",
                onSelect: (dialog: { clear: () => void }) => void switchVersion(1, dialog),
              },
            ]
          : []),
        ...(message()?.role === "user"
          ? [
              {
                title: "Revert",
                value: "session.revert",
                description: "undo messages and file changes",
                onSelect: (dialog: { clear: () => void }) => {
                  const msg = message()
                  if (!msg) return

                  void sdk.client.session.revert({
                    sessionID: props.sessionID,
                    messageID: msg.id,
                  })

                  if (props.setPrompt) {
                    const parts = sync.data.part[msg.id]
                    const promptInfo = parts.reduce(
                      (agg, part) => {
                        if (part.type === "text") {
                          if (!part.synthetic) agg.input += part.text
                        }
                        if (part.type === "file") agg.parts.push(strip(part))
                        return agg
                      },
                      { input: "", parts: [] as PromptInfo["parts"] },
                    )
                    props.setPrompt(promptInfo)
                  }

                  dialog.clear()
                },
              },
            ]
          : []),
        // 261116 Red A04：引用入口与复制并列；带来源、有上限、只追加草稿不发送。
        ...(props.quote
          ? [
              {
                title: "引用到草稿",
                value: "message.quote",
                description: "把本条正文追加到当前草稿，不自动发送",
                onSelect: (dialog: { clear: () => void }) => {
                  const msg = message()
                  if (!msg) return
                  const text = quoteMessageText((sync.data.part[msg.id] ?? []) as Part[])
                  if (!text) {
                    toast.show({ message: "本条没有可引用的正文（可能只有附件或内部提醒）", variant: "warning" })
                    dialog.clear()
                    return
                  }
                  quote(
                    quoteSnippet(text, {
                      kind: "message",
                      sessionID: props.sessionID,
                      messageID: msg.id,
                      label: msg.role === "assistant" ? "助手消息" : "用户消息",
                    }),
                  )
                  dialog.clear()
                },
              },
              ...tools()
                .slice(-4)
                .map((part) => ({
                  title: `引用工具 ${part.tool} 输出`,
                  value: `tool.quote.${part.id}`,
                  description: quoteTitle(part.state.status === "completed" ? (part.state.output ?? "") : ""),
                  onSelect: (dialog: { clear: () => void }) => {
                    const output = part.state.status === "completed" ? part.state.output : undefined
                    if (!output) {
                      dialog.clear()
                      return
                    }
                    quote(
                      quoteSnippet(output, {
                        kind: "tool",
                        sessionID: props.sessionID,
                        messageID: props.messageID,
                        partID: part.id,
                        label: part.tool,
                      }),
                    )
                    dialog.clear()
                  },
                })),
            ]
          : []),
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog: { clear: () => void }) => {
            const msg = message()
            if (!msg) return

            const parts = sync.data.part[msg.id]
            const text = parts.reduce((agg, part) => {
              if (part.type === "text" && !part.synthetic) {
                agg += part.text
              }
              return agg
            }, "")

            await Clipboard.copy(text)
            dialog.clear()
          },
        },
        {
          title: "Fork",
          value: "session.fork",
          description: "create a new session",
          onSelect: async (dialog: { clear: () => void }) => {
            const result = await sdk.client.session.fork({
              sessionID: props.sessionID,
              messageID: props.messageID,
            })
            const msg = message()
            const prompt = msg
              ? sync.data.part[msg.id].reduce(
                  (agg, part) => {
                    if (part.type === "text") {
                      if (!part.synthetic) agg.input += part.text
                    }
                    if (part.type === "file") agg.parts.push(part)
                    return agg
                  },
                  { input: "", parts: [] as PromptInfo["parts"] },
                )
              : undefined
            route.navigate({
              sessionID: result.data!.id,
              type: "session",
              prompt,
            })
            dialog.clear()
          },
        },
      ].filter((option) => !isTaskSteerRecord(sync.data.part[props.messageID]) || !option.value.startsWith("session."))}
    />
  )
}
