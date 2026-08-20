import { Match, Show, Switch, createMemo } from "solid-js"
import { Tooltip, type TooltipProps } from "@redcode-ai/ui/tooltip"
import { ProgressCircle } from "@redcode-ai/ui/progress-circle"
import { Button } from "@redcode-ai/ui/button"

import { useFile } from "@/context/file"
import { useLayout } from "@/context/layout"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { getSessionContextMetrics } from "@/components/session/session-context-metrics"
import { createSessionContextFormatter } from "@/components/session/session-context-format"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createSessionTabs } from "@/pages/session/helpers"

interface SessionContextUsageProps {
  variant?: "button" | "indicator"
  placement?: TooltipProps["placement"]
}

function openSessionContext(args: {
  view: ReturnType<ReturnType<typeof useLayout>["view"]>
  layout: ReturnType<typeof useLayout>
  tabs: ReturnType<ReturnType<typeof useLayout>["tabs"]>
}) {
  if (!args.view.reviewPanel.opened()) args.view.reviewPanel.open()
  if (args.layout.fileTree.opened() && args.layout.fileTree.tab() !== "all") args.layout.fileTree.setTab("all")
  void args.tabs.open("context")
  args.tabs.setActive("context")
}

export function SessionContextUsage(props: SessionContextUsageProps) {
  const sync = useSync()
  const file = useFile()
  const layout = useLayout()
  const language = useLanguage()
  const providers = useProviders()
  const { params, tabs, view } = useSessionLayout()

  const variant = createMemo(() => props.variant ?? "button")
  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? file.tab(tab) : tab),
  })
  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []))

  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))

  const metrics = createMemo(() => getSessionContextMetrics(messages(), [...providers.all().values()]))
  const context = createMemo(() => metrics().context)
  // 260706 Red: 子代理 cost 汇总（与 session-context-tab 保持一致）
  const childCost = createMemo(() => {
    const id = params.id
    if (!id) return 0
    let total = 0
    for (const s of sync.data.session) {
      if (s.parentID !== id) continue
      const msgs = sync.data.message[s.id]
      if (!msgs) continue
      for (const m of msgs) {
        if (m.role === "assistant") total += m.cost
      }
    }
    return total
  })
  const cost = createMemo(() => {
    const m = metrics()
    return formatter().cost(m.totalCost + childCost(), m.costCurrency)
  })

  const openContext = () => {
    if (!params.id) return

    if (tabState.activeTab() === "context") {
      tabs().close("context")
      return
    }
    openSessionContext({
      view: view(),
      layout,
      tabs: tabs(),
    })
  }

  // 260819 cc 进度圈按引擎判定的档位着色。纯装饰——哥哥明确说不会严格照它决定压缩时机，
  // 所以不为它引入任何新机制：progress-circle.css 本来就是 var(--progress-circle-progress, …)
  // 的可覆盖写法，调用方传 style 即可，共享组件一行不用改。
  //
  // TUI 侧是四档（ok/soft/prune/compact），GUI 收成三档：v2 的语义色只有
  // success/warning/danger/info，没有橙色的 state token（有 --v2-orange-* 调色板，但那是
  // 原始色阶、不分亮暗，直接用会在暗色主题下发错）。为一个装饰功能新增一对设计 token
  // 不划算，所以 soft 与 prune 合并成 warning：黄=廉价手段已在生效，红=正在全量压缩。
  const LEVEL_STROKE: Record<string, string> = {
    soft: "var(--v2-state-fg-warning)",
    prune: "var(--v2-state-fg-warning)",
    compact: "var(--v2-state-fg-danger)",
  }
  const circle = () => (
    <div class="flex items-center justify-center">
      <ProgressCircle
        size={16}
        strokeWidth={2}
        percentage={context()?.usage ?? 0}
        style={(() => {
          const stroke = LEVEL_STROKE[context()?.level ?? ""]
          // ok 档不覆盖，保持组件默认的 --border-active —— 没事发生时圈就该是平时的样子
          return stroke ? { "--progress-circle-progress": stroke } : undefined
        })()}
      />
    </div>
  )

  const tooltipValue = () => (
    <div>
      <Show when={context()}>
        {(ctx) => (
          <>
            {/* 260819 cc 上下文窗口与会话累计分两行——原来只有一行「Token + 使用率」，
                而那两个数都来自会话累计，长会话下使用率能到 1500%，正是让人把累计当成窗口的根源。
                window 为空 = 历史消息还没有 tokens.context，这一行整块不显示，等下一轮写入。 */}
            <Show when={ctx().window !== undefined}>
              <div class="flex items-center gap-2">
                <span class="text-text-invert-strong">
                  {ctx().window!.toLocaleString(language.intl())}
                  <Show when={ctx().limit}>{(l) => <> / {l().toLocaleString(language.intl())}</>}</Show>
                  <Show when={ctx().usage !== null}> · {ctx().usage}%</Show>
                </span>
                <span class="text-text-invert-base">{language.t("context.usage.window")}</span>
              </div>
            </Show>
            <div class="flex items-center gap-2">
              <span class="text-text-invert-strong">{ctx().total.toLocaleString(language.intl())}</span>
              <span class="text-text-invert-base">{language.t("context.usage.tokens")}</span>
            </div>
          </>
        )}
      </Show>
      <div class="flex items-center gap-2">
        <span class="text-text-invert-strong">{cost()}</span>
        <span class="text-text-invert-base">{language.t("context.usage.cost")}</span>
      </div>
    </div>
  )

  return (
    <Show when={params.id}>
      <Tooltip value={tooltipValue()} placement={props.placement ?? "top"}>
        <Switch>
          <Match when={variant() === "indicator"}>{circle()}</Match>
          <Match when={true}>
            <Button
              type="button"
              variant="ghost"
              class="size-6"
              onClick={openContext}
              aria-label={language.t("context.usage.view")}
            >
              {circle()}
            </Button>
          </Match>
        </Switch>
      </Tooltip>
    </Show>
  )
}
