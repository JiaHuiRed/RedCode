// 261011 Red 合并「上下文圈」与「精简键」（哥哥拍板）：一个元件——圈+数字显示占用与
// 档位色，hover 出窗口/首字/解码数据，点击弹确认窗执行精简（误触保护）。开「上下文」
// 面板走右侧常驻 tab（session-side-panel 的 systemTabStrip），不再占用本键的点击；
// 原 SessionCompactButton 组件并入本文件。
import { Show, createMemo } from "solid-js"
import { Tooltip, type TooltipProps } from "@redcode-ai/ui/tooltip"
import { ProgressCircle } from "@redcode-ai/ui/progress-circle"
import { Button } from "@redcode-ai/ui/button"
import { Dialog } from "@redcode-ai/ui/dialog"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { showToast } from "@redcode-ai/ui/toast"

import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useProviders } from "@/hooks/use-providers"
import { contextUsageTier, getSessionContextMetrics } from "@/components/session/session-context-metrics"
import { createSessionContextFormatter } from "@/components/session/session-context-format"
import { useSessionLayout } from "@/pages/session/session-layout"

export type CompactSubmitInput = { sessionID: string; modelID: string; providerID: string }

// 261011 Red C1（审计 RC-GUI-01）：确认后不再裸 `void summarize`——失败走 onError（组件接
// toast），在途按 sessionID 去重（同会话 settle 前第二发被挡），A 的在途不挡 B，settle 后恢复。
// busy 语义（压缩进行中）由服务端 ensureRunning 并发保护兜底，拒绝同样走 onError，客户端不
// 另起压缩状态机。审计门禁：重复点击只形成一次预期请求、失败显式可见、切会话不串扰。
export function createCompactSubmit(opts: {
  summarize: (input: CompactSubmitInput) => Promise<unknown>
  onError: (error: unknown) => void
}) {
  const pending = new Map<string, Promise<unknown>>()
  return (input: CompactSubmitInput): boolean => {
    if (pending.has(input.sessionID)) return false
    const request = opts
      .summarize(input)
      .then(
        () => undefined,
        (error: unknown) => opts.onError(error),
      )
      .finally(() => {
        if (pending.get(input.sessionID) === request) pending.delete(input.sessionID)
      })
      // 吞掉的只有 onError（toast 通道）自身的二次故障：请求失败已上报过一次，
      // toast 挂了不该把 pending 管理一起炸成 unhandled rejection
      .catch(() => {})
    pending.set(input.sessionID, request)
    return true
  }
}

interface SessionContextUsageProps {
  placement?: TooltipProps["placement"]
}

// 261012 Red 档位绝对 token 值（与 TUI 侧栏 barColor 同口径）：<320k 绿、320-360k 黄、
// 360-400k 橙、≥400k 红。v2 语义色没有橙色 state token
//（--v2-orange-* 是原始色阶不分亮暗），橙用 warning→danger 的 color-mix 自动适配主题。
const TIER_ORANGE = "color-mix(in srgb, var(--v2-state-fg-warning) 50%, var(--v2-state-fg-danger))"
const TIER_STROKE = [undefined, "var(--v2-state-fg-warning)", TIER_ORANGE, "var(--v2-state-fg-danger)"] as const
const TIER_TEXT = [
  "var(--v2-state-fg-success)",
  "var(--v2-state-fg-warning)",
  TIER_ORANGE,
  "var(--v2-state-fg-danger)",
] as const
// 260829 cc 条用的分档色。与圈共用 strokeTier()，但**常态档不同**：圈在常态刻意不上色
// （「没事发生时圈就该是平时的样子」），而条的职责是把占比画出来，没有填充色就什么都
// 看不到，所以常态给 info 蓝。警戒各档与圈完全一致。
const TIER_BAR = [
  "var(--v2-state-fg-info)",
  "var(--v2-state-fg-warning)",
  TIER_ORANGE,
  "var(--v2-state-fg-danger)",
] as const

