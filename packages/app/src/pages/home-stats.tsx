// 260701 Red 首页左下角看板：跨 session 缓存效率环 + 累计花费。
// 数据来源：session.cost / session.tokens 是每个 session 落库时已经 denormalize 好的汇总列
// （见 packages/opencode/src/session/session.ts），前端已经把这些 session 对象加载好了，
// 纯本地 reduce，不需要新起 server/IPC 通路。
import { createMemo, For, Show } from "solid-js"
import type { Session } from "@redcode-ai/sdk/v2/client"
import { Tooltip } from "@redcode-ai/ui/tooltip"
import { CNY_PROVIDERS } from "@/components/session/session-context-metrics"
import { createSessionContextFormatter } from "@/components/session/session-context-format"
import { useLanguage } from "@/context/language"

// 260615 与 session-context-format.ts 的 USD_TO_CNY 保持一致，把跨模型花费统一折算成 ¥ 展示
const USD_TO_CNY = 6.76

type HomeStats = {
  costCNY: number
  cacheRead: number
  cacheWrite: number
  // 260701 miss 与 message 层的 tokens.input 是同一个值（session.ts:418-424 的 adjustedInputTokens），
  // 这里直接用 tokens.input 兜底，跟 session-context-metrics.ts 的 fallback 链保持一致
  cacheMiss: number
  output: number
  cacheHitPct: number | null
}

function aggregateHomeStats(sessions: Session[]): HomeStats {
  let costCNY = 0
  let cacheRead = 0
  let cacheWrite = 0
  let cacheMiss = 0
  let output = 0
  let input = 0

  for (const s of sessions) {
    const cost = s.cost ?? 0
    const isCNY = s.model?.providerID ? CNY_PROVIDERS.has(s.model.providerID) : true
    costCNY += isCNY ? cost : cost * USD_TO_CNY

    const t = s.tokens
    if (!t) continue
    cacheRead += t.cache.read ?? 0
    cacheWrite += t.cache.write ?? 0
    cacheMiss += t.cache.miss ?? 0
    output += (t.output ?? 0) + (t.reasoning ?? 0)
    input += t.input ?? 0
  }

  // 260707 Red fix: same either/or fallback bug as session-context-metrics.ts — miss tokens can be
  // mislabeled into cache.write for DeepSeek depending on which raw metadata field the SDK response
  // populated. miss and write never double-count the same tokens (cache.miss === tokens.input by
  // construction), so sum all three instead of picking one and silently dropping the rest.
  const miss = cacheMiss || input
  const denom = cacheRead + miss + cacheWrite
  const cacheHitPct = denom > 0 && cacheRead > 0 ? Math.round((cacheRead / denom) * 10000) / 100 : null

  return { costCNY, cacheRead, cacheWrite, cacheMiss: miss, output, cacheHitPct }
}

const RING_SIZE = 56
const RING_STROKE = 6
const RING_CENTER = RING_SIZE / 2
const RING_RADIUS = RING_CENTER - RING_STROKE / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
// 260701 Red 占比极小的分段（比如 output 常年 <1%）在环上会细到被反锯齿吃掉，
// 强制给非零分段一个最小可视弧长——纯视觉兜底，tooltip 里的数字仍然精确
const RING_MIN_ARC = 2.5

const RING_SEGMENTS: { key: keyof Pick<HomeStats, "cacheRead" | "cacheWrite" | "cacheMiss" | "output">; color: string; label: "home.stats.tokens.read" | "home.stats.tokens.write" | "home.stats.tokens.miss" | "home.stats.tokens.output" }[] = [
  { key: "cacheRead", color: "#3fb950", label: "home.stats.tokens.read" },
  { key: "cacheWrite", color: "#58a6ff", label: "home.stats.tokens.write" },
  { key: "cacheMiss", color: "#f85149", label: "home.stats.tokens.miss" },
  { key: "output", color: "#d29922", label: "home.stats.tokens.output" },
]

function StatsRing(props: { stats: HomeStats }) {
  const total = createMemo(() => props.stats.cacheRead + props.stats.cacheWrite + props.stats.cacheMiss + props.stats.output)
  const arcs = createMemo(() => {
    const t = total()
    if (t <= 0) return []
    let offset = 0
    const result: { color: string; dasharray: string; dashoffset: number }[] = []
    for (const seg of RING_SEGMENTS) {
      const value = props.stats[seg.key]
      if (value <= 0) continue
      const length = Math.max((value / t) * RING_CIRCUMFERENCE, RING_MIN_ARC)
      result.push({
        color: seg.color,
        dasharray: `${length} ${RING_CIRCUMFERENCE - length}`,
        dashoffset: -offset,
      })
      offset += length
    }
    return result
  })

  return (
    <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} fill="none">
      <circle
        cx={RING_CENTER}
        cy={RING_CENTER}
        r={RING_RADIUS}
        stroke="currentColor"
        class="text-v2-border-border-base"
        stroke-width={RING_STROKE}
      />
      <For each={arcs()}>
        {(arc) => (
          <circle
            cx={RING_CENTER}
            cy={RING_CENTER}
            r={RING_RADIUS}
            stroke={arc.color}
            stroke-width={RING_STROKE}
            stroke-dasharray={arc.dasharray}
            stroke-dashoffset={arc.dashoffset}
            transform={`rotate(-90 ${RING_CENTER} ${RING_CENTER})`}
            stroke-linecap="butt"
          />
        )}
      </For>
    </svg>
  )
}

export function HomeStatsPanel(props: { sessions: Session[] }) {
  const language = useLanguage()
  const formatter = createMemo(() => createSessionContextFormatter(language.intl()))
  const stats = createMemo(() => aggregateHomeStats(props.sessions))

  const tooltipValue = () => {
    const s = stats()
    return (
      <div>
        <For each={RING_SEGMENTS}>
          {(seg) => (
            <div class="flex items-center gap-2">
              <span class="inline-block size-2 rounded-full" style={{ background: seg.color }} />
              <span class="text-text-invert-base">{language.t(seg.label)}</span>
              <span class="text-text-invert-strong ml-auto">{formatter().number(s[seg.key])}</span>
            </div>
          )}
        </For>
      </div>
    )
  }

  return (
    <Show when={stats().cacheHitPct !== null || stats().costCNY > 0}>
      <div class="mt-4 flex min-w-0 items-center gap-3 rounded-[6px] px-2 py-2">
        <Tooltip value={tooltipValue()} placement="top">
          <div class="relative flex shrink-0 items-center justify-center">
            <StatsRing stats={stats()} />
            <span class="absolute text-[10px] font-medium text-v2-text-text-base tabular-nums">
              {stats().cacheHitPct !== null ? `${Math.round(stats().cacheHitPct!)}%` : "—"}
            </span>
          </div>
        </Tooltip>
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="text-11-regular text-v2-text-text-muted">
            {language.t("home.stats.cacheHit")} {stats().cacheHitPct !== null ? `${Math.round(stats().cacheHitPct!)}%` : "—"}
          </span>
          <span class="text-12-regular text-v2-text-text-base [font-weight:530] tabular-nums">
            {language.t("home.stats.cost")} {formatter().cost(stats().costCNY, "CNY")}
          </span>
        </div>
      </div>
    </Show>
  )
}
