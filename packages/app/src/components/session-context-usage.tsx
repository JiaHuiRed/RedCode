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

  const metrics = createMemo(() => getSessionContextMetrics(messages(), [...providers.all().values()]))
  const context = createMemo(() => metrics().context)
  // 260923 Red C4：Context 不可关闭（文档第 14 节），所以再点一次是「收起面板」而不是
  // 「关标签」——与占位条上同 tab 再点即折叠的语义一致。
  const openContext = () => {
    if (!params.id) return

    if (tabState.activeTab() === "context") {
      view().reviewPanel.close()
      return
    }
    openSessionContext({
      view: view(),
      layout,
      tabs: tabs(),
    })
  }

  // 260819 cc 进度圈上色是纯装饰——哥哥明确说不会严格照它决定压缩时机，所以不为它引入
  // 任何新机制：progress-circle.css 本来就是 var(--progress-circle-progress, …) 的可覆盖写法，
  // 调用方传 style 即可，共享组件一行不用改。
  //
  // 260822 cc 改成**跟着上下文窗口占用**走，与 tooltip 第一行的百分比同一个口径。
  // 之前只按引擎档位（level）上色，而 level 的分母是 ceiling（usable 扣掉输出预留、再被
  // compaction.threshold 封顶，见 overflow.ts:48-56），与这里显示的 window / limit.context
  // 不是同一个分母 —— step-3.7-flash 上 usable≈224k、窗口 256k，soft 落在显示的 52%，
  // 于是"圈黄了但数字才 52%"，颜色与数字对不上。
  //
  // 261011 Red 再改：分档从「窗口占用 60/80% + 引擎档位取重」换成**绝对 token 值**并升四级
  //（见下方 TIER_*）——200 多 k 就漂橙天天扎眼，哥哥拍板 220/280/320k 三条界线。
  // 既有教训保留：v2 语义色没有橙色 state token，--v2-orange-* 是原始色阶不分亮暗，
  // 所以橙用 warning→danger 的 color-mix，跟随两个 state 色自动适配主题。
  // 261011 Red 档位改绝对 token 值（与 TUI 侧栏 barColor 同口径）：<220k 常态、220-280k 黄、
  // 280-320k 橙、≥320k 红。不再按 usage% 与引擎 level 的比例线取重——360k 兜底下 soft=259k，
  // 200 多 k 就漂色与 TUI 一样扎眼。橙没有独立 state token，用 warning→danger 的 color-mix
  //（本文件下方条底槽同款混色写法，不引新 token）。
  const TIER_ORANGE = "color-mix(in srgb, var(--v2-state-fg-warning) 50%, var(--v2-state-fg-danger))"
  const TIER_STROKE = [undefined, "var(--v2-state-fg-warning)", TIER_ORANGE, "var(--v2-state-fg-danger)"] as const
  // 260829 cc 条用的分档色。与圈共用 strokeTier()，但**常态档不同**：圈在常态刻意不上色
  // （「没事发生时圈就该是平时的样子」，见上），而条的职责是把占比画出来，没有填充色就
  // 什么都看不到，所以常态给 info 蓝。警戒各档与圈完全一致。
  const TIER_BAR = [
    "var(--v2-state-fg-info)",
    "var(--v2-state-fg-warning)",
    TIER_ORANGE,
    "var(--v2-state-fg-danger)",
  ] as const
  const strokeTier = () => {
    const window = context()?.window
    if ((window ?? 0) >= 320_000) return 3
    if ((window ?? 0) >= 280_000) return 2
    if ((window ?? 0) >= 220_000) return 1
    return 0
  }

  const circle = () => (
    <div class="flex items-center justify-center">
      <ProgressCircle
        size={16}
        strokeWidth={2}
        percentage={context()?.usage ?? 0}
        style={(() => {
          const stroke = TIER_STROKE[strokeTier()]
          // 最低档不覆盖，保持组件默认的 --border-active —— 没事发生时圈就该是平时的样子
          return stroke ? { "--progress-circle-progress": stroke } : undefined
        })()}
      />
    </div>
  )

  // 260822 cc 首字延迟的显示：秒以下给毫秒（分辨 200ms 与 900ms 有意义），
  // 秒以上给一位小数（分辨 1.4s 与 1.5s 没意义，但 1.4s 与 4.2s 有意义）。
  const formatMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`)

  // 260822 cc 这个悬浮与右侧「上下文」面板的分工：**面板是会话账本，这里是当下这一轮**。
  // 原先这里还有「Token（会话累计）」与「成本」两行，两个数在面板里一模一样地各有一格
  // （总 token / 总成本），纯粹是重复。换成面板没有、也不该有的两个实时指标：
  //
  //   首字 = created→firstChunk，排队与预填。它慢说明供应商侧在排队、或上下文太长。
  //   解码 = firstChunk→completed 期间的 tok/s。它慢说明吐字本身慢。
  //
  // 两段分开是刻意的（与 TUI 侧边栏同样的取舍）：混成一个「总速度」会让这两种成因完全
  // 不同的问题看起来一样。口径见 session-context-metrics.ts 里那段注释。
  //
  // 第一行的上下文窗口保留 —— 它是这个圆圈本身的含义，没有它悬浮就解释不了自己。
  const tooltipValue = () => (
    // min-w：条的长度不该跟着那三行文字的宽度忽长忽短
    <div class="min-w-[196px]">
      <Show when={context()}>
        {(ctx) => (
          <>
            {/* window 为空 = 历史消息还没有 tokens.context，这一行整块不显示，等下一轮写入。 */}
            <Show when={ctx().window !== undefined}>
              <div class="flex items-center gap-2">
                <span class="text-text-invert-strong">
                  {ctx().window!.toLocaleString(language.intl())}
                  <Show when={ctx().limit}>{(l) => <> / {l().toLocaleString(language.intl())}</>}</Show>
                  <Show when={ctx().usage !== null}> · {ctx().usage}%</Show>
                </span>
                <span class="text-text-invert-base">{language.t("context.usage.window")}</span>
              </div>
              {/* 260829 cc 占比色条。此前这个悬浮只有三行数字，占用率要靠读百分比才知道，
                  而"还剩多少"是它最该一眼给出的东西。底槽从 tooltip 自己的文字色 color-mix
                  出来，不引入新 token —— 这层是 --surface-float-base 的浮层，深浅主题下
                  它的文字色本就已经翻好了，跟着它走就不会在某个主题上糊掉。
                  宽度按 usage 钳在 100%：窗口口径可能短暂超过 limit（比如上一轮刚压缩、
                  limit 换了模型），条不该溢出容器。 */}
              <Show when={ctx().usage !== null}>
                <div
                  class="mt-1.5 mb-0.5 h-1 w-full overflow-hidden rounded-full"
                  style={{ "background-color": "color-mix(in srgb, var(--text-invert-base) 22%, transparent)" }}
                >
                  <div
                    class="h-full rounded-full"
                    style={{
                      width: `${Math.min(100, Math.max(0, ctx().usage!))}%`,
                      "background-color": TIER_BAR[strokeTier()],
                    }}
                  />
                </div>
              </Show>
            </Show>
            <Show when={ctx().firstChunkMs !== null}>
              <div class="flex items-center gap-2">
                <span class="text-text-invert-strong">{formatMs(ctx().firstChunkMs!)}</span>
                <span class="text-text-invert-base">{language.t("context.usage.firstToken")}</span>
              </div>
            </Show>
            <Show when={ctx().decodeRate !== null}>
              <div class="flex items-center gap-2">
                <span class="text-text-invert-strong">{ctx().decodeRate} tok/s</span>
                <span class="text-text-invert-base">{language.t("context.usage.decodeRate")}</span>
              </div>
            </Show>
          </>
        )}
      </Show>
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
