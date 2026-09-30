import { DateTime } from "luxon"
// 260615 Red: DeepSeek/Xiaomi costs are already in CNY (official pricing), only USD providers need conversion.
// 260904 cc 汇率的四份拷贝已合并到 @redcode-ai/core/currency，改汇率只改那一处。
import { USD_TO_CNY } from "@redcode-ai/core/currency"

export function createSessionContextFormatter(locale: string) {
  const cny = new Intl.NumberFormat(locale, { style: "currency", currency: "CNY" })
  const usd = new Intl.NumberFormat(locale, { style: "currency", currency: "USD" })
  const compactNumber = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 })

  return {
    number(value: number | null | undefined) {
      if (value === undefined) return "—"
      if (value === null) return "—"
      return value.toLocaleString(locale)
    },
    // 260922 Red 窄容器（右栏折叠胶囊 ~280px）里「26,724,352 / 464,086 (98.29%)」
    // 会被截成半截，用紧凑记数（26.7M / 464.1K）才放得下。宽容器仍走 number()。
    compact(value: number | null | undefined) {
      if (value === undefined || value === null) return "—"
      return compactNumber.format(value)
    },
    percent(value: number | null | undefined) {
      if (value === undefined) return "—"
      if (value === null) return "—"
      return value.toLocaleString(locale) + "%"
    },
    time(value: number | undefined) {
      if (!value) return "—"
      return DateTime.fromMillis(value).setLocale(locale).toLocaleString(DateTime.DATETIME_MED)
    },
    cost(value: number | undefined | null, currency: "USD" | "CNY" = "USD") {
      if (value === undefined || value === null) return "—"
      if (currency === "CNY") return cny.format(value)
      return cny.format(value * USD_TO_CNY)
    },
   // 260930 Red 分桶显示：每桶按原币种格式化，「¥69.21 + $0.30」。不换算不混算——
   // provider 账单原币种是事实，汇率换算是产品策略（决策见 docs/notes 的 costByCurrency note）。
   // 两桶皆 0（纯免费套餐会话）按 ¥0.00 显示，与中文界面一致。
   costBuckets(buckets: { cny: number; usd: number }) {
     const parts: string[] = []
     if (buckets.cny > 0) parts.push(cny.format(buckets.cny))
     if (buckets.usd > 0) parts.push(usd.format(buckets.usd))
     if (parts.length === 0) return cny.format(0)
     return parts.join(" + ")
   },
  }
}
