import { DateTime } from "luxon"

// 260615 Red: DeepSeek/Xiaomi costs are already in CNY (official pricing),
// only USD providers need conversion. Rate updated from 7.2 to 6.76.
// 260731 Karina 汇率更新为 6.75（哥哥给定）。
// 260827 cc 汇率 6.75 → 6.72（哥哥给定）。四处 USD_TO_CNY 必须同步改，见本文件同名常量的其余三份：
//   app/pages/home-stats.tsx、tui/feature-plugins/home/footer.tsx、tui/feature-plugins/sidebar/context.tsx。
const USD_TO_CNY = 6.72

export function createSessionContextFormatter(locale: string) {
  const cny = new Intl.NumberFormat(locale, { style: "currency", currency: "CNY" })
  const usd = new Intl.NumberFormat(locale, { style: "currency", currency: "USD" })

  return {
    number(value: number | null | undefined) {
      if (value === undefined) return "—"
      if (value === null) return "—"
      return value.toLocaleString(locale)
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
  }
}
