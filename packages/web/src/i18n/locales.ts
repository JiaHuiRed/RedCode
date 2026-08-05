// 260805 Red 文档语种收敛为中日英三种（root=英文 / ja / zh-cn）。
// 原先 18 种全部来自上游 opencode，无人维护、每次改文档都要同步 18 份。
// 其余语言的访客按下面的匹配规则回落到最接近的一种，最终兜底 root。
export const docsLocale = ["ja", "zh-cn"] as const

export type DocsLocale = (typeof docsLocale)[number]

export const locale = ["root", ...docsLocale] as const

export type Locale = (typeof locale)[number]

export const localeAlias = {
  en: "root",
  ja: "ja",
  root: "root",
  zh: "zh-cn",
  "zh-cn": "zh-cn",
  // 繁中不再单独出文档，统一回落简体
  zht: "zh-cn",
  "zh-tw": "zh-cn",
} as const satisfies Record<string, Locale>

const starts = [
  ["ja", "ja"],
  ["en", "root"],
] as const

function parse(input: string) {
  let decoded = ""
  try {
    decoded = decodeURIComponent(input)
  } catch {
    return null
  }

  const value = decoded.trim().toLowerCase()
  if (!value) return null
  return value
}

export function exactLocale(input: string) {
  const value = parse(input)
  if (!value) return null
  if (value in localeAlias) {
    return localeAlias[value as keyof typeof localeAlias]
  }

  return null
}

export function matchLocale(input: string) {
  const value = parse(input)
  if (!value) return null

  // 简繁一律走 zh-cn
  if (value.startsWith("zh")) return "zh-cn"

  if (value in localeAlias) {
    return localeAlias[value as keyof typeof localeAlias]
  }

  return starts.find((item) => value.startsWith(item[0]))?.[1] ?? null
}