function CompactConfirm(props: {
  sessionID: string
  modelID: string
  providerID: string
  description: string
  onConfirm: () => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
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
              props.onConfirm()
            }}
          >
            {language.t("prompt.compact.run")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export function SessionContextUsage(props: SessionContextUsageProps) {
  const dialog = useDialog()
  const sync = useSync()
  const language = useLanguage()
  const sdk = useSDK()
  const providers = useProviders()
  const { params } = useSessionLayout()

  // 261011 Red C1：失败 toast 复用 common.requestFailed（session-header 同款）；
  // 成功不加 toast——压缩摘要出现在消息流（CompactionPart）里，是天然反馈。
  const submitCompact = createCompactSubmit({
    summarize: (input) => sdk.client.session.summarize(input),
    onError: (error) =>
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: error instanceof Error ? error.message : String(error),
      }),
  })

  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []))
  const metrics = createMemo(() => getSessionContextMetrics(messages(), [...providers.all().values()]))
  const context = createMemo(() => metrics().context)
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))

  // 260819 cc 进度圈上色是纯装饰——哥哥明确说不会严格照它决定压缩时机，所以不为它引入
  // 任何新机制：progress-circle.css 本来就是 var(--progress-circle-progress, …) 的可覆盖
  // 写法，调用方传 style 即可，共享组件一行不用改。
  //
  // 260822 cc 颜色按上下文绝对量分档，与 TUI 相同，不依赖各模型窗口比例。
  const strokeTier = () => contextUsageTier(context()?.window)

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

  // window 为空 = 历史消息还没有 tokens.context（本会话本轮请求前），数字不显示，
  // 等下一轮写入——圈仍在，hover 也解释得清自己。
  const valueLabel = () => {
    const window = context()?.window
    return window === undefined ? undefined : formatter().compact(window)
  }
  const windowText = () => {
    const window = context()?.window
    return window === undefined ? "" : formatter().number(window)
  }
  const limitText = () => {
    const limit = context()?.limit
    return limit ? formatter().number(limit) : "—"
  }

  const compact = () => {
    const id = params.id
    const ctx = context()
    if (!id || !ctx) return
    dialog.show(() => (
      <CompactConfirm
        sessionID={id}
        modelID={ctx.message.modelID}
        providerID={ctx.message.providerID}
        description={language.t("prompt.compact.confirm", { window: windowText(), limit: limitText() })}
        onConfirm={() =>
          submitCompact({ sessionID: id, modelID: ctx.message.modelID, providerID: ctx.message.providerID })
        }
      />
    ))
  }

  // 260822 cc 首字延迟的显示：秒以下给毫秒（分辨 200ms 与 900ms 有意义），秒以上给一位
  // 小数（分辨 1.4s 与 1.5s 没意义，但 1.4s 与 4.2s 有意义）。
  const formatMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`)

  // 260822 cc 这个悬浮与右侧「上下文」面板的分工：**面板是会话账本，这里是当下这一轮**。
  // 首字 = created→firstChunk（排队与预填），解码 = firstChunk→completed 的 tok/s——
  // 两段分开是刻意的（与 TUI 侧边栏同样的取舍），口径见 session-context-metrics.ts。
  // 第一行的上下文窗口保留——它是这个圆圈本身的含义，没有它悬浮就解释不了自己。
  const tooltipValue = () => (
    // min-w：条的长度不该跟着那几行文字的宽度忽长忽短
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
                  出来，不引入新 token。宽度按 usage 钳在 100%：窗口口径可能短暂超过 limit
                  （比如上一轮刚压缩、limit 换了模型），条不该溢出容器。 */}
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
      {/* 261011 Red 合并后点击行为是精简（弹确认），悬浮里点明这一点。 */}
      <div class="mt-1 text-text-invert-base">{language.t("prompt.compact.clickHint")}</div>
    </div>
  )

  return (
    <Show when={params.id}>
      <Tooltip value={tooltipValue()} placement={props.placement ?? "top"}>
        <Button
          type="button"
          variant="ghost"
          class="h-6 shrink-0 gap-1.5 rounded-md px-1.5"
          onClick={compact}
          aria-label={language.t("command.session.compact")}
        >
          {circle()}
          <Show when={valueLabel()}>
            <span
              class="text-12-regular"
              style={{ color: TIER_TEXT[strokeTier()], "font-variant-numeric": "tabular-nums" }}
            >
              {valueLabel()}
            </span>
          </Show>
        </Button>
      </Tooltip>
    </Show>
  )
}
