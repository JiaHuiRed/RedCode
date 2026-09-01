/**
 * 首页用量看板。
 *
 * 260901 cc 位置：主区会话卡下方（原先侧边栏底部那个圆环搬上来），作用域跟着侧边栏选中的
 * 项目走 —— 与 statsSessions 同一口径，只是数据换成服务端聚合（前端那份只覆盖已加载的
 * 114 个会话，算不出真·累计）。
 *
 * 三种形态各自的选型理由：
 *   指标块  —— 单个数字没有可比较的维度，画成图只是把一个数字铺开占地方，用数字块。
 *   热力图  —— 日历日 × 强度，顺序编码，单色相浅→深；0 走底色而不是最浅一档
 *              （「没用过」和「用得少」是两回事）。
 *   堆叠柱  —— 每天的产出构成，分类编码，固定色序不循环，第 6 个之后折进「其他」。
 * 调色板按本仓 yuqi 主题底色跑过验证器，结果与约束写在 home-usage.data.ts。
 *
 * 文字一律用 v2 text token，**不用系列色**——系列色只出现在色块上，标签旁边配色块来带身份。
 */
import { createMemo, createSignal, For, Show } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { Tooltip } from "@redcode-ai/ui/tooltip"
import { useTheme } from "@redcode-ai/ui/theme"
import { useLanguage } from "@/context/language"
import { useQueryOptions } from "@/context/server-sync"
import { pathKey } from "@/utils/path-key"
import { createSessionContextFormatter } from "@/components/session/session-context-format"
import { useProviders } from "@/hooks/use-providers"
import { RING_SEGMENTS, StatsRing, USD_TO_CNY } from "./home-stats"
import {
  calendarDays,
  heatLevel,
  HEAT_DARK,
  HEAT_LIGHT,
  SERIES_DARK,
  SERIES_LIGHT,
  SERIES_OTHER_DARK,
  SERIES_OTHER_LIGHT,
  stackByDay,
  topModels,
  type ModelSlice,
  type Usage,
} from "./home-usage.data"

type Range = "all" | "30d" | "7d"
const RANGES: Range[] = ["all", "30d", "7d"]

// 260901 cc 边线看着「太淡」的根因不是 token 太浅——会话卡（home-kanban.tsx:199）用的是
//   同一个 border token，但它还带 bg-v2-background-bg-base。只有描边没有面，就会浮在壁纸上
//   只剩一条发丝线。这里跟会话卡取同一套：面 + 同样的边，观感自然对齐。
const TILE =
  "flex min-w-0 flex-col gap-0.5 rounded-[6px] border border-v2-border-border-base bg-v2-background-bg-base px-2.5 py-1.5"
const TILE_LABEL = "text-11-regular text-v2-text-text-muted truncate"
const TILE_VALUE = "text-14-normal [font-weight:530] text-v2-text-text-base tabular-nums truncate"

function compact(value: number) {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return String(Math.round(value))
}

function Segmented<T extends string>(props: { value: T; options: readonly T[]; label: (v: T) => string; onChange: (v: T) => void }) {
  return (
    <div class="flex shrink-0 gap-0.5 rounded-[6px] bg-v2-background-bg-deep p-0.5">
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            onClick={() => props.onChange(option)}
            class={`rounded-[4px] px-2 py-0.5 text-11-regular transition-colors duration-150 ${
              props.value === option
                ? "bg-v2-background-bg-base text-v2-text-text-base [font-weight:530]"
                : "text-v2-text-text-muted hover:text-v2-text-text-base"
            }`}
          >
            {props.label(option)}
          </button>
        )}
      </For>
    </div>
  )
}

