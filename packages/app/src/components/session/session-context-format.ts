import { DateTime } from "luxon"

export function createSessionContextFormatter(locale: string) {
  // 260613 Red costs are in USD; convert to CNY for display
  const USD_TO_CNY = 7.2
  const cny = new Intl.NumberFormat(locale, { style: "currency", currency: "CNY" })

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
    cost(value: number | undefined | null) {
      if (value === undefined || value === null) return "—"
      return cny.format(value * USD_TO_CNY)
    },
  }
}
