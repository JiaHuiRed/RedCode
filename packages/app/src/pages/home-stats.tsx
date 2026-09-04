// 260701 Red 跨 session 缓存效率环。
// 260901 cc 原先它连着一个在侧边栏底部的面板，数据是前端对**已加载会话**的 reduce ——
//   那意味着它显示的「累计花费」并不是累计（实测圆环 ¥253.68，而该项目 268 个会话的真实
//   总额不是这个数）。面板已搬到主区并改用服务端聚合（home-usage.tsx），这里只留圆环本身。
import { createMemo, For } from "solid-js"

// 260904 cc 汇率的四份拷贝已合并到 @redcode-ai/core/currency。这里继续 re-export，
// 是因为 home-usage.tsx 一直从本模块取它，改成直连 core 属于无谓的连带改动。
export { USD_TO_CNY } from "@redcode-ai/core/currency"

export type HomeStats = {
  costCNY: number
  cacheRead: number
  cacheWrite: number
  // 260701 miss 与 message 层的 tokens.input 是同一个值（session.ts:418-424 的 adjustedInputTokens），
  // 这里直接用 tokens.input 兜底，跟 session-context-metrics.ts 的 fallback 链保持一致
  cacheMiss: number
  output: number
  cacheHitPct: number | null
}

type ProviderDirectory = {
  id: string
  models: Record<string, { cost?: { currency?: "USD" | "CNY" } } | undefined>
}

const RING_SIZE = 56
const RING_STROKE = 6
const RING_CENTER = RING_SIZE / 2
const RING_RADIUS = RING_CENTER - RING_STROKE / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
// 260701 Red 占比极小的分段（比如 output 常年 <1%）在环上会细到被反锯齿吃掉，
// 强制给非零分段一个最小可视弧长——纯视觉兜底，tooltip 里的数字仍然精确
const RING_MIN_ARC = 2.5

export const RING_SEGMENTS: {
  key: keyof Pick<HomeStats, "cacheRead" | "cacheWrite" | "cacheMiss" | "output">
  color: string
  label: "home.stats.tokens.read" | "home.stats.tokens.write" | "home.stats.tokens.miss" | "home.stats.tokens.output"
}[] = [
  { key: "cacheRead", color: "#3fb950", label: "home.stats.tokens.read" },
  { key: "cacheWrite", color: "#58a6ff", label: "home.stats.tokens.write" },
  { key: "cacheMiss", color: "#f85149", label: "home.stats.tokens.miss" },
  { key: "output", color: "#d29922", label: "home.stats.tokens.output" },
]

export function StatsRing(props: { stats: HomeStats }) {
  const total = createMemo(
    () => props.stats.cacheRead + props.stats.cacheWrite + props.stats.cacheMiss + props.stats.output,
  )
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
