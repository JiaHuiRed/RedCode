// 260816 Red: 通用峰谷定价旁路表。model.cost 是静态单价，无法表达按时段/按生效时间的
// 定价变化（DeepSeek 2026-08-17 起峰谷定价是第一个用例，难保别家以后不跟进）。
// 记账端（Session.getUsage）按请求时刻查这张表取价；未命中的模型走原有 model.cost 路径。
// 数据以官方公告为准，价格单位与 model.cost 一致（CNY_PRICING 覆盖过的模型为人民币）。

export interface CostRate {
  input: number
  output: number
  cache: { read: number; write: number }
}

export interface TieredPricingSegment {
  /** 段生效时刻（epoch ms，含）。查价取 effectiveFrom <= time 的最近一段。 */
  effectiveFrom: number
  /** 高峰价；无 offpeak 时即全时段固定价。 */
  peak: CostRate
  /** 空闲价；存在即峰谷定价，缺失即固定价。 */
  offpeak?: CostRate
  /** 高峰时段窗口 [startHour, endHour)，闭开区间；offpeak 存在时必填。 */
  peakWindows?: Array<readonly [number, number]>
  /** 时区偏移（分钟，相对 UTC），默认 480 = 北京时间（国内厂商无夏令时）。 */
  timezoneOffsetMinutes?: number
}

const BEIJING_OFFSET = 480

// DeepSeek 官方公告（2026-08-17 00:00 北京时间生效）：
// 高峰时段 = 北京时间 9:00-12:00、14:00-18:00，价格为空闲时段 2 倍。
// 旧价段 effectiveFrom 0 表示"红码上线以来一直这个价"，供历史时刻查价回退。
const DS_PEAK_WINDOWS: Array<readonly [number, number]> = [
  [9, 12],
  [14, 18],
]
// 2026-08-17 00:00 北京时间 = 2026-08-16T16:00:00Z
const DS_PEAK_PRICING_FROM = Date.parse("2026-08-16T16:00:00Z")

const DS_V4_FLASH_SEGMENTS: TieredPricingSegment[] = [
  {
    effectiveFrom: 0,
    peak: { input: 1, output: 2, cache: { read: 0.02, write: 1 } },
  },
  {
    effectiveFrom: DS_PEAK_PRICING_FROM,
    peak: { input: 3, output: 9, cache: { read: 0.1, write: 3 } },
    offpeak: { input: 1.5, output: 4.5, cache: { read: 0.05, write: 1.5 } },
    peakWindows: DS_PEAK_WINDOWS,
  },
]

const DS_V4_PRO_SEGMENTS: TieredPricingSegment[] = [
  {
    effectiveFrom: 0,
    peak: { input: 3, output: 6, cache: { read: 0.025, write: 3 } },
  },
  {
    effectiveFrom: DS_PEAK_PRICING_FROM,
    peak: { input: 9, output: 27, cache: { read: 0.3, write: 9 } },
    offpeak: { input: 4.5, output: 13.5, cache: { read: 0.15, write: 4.5 } },
    peakWindows: DS_PEAK_WINDOWS,
  },
]

export const TIERED_PRICING: Record<string, Record<string, TieredPricingSegment[]>> = {
  deepseek: {
    "deepseek-v4-flash": DS_V4_FLASH_SEGMENTS,
    "deepseek-v4-pro": DS_V4_PRO_SEGMENTS,
  },
  "opencode-go": {
    "deepseek-v4-flash": DS_V4_FLASH_SEGMENTS,
    "deepseek-v4-pro": DS_V4_PRO_SEGMENTS,
  },
}

export function resolveTieredCost(providerID: string, modelID: string, time: number): CostRate | undefined {
  const segments = TIERED_PRICING[providerID]?.[modelID]
  if (!segments?.length) return undefined
  let hit: TieredPricingSegment | undefined
  for (const segment of segments) {
    if (segment.effectiveFrom <= time) hit = segment
  }
  if (!hit) return undefined
  if (!hit.offpeak) return hit.peak
  const tz = hit.timezoneOffsetMinutes ?? BEIJING_OFFSET
  const hour = new Date(time + tz * 60_000).getUTCHours()
  const isPeak = hit.peakWindows?.some(([start, end]) => hour >= start && hour < end) ?? false
  return isPeak ? hit.peak : hit.offpeak
}
