import { createMemo } from "solid-js"
import { useSync } from "@tui/context/sync"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import * as Clipboard from "@tui/util/clipboard"
import * as Log from "@redcode-ai/core/util/log"
import type { PromptInfo } from "@tui/component/prompt/history"
import { strip } from "@tui/component/prompt/part"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const sync = useSync()
  const sdk = useSDK()
  const message = createMemo(() => sync.data.message[props.sessionID]?.find((x) => x.id === props.messageID))
  const route = useRoute()

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
        {
          title: "Revert",
          value: "session.revert",
          description: "undo messages and file changes",
          onSelect: (dialog) => {
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
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog) => {
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
          onSelect: async (dialog) => {
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
      ]}
    />
  )
}
