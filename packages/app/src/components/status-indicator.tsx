import { Button } from "@redcode-ai/ui/button"
import { Icon } from "@redcode-ai/ui/icon"
import { createMemo } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"

export function StatusIndicator(props: { onClick?: () => void }) {
  const language = useLanguage()
  const server = useServer()
  const sync = useSync()
  const globalSDK = useGlobalSDK()
  const ready = createMemo(() => server.healthy() === false || sync.data.mcp_ready)
  const mcpIssue = createMemo(() => {
    const mcp = Object.values(sync.data.mcp ?? {})
    const failed = mcp.some((item) => item.status === "failed" || item.status === "needs_client_registration")
    const warn = mcp.some((item) => item.status === "needs_auth")
    if (failed) return "critical" as const
    if (warn) return "warning" as const
  })
  const healthy = createMemo(() => server.healthy() === true && !mcpIssue())

  // 260901 cc SSE 与 HTTP 健康检查是两条独立链路，标题栏继续显示重连状态。
  const streamDown = createMemo(() => globalSDK.event.connection() === "reconnecting")
  const triggerLabel = () =>
    streamDown() ? language.t("status.connection.reconnecting") : language.t("status.popover.trigger")

  return (
    <Button
      type="button"
      variant="ghost"
      class="titlebar-icon w-8 h-6 p-0 box-border"
      aria-label={triggerLabel()}
      title={triggerLabel()}
      disabled={!props.onClick}
      onClick={props.onClick}
      style={{ scale: 1 }}
    >
      <span class="relative size-4">
        <span class="badge-mask-tight size-4 flex items-center justify-center">
          <Icon name="status" size="small" />
        </span>
        <span
          classList={{
            "absolute -top-px -right-px size-1.5 rounded-full": true,
            "bg-icon-success-base": ready() && healthy() && !streamDown(),
            "bg-icon-warning-base":
              (ready() && server.healthy() === true && mcpIssue() === "warning") ||
              (ready() && server.healthy() === true && streamDown()),
            "bg-icon-critical-base":
              server.healthy() === false || (ready() && server.healthy() === true && mcpIssue() === "critical"),
            "bg-border-weak-base": server.healthy() === undefined || !ready(),
          }}
        />
      </span>
    </Button>
  )
}