function Heatmap(props: { usage: Usage; dark: boolean; formatNumber: (n: number) => string }) {
  const ramp = () => (props.dark ? HEAT_DARK : HEAT_LIGHT)
  const days = createMemo(() => calendarDays(props.usage, Date.now()))
  const byDay = createMemo(() => new Map(props.usage.daily.map((d) => [d.day, d])))
  // 分位数分档：token 用量是重尾分布，等距分档会把绝大多数格子压进最浅一档
  const sorted = createMemo(() =>
    props.usage.daily
      .map((d) => d.output)
      .filter((v) => v > 0)
      .sort((a, b) => a - b),
  )

  const weeks = createMemo(() => {
    const list = days()
    const out: string[][] = []
    for (let i = 0; i < list.length; i += 7) out.push(list.slice(i, i + 7))
    return out
  })

  return (
    <div class="flex gap-[3px] overflow-x-auto pb-1">
      <For each={weeks()}>
        {(week) => (
          <div class="flex shrink-0 flex-col gap-[3px]">
            <For each={week}>
              {(day) => {
                const entry = () => byDay().get(day)
                const level = () => heatLevel(entry()?.output ?? 0, sorted(), ramp().length)
                return (
                  <Tooltip
                    placement="top"
                    value={
                      <div class="flex flex-col gap-0.5">
                        <span class="text-text-invert-strong tabular-nums">{day}</span>
                        <span class="text-text-invert-base tabular-nums">
                          {props.formatNumber(entry()?.output ?? 0)} out · {entry()?.messages ?? 0}
                        </span>
                      </div>
                    }
                  >
                    <div
                      class="size-[11px] rounded-[2px] border border-v2-border-border-base/40"
                      style={{ background: level() < 0 ? "transparent" : ramp()[level()] }}
                    />
                  </Tooltip>
                )
              }}
            </For>
          </div>
        )}
      </For>
    </div>
  )
}

function StackedBars(props: { usage: Usage; slices: ModelSlice[]; color: (slice: ModelSlice) => string; formatNumber: (n: number) => string }) {
  const buckets = createMemo(() => stackByDay(props.usage, props.slices))
  const max = createMemo(() => Math.max(1, ...buckets().map((b) => b.total)))

  return (
    <div class="flex h-[168px] items-end gap-[3px] overflow-x-auto">
      <For each={buckets()}>
        {(bucket) => (
          <Tooltip
            placement="top"
            value={
              <div class="flex flex-col gap-0.5">
                <span class="text-text-invert-strong tabular-nums">{bucket.day}</span>
                <For each={bucket.segments.filter((s) => s.output > 0)}>
                  {(segment) => {
                    const slice = () => props.slices.find((s) => s.key === segment.key)!
                    return (
                      <div class="flex items-center gap-2">
                        <span class="inline-block size-2 rounded-full" style={{ background: props.color(slice()) }} />
                        <span class="text-text-invert-base">{slice().isOther ? "…" : slice().label}</span>
                        <span class="ml-auto text-text-invert-strong tabular-nums">
                          {props.formatNumber(segment.output)}
                        </span>
                      </div>
                    )
                  }}
                </For>
              </div>
            }
          >
            {/* 柱子本身细，命中区域给整列——鼠标不用瞄 */}
            <div class="flex h-full w-[10px] shrink-0 cursor-default flex-col justify-end gap-[2px]">
              <For each={bucket.segments.filter((s) => s.output > 0)}>
                {(segment, index) => {
                  const slice = () => props.slices.find((s) => s.key === segment.key)!
                  return (
                    <div
                      class="w-full"
                      style={{
                        height: `${Math.max((segment.output / max()) * 100, 1.5)}%`,
                        background: props.color(slice()),
                        // 圆角只给最上面那段的顶端，底端贴基线
                        "border-radius": index() === 0 ? "0 0 0 0" : "0",
                      }}
                    />
                  )
                }}
              </For>
            </div>
          </Tooltip>
        )}
      </For>
    </div>
  )
}

