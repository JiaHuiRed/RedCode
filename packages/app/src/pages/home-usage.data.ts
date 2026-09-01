/**
 * 首页用量看板的纯数据层：调色板、分档、把服务端聚合整理成图表要的形状。
 *
 * 260901 cc 抽成纯模块只为一件事：这里每一条都能单测，而画图那部分不能。
 */
import type { SessionUsageResponse } from "@redcode-ai/sdk/v2/client"

export type Usage = SessionUsageResponse

/**
 * 分类色。8 槽里取前 6，明暗各一套。
 *
 * 来自 dataviz 规范的默认分类主题，并按本仓 yuqi 主题的底色（浅 #faf2f6 / 暗 #321a34）
 * 重跑过验证器：
 *   浅色  亮度带 PASS · 色度下限 PASS · 色盲相邻最差 ΔE 9.1 · 常视觉最差 ΔE 19.6
 *         对比度 WARN（4 个低于 3:1）→ **必须配可见标签**，规范里这条不可豁免，
 *         所以图例强制带上 in/out/占比 三个数字，不是装饰。
 *   暗色  五项全 PASS（含对比度 ≥3:1）
 *
 * 顺序固定，**不循环使用**。第 7 个模型不会拿到新颜色，一律折进「其他」——见 topModels。
 */
export const SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"] as const
export const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"] as const

/** 「其他」永远用中性灰，不占分类槽——它不是一个实体，是一堆实体的和。 */
export const SERIES_OTHER_LIGHT = "#8a8a85"
export const SERIES_OTHER_DARK = "#7a7a75"

/**
 * 热力图的单色阶梯（蓝，浅→深）。
 * 顺序编码只允许一个色相；最浅那档表示「接近零」。0 单独走底色，不进这个梯子。
 */
export const HEAT_LIGHT = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf"] as const
export const HEAT_DARK = ["#184f95", "#256abf", "#2a78d6", "#5598e7", "#9ec5f4"] as const

/** 分类槽最多 6 个（含「其他」占 1），所以真实模型最多列 5 个。 */
export const MAX_MODEL_SERIES = 5

export type ModelSlice = {
  key: string
  providerID: string
  modelID: string
  label: string
  messages: number
  input: number
  output: number
  cost: number
  share: number
  isOther: boolean
}

export const modelKey = (providerID: string, modelID: string) => `${providerID}/${modelID}`

/**
 * 按产出排序取前 N，其余全部折进「其他」。
 *
 * 这不是审美取舍，是 dataviz 规范的硬约束：分类色按固定顺序分配、**绝不循环**，
 * 第 9 个系列不能凭空生成一个色相。他这台机器上 RedCode 项目有 30 个模型，
 * 不折叠的话必然循环取色，两个不同模型拿到同一个颜色。
 */
export function topModels(models: Usage["models"], limit = MAX_MODEL_SERIES): ModelSlice[] {
  const sorted = [...models].sort((a, b) => b.output - a.output)
  const totalOutput = sorted.reduce((sum, m) => sum + m.output, 0)
  const share = (output: number) => (totalOutput > 0 ? output / totalOutput : 0)

  // 260901 cc 同一个 modelID 可以来自不同 provider（他这里 deepseek-v4-flash 同时挂在
  //   opencode-go 与 deepseek 下），只显示 modelID 会让图例出现两行同名不同色 ——
  //   那正是「身份不能只靠颜色区分」失败的样子。只在真的重名时才带上 provider 前缀，
  //   不重名的保持短标签。
  const duplicated = new Set(
    sorted.map((m) => m.modelID).filter((id, i, all) => all.indexOf(id) !== i),
  )

  const head = sorted.slice(0, limit).map((m) => ({
    key: modelKey(m.providerID, m.modelID),
    providerID: m.providerID,
    modelID: m.modelID,
    label: duplicated.has(m.modelID) ? `${m.providerID} / ${m.modelID}` : m.modelID,
    messages: m.messages,
    input: m.input,
    output: m.output,
    cost: m.cost,
    share: share(m.output),
    isOther: false,
  }))

  const tail = sorted.slice(limit)
  if (tail.length === 0) return head

  const merged = tail.reduce(
    (acc, m) => ({
      messages: acc.messages + m.messages,
      input: acc.input + m.input,
      output: acc.output + m.output,
      cost: acc.cost + m.cost,
    }),
    { messages: 0, input: 0, output: 0, cost: 0 },
  )
  return [
    ...head,
    {
      key: "__other__",
      providerID: "",
      modelID: "",
      label: "",
      ...merged,
      share: share(merged.output),
      isOther: true,
    },
  ]
}

export type DayBucket = { day: string; total: number; segments: { key: string; output: number }[] }

/**
 * 按天 × 模型整理成堆叠柱要的形状；不在 slices 里的模型全部并进「其他」那一段。
 * 段的顺序与 slices 一致，这样每根柱子里颜色的上下顺序都相同——顺序一乱就没法比较了。
 */
export function stackByDay(usage: Usage, slices: ModelSlice[]): DayBucket[] {
  const known = new Set(slices.filter((s) => !s.isOther).map((s) => s.key))
  const hasOther = slices.some((s) => s.isOther)
  const byDay = new Map<string, Map<string, number>>()

  for (const row of usage.dailyByModel) {
    const key = modelKey(row.providerID, row.modelID)
    const bucket = known.has(key) ? key : hasOther ? "__other__" : undefined
    if (!bucket) continue
    let day = byDay.get(row.day)
    if (!day) {
      day = new Map()
      byDay.set(row.day, day)
    }
    day.set(bucket, (day.get(bucket) ?? 0) + row.output)
  }

  // 日期轴要连续：中间没用过的那些天也得出现，否则柱子会被挤在一起、看不出断档
  const days = usage.daily.map((d) => d.day).sort()
  return days.map((day) => {
    const found = byDay.get(day)
    const segments = slices.map((s) => ({ key: s.key, output: found?.get(s.key) ?? 0 }))
    return { day, total: segments.reduce((sum, s) => sum + s.output, 0), segments }
  })
}

/**
 * 热力图分档。
 *
 * 用**分位数**而不是等距：token 用量是重尾分布（他这里单日产出从几万到三十几万），
 * 等距分档会让绝大多数格子挤在最浅一档，热力图退化成一片空白加零星几个深块。
 * 0 返回 -1，由调用方画成底色——「没用过」和「用得少」是两回事。
 */
export function heatLevel(value: number, sorted: number[], steps: number) {
  if (value <= 0) return -1
  if (sorted.length === 0) return 0
  for (let i = steps - 1; i >= 1; i--) {
    const cut = sorted[Math.floor((sorted.length - 1) * (i / steps))]
    if (cut !== undefined && value >= cut) return i
  }
  return 0
}

/** 连续日期轴，含中间没有任何活动的天。 */
export function calendarDays(usage: Usage, now: number, maxWeeks = 26): string[] {
  const iso = (t: number) => new Date(t - new Date(t).getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
  const days = usage.daily.map((d) => d.day).sort()
  const last = days[days.length - 1]
  const end = last && last > iso(now) ? last : iso(now)
  const endTime = Date.parse(`${end}T00:00:00Z`)
  // 从结束日往回补到周日，让每一列都是完整的一周
  const endDow = new Date(endTime).getUTCDay()
  const total = maxWeeks * 7 - (6 - endDow)
  const out: string[] = []
  for (let i = total - 1; i >= 0; i--) out.push(new Date(endTime - i * 86_400_000).toISOString().slice(0, 10))
  return out
}
