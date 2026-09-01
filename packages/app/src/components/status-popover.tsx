import { Button } from "@redcode-ai/ui/button"
import { Icon } from "@redcode-ai/ui/icon"
import { Popover } from "@redcode-ai/ui/popover"
import { Suspense, createMemo, createSignal, lazy, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"

const Body = lazy(() => import("./status-popover-body").then((x) => ({ default: x.StatusPopoverBody })))

// 260610 Red openInPanel：传入则点圆点不开弹层，改为打开右侧面板的 status 标签页（标题栏方案 A）
export function StatusPopover(props: { openInPanel?: () => void }) {
  const language = useLanguage()
  const server = useServer()
  const sync = useSync()
  const globalSDK = useGlobalSDK()
  const [shown, setShown] = createSignal(false)
  const ready = createMemo(() => server.healthy() === false || sync.data.mcp_ready)
  const mcpIssue = createMemo(() => {
    const mcp = Object.values(sync.data.mcp ?? {})
    const failed = mcp.some((item) => item.status === "failed" || item.status === "needs_client_registration")
    const warn = mcp.some((item) => item.status === "needs_auth")
    if (failed) return "critical" as const
    if (warn) return "warning" as const
  })
  const healthy = createMemo(() => server.healthy() === true && !mcpIssue())

  // 260901 cc 事件流断线要在标题栏可见。
  //
  // 为什么不能只靠 server.healthy()：那是独立的 HTTP 轮询，跟承载会话更新的 SSE 流是两条路。
  // 哥哥 08-31 在家遇到的那次，流还活着（看得见模型继续跑）但请求全挂——反过来也成立：
  // 流断了而健康检查还通，界面照样是绿的、却收不到任何更新。轮询那侧还有个 busy 重入锁
  // 无超时的问题（一次挂住就再也不更新，见 context/server.tsx），所以它不能当唯一信号。
  //
  // 归到 warning 档而不是 critical：断开的瞬间就在重连（指数退避 256ms→2s），多数情况几秒
  // 内自愈，标红会制造恐慌。不加脉冲动画——周期性闪动是明确不要的。
  const streamDown = createMemo(() => globalSDK.event.connection() === "reconnecting")

  // 颜色之外还要有文字：无障碍读屏与 hover 提示都靠它，光靠一个色点不算「可见」。
  const triggerLabel = () =>
    streamDown() ? language.t("status.connection.reconnecting") : language.t("status.popover.trigger")

  const dot = (open: boolean) => (
    <div class="relative size-4">
      <div class="badge-mask-tight size-4 flex items-center justify-center">
        <Icon name={open ? "status-active" : "status"} size="small" />
      </div>
      <div
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
    </div>
  )

  // Show 而非 early-return：openInPanel 切换（首页↔会话）能响应式重渲染
  return (
    <Show
      when={props.openInPanel}
      fallback={
        <Popover
          open={shown()}
          onOpenChange={setShown}
          triggerAs={Button}
          triggerProps={{
            variant: "ghost",
            class: "titlebar-icon w-8 h-6 p-0 box-border",
            "aria-label": triggerLabel(),
            style: { scale: 1 },
          }}
          trigger={dot(shown())}
          class="[&_[data-slot=popover-body]]:p-0 w-[360px] max-w-[calc(100vw-40px)] bg-transparent border-0 shadow-none rounded-xl"
          gutter={4}
          placement="bottom-end"
          shift={-168}
        >
          <Show when={shown()}>
            <Suspense
              fallback={
                <div class="w-[360px] h-14 rounded-xl bg-background-strong shadow-[var(--shadow-lg-border-base)]" />
              }
            >
              <Body shown={shown} />
            </Suspense>
          </Show>
        </Popover>
      }
    >
      {(open) => (
        <Button
          variant="ghost"
          class="titlebar-icon w-8 h-6 p-0 box-border"
          aria-label={triggerLabel()}
          style={{ scale: 1 }}
          onClick={() => open()()}
        >
          {dot(false)}
        </Button>
      )}
    </Show>
  )
}
