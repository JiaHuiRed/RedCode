// 261011 Red 输入框行的主动压缩键（会话页，推理档右侧）。引擎的自动兜底线已抬到
// 360k（compaction.native.trigger_tokens），日常压缩由这个键手动发起；误触保护——
// 点一次只出确认窗（带当前数字），确认才调 summarize（与 /compact 命令同一条 API）。
import { Show, createMemo } from "solid-js"
import { Tooltip } from "@redcode-ai/ui/tooltip"
import { Button } from "@redcode-ai/ui/button"
import { Dialog } from "@redcode-ai/ui/dialog"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { getSessionContextMetrics } from "@/components/session/session-context-metrics"
import { createSessionContextFormatter } from "@/components/session/session-context-format"
import { useSessionLayout } from "@/pages/session/session-layout"

// 261011 Red 档位色与 session-context-usage.tsx 的 TIER_* 同源（绝对 token 值）：
// <220k 绿、220-280k 黄、280-320k 橙（warning→danger 混色）、≥320k 红。
const TIER_COLOR = [
  "var(--v2-state-fg-success)",
  "var(--v2-state-fg-warning)",
  "color-mix(in srgb, var(--v2-state-fg-warning) 50%, var(--v2-state-fg-danger))",
  "var(--v2-state-fg-danger)",
] as const

const tier = (context: number | null | undefined) => {
  if ((context ?? 0) >= 320_000) return 3
  if ((context ?? 0) >= 280_000) return 2
  if ((context ?? 0) >= 220_000) return 1
  return 0
}

function CompactConfirm(props: { sessionID: string; modelID: string; providerID: string; description: string }) {
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  return (
    <Dialog title={language.t("command.session.compact")} description={props.description} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            size="large"
            onClick={() => {
              dialog.close()
              void sdk.client.session.summarize({
                sessionID: props.sessionID,
                modelID: props.modelID,
                providerID: props.providerID,
              })
            }}
          >
            {language.t("prompt.compact.run")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export function SessionCompactButton() {
  const dialog = useDialog()
  const sync = useSync()
  const language = useLanguage()
  const providers = useProviders()
  const { params } = useSessionLayout()

  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []))
  const ctx = createMemo(() => getSessionContextMetrics(messages(), [...providers.all().values()]).context)
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))

  // window 为空 = 历史消息还没有 tokens.context（本会话本轮请求前），整块不渲染，
  // 等下一轮写入——与 SessionContextUsage 的守卫同判据。
  const label = () => {
    const current = ctx()
    if (current?.window === undefined) return undefined
    return formatter().compact(current.window)
  }
  const windowText = () => {
    const current = ctx()
    if (current?.window === undefined) return ""
    return formatter().number(current.window)
  }
  const limitText = () => {
    const current = ctx()
    if (!current?.limit) return "—"
    return formatter().number(current.limit)
  }

  return (
    <Show when={params.id && label()}>
      <Tooltip
        value={language.t("prompt.compact.tooltip", { window: windowText(), limit: limitText() })}
        placement="top"
      >
        <Button
          type="button"
          variant="ghost"
          class="h-6 shrink-0 rounded-md px-1.5 text-12-regular"
          style={{
            color: TIER_COLOR[tier(ctx()?.window)],
            "font-variant-numeric": "tabular-nums",
          }}
          onClick={() => {
            const current = ctx()
            const id = params.id
            if (!id || !current) return
            dialog.show(() => (
              <CompactConfirm
                sessionID={id}
                modelID={current.message.modelID}
                providerID={current.message.providerID}
                description={language.t("prompt.compact.confirm", { window: windowText(), limit: limitText() })}
              />
            ))
          }}
        >
          {label()}
        </Button>
      </Tooltip>
    </Show>
  )
}