export function HomeUsagePanel(props: { directory: string | undefined }) {
  const language = useLanguage()
  const theme = useTheme()
  const providers = useProviders()
  const options = useQueryOptions()
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))
  const [tab, setTab] = createSignal<"overview" | "models">("overview")
  const [range, setRange] = createSignal<Range>("all")

  // 没选中项目时用一个占位 key 并 enabled:false —— 保持 options 形状恒定，
  // 分支返回两种不同形状会让 useQuery 的类型推断塌掉。
  const key = createMemo(() => pathKey(props.directory ?? ""))
  const query = useQuery(() => ({
    ...options.usage(key(), range()),
    enabled: !!props.directory,
  }))

  const usage = () => query.data as Usage | undefined
  const dark = () => theme.mode() === "dark"

  // 服务端只出原始 cost（币种混合）。折算按 provider 目录里的 model.cost.currency 走，
  // 与 home-stats.tsx / session-context-metrics.ts 同一口径；汇率常量直接复用它那份，
  // 不在这里再写一个（仓里已经有两处，第三处必然会漂）。
  const costCNY = createMemo(() => {
    const data = usage()
    if (!data) return 0
    const directory = providers.all()
    return data.models.reduce((sum, model) => {
      const quoted = directory.get(model.providerID)?.models?.[model.modelID]?.cost?.currency
      return sum + (quoted === "CNY" ? model.cost : model.cost * USD_TO_CNY)
    }, 0)
  })
  const slices = createMemo(() => (usage() ? topModels(usage()!.models) : []))
  const color = (slice: ModelSlice) => {
    if (slice.isOther) return dark() ? SERIES_OTHER_DARK : SERIES_OTHER_LIGHT
    const palette = dark() ? SERIES_DARK : SERIES_LIGHT
    const index = slices().filter((s) => !s.isOther).findIndex((s) => s.key === slice.key)
    return palette[Math.max(0, index) % palette.length]!
  }

  const number = (value: number) => formatter().number(value)
  const t = language.t

  // 圆环沿用 home-stats 的 HomeStats 形状，数据换成服务端聚合。
  // 币种：服务端只出原始 cost（混合币种），这里按 provider 目录里 model.cost.currency 折算，
  // 与 home-stats.tsx / session-context-metrics.ts 同一套口径，不引入第三份汇率常量。
  const ring = createMemo(() => {
    const data = usage()
    const cacheRead = data?.tokens.cacheRead ?? 0
    const cacheWrite = data?.tokens.cacheWrite ?? 0
    const cacheMiss = data?.tokens.input ?? 0
    const output = (data?.tokens.output ?? 0) + (data?.tokens.reasoning ?? 0)
    const denominator = cacheRead + cacheWrite + cacheMiss
    return {
      costCNY: costCNY(),
      cacheRead,
      cacheWrite,
      cacheMiss,
      output,
      cacheHitPct: denominator > 0 ? (cacheRead / denominator) * 100 : null,
    }
  })

  const ringTooltip = () => (
    <div>
      <For each={RING_SEGMENTS}>
        {(segment) => (
          <div class="flex items-center gap-2">
            <span class="inline-block size-2 rounded-full" style={{ background: segment.color }} />
            <span class="text-text-invert-base">{t(segment.label)}</span>
            <span class="ml-auto text-text-invert-strong tabular-nums">{number(ring()[segment.key])}</span>
          </div>
        )}
      </For>
    </div>
  )

  return (
    <Show when={usage()}>
      {(data) => (
        <div class="mt-6 flex flex-col gap-3 rounded-[8px] border border-v2-border-border-base bg-v2-background-bg-base p-3">
          <div class="flex flex-wrap items-center gap-2">
            <Segmented
              value={tab()}
              options={["overview", "models"] as const}
              label={(v) => t(v === "overview" ? "home.usage.tab.overview" : "home.usage.tab.models")}
              onChange={setTab}
            />
            <div class="ml-auto">
              <Segmented
                value={range()}
                options={RANGES}
                label={(v) => t(v === "all" ? "home.usage.range.all" : v === "30d" ? "home.usage.range.30d" : "home.usage.range.7d")}
                onChange={setRange}
              />
            </div>
          </div>

          <Show when={tab() === "overview"}>
            {/* 260901 cc 原侧边栏底部那个缓存命中圆环搬到这里，形状不变，但数据换成服务端
                聚合的**真实总量**——它原先只覆盖已加载的那批会话，显示的「累计」并不是累计。
                cacheMiss 取 tokens.input：message 层这两个是同一个值，与 home-stats.tsx
                的 fallback 链一致。 */}
            <div class="flex flex-wrap items-center gap-3">
              <Tooltip placement="top" value={ringTooltip()}>
                <div class="relative flex shrink-0 items-center justify-center">
                  <StatsRing stats={ring()} />
                  <span class="absolute text-[10px] font-medium text-v2-text-text-base tabular-nums">
                    {ring().cacheHitPct !== null ? `${ring().cacheHitPct!.toFixed(1)}%` : "—"}
                  </span>
                </div>
              </Tooltip>
              <div class="flex min-w-0 flex-col gap-0.5">
                <span class="text-11-regular text-v2-text-text-muted">
                  {t("home.stats.cacheHit")}{" "}
                  {ring().cacheHitPct !== null ? `${ring().cacheHitPct!.toFixed(2)}%` : "—"}
                </span>
                <span class="text-12-regular tabular-nums text-v2-text-text-base [font-weight:530]">
                  {t("home.stats.cost")} {formatter().cost(ring().costCNY, "CNY")}
                </span>
              </div>
              {/* 热力图跟圆环同一行、靠右吃掉剩余宽度 —— 原先它独占一行缩在左下角，
                  而八个指标块横跨全宽各装一个三位数，整块面板显得又大又空。 */}
              <div class="ml-auto min-w-0 overflow-hidden">
                <Heatmap usage={data()} dark={dark()} formatNumber={number} />
              </div>
            </div>
            <div class="grid gap-2 grid-cols-2 sm:grid-cols-4 xl:grid-cols-8">
              <div class={TILE}>
                <span class={TILE_LABEL}>{t("home.usage.tile.sessions")}</span>
                <span class={TILE_VALUE}>{number(data().sessions)}</span>
              </div>
              <div class={TILE}>
                <span class={TILE_LABEL}>{t("home.usage.tile.messages")}</span>
                <span class={TILE_VALUE}>{number(data().messages)}</span>
              </div>
              <div class={TILE}>
                <span class={TILE_LABEL}>{t("home.usage.tile.output")}</span>
                <span class={TILE_VALUE}>{compact(data().tokens.output + data().tokens.reasoning)}</span>
              </div>
              <div class={TILE}>
                <span class={TILE_LABEL}>{t("home.usage.tile.cacheRead")}</span>
                <span class={TILE_VALUE}>{compact(data().tokens.cacheRead)}</span>
              </div>
              <div class={TILE}>
                <span class={TILE_LABEL}>{t("home.usage.tile.activeDays")}</span>
                <span class={TILE_VALUE}>{number(data().activeDays)}</span>
              </div>
              <div class={TILE}>
                <span class={TILE_LABEL}>{t("home.usage.tile.currentStreak")}</span>
                <span class={TILE_VALUE}>{t("home.usage.days", { count: data().currentStreak })}</span>
              </div>
              <div class={TILE}>
                <span class={TILE_LABEL}>{t("home.usage.tile.longestStreak")}</span>
                <span class={TILE_VALUE}>{t("home.usage.days", { count: data().longestStreak })}</span>
              </div>
              <div class={TILE}>
                <span class={TILE_LABEL}>{t("home.usage.tile.peakHour")}</span>
                <span class={TILE_VALUE}>
                  {data().peakHour === undefined ? "—" : `${String(data().peakHour).padStart(2, "0")}:00`}
                </span>
              </div>
            </div>
          </Show>

          <Show when={tab() === "models"}>
            <StackedBars usage={data()} slices={slices()} color={color} formatNumber={number} />
            {/* 图例始终在：浅色下调色板对比度低于 3:1，规范要求配可见标签兜底，
                所以每行都带 in / out / 占比 三个数字，而不只是一个色块加名字。 */}
            <div class="flex flex-col gap-1">
              <For each={slices()}>
                {(slice) => (
                  <div class="flex min-w-0 items-center gap-2 text-11-regular">
                    <span class="inline-block size-2 shrink-0 rounded-full" style={{ background: color(slice) }} />
                    <span class="truncate text-v2-text-text-base">
                      {slice.isOther ? t("home.usage.other") : slice.label}
                    </span>
                    <span class="ml-auto shrink-0 tabular-nums text-v2-text-text-muted">
                      {compact(slice.input)} in · {compact(slice.output)} out
                    </span>
                    <span class="w-12 shrink-0 text-right tabular-nums text-v2-text-text-base [font-weight:530]">
                      {(slice.share * 100).toFixed(1)}%
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      )}
    </Show>
  )
}
