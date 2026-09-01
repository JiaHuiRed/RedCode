import * as i18n from "@solid-primitives/i18n"

// 260810 cc 语种裁剪：与 app 层 language.tsx 同步收缩到中/日/英三语（哥哥拍板），
// 历史配置里的 zht 在 parseLocale 降级到 zh。
import { dict as desktopEn } from "./en"
import { dict as desktopZh } from "./zh"
import { dict as desktopJa } from "./ja"

// 260901 cc 只静态引 appEn，不引 appZh/appJa。
//
// 这个模块被 renderer/index.tsx 静态引入，于是三份 app 字典（en 55KB / zh 43KB / ja 47KB）
// 全部落进首屏 chunk —— 从打包产物的 sourcemap 归因里量到的，app/src/i18n/{en,zh,ja}.ts
// 三个都在 main-*.js 里。而 app 层的 language.tsx:42-43 本来是把 zh/ja 写成动态 import 的，
// 这里的静态引用把那份切分整个废掉了（对照：ui 层的 zh 正常切出了独立 chunk，只有 7KB）。
//
// 外壳自己只用 7 个 key：6 个在 desktop 自己的字典里，剩下 1 个 error.dev.rootNotFound
// 是 import.meta.env.DEV 分支里的开发期报错。app 界面的翻译走 app 自己的 LanguageProvider，
// 不经过这里。所以 appZh/appJa 对生产行为没有任何贡献，只贡献 90KB 首屏体积。
import { dict as appEn } from "../../../../app/src/i18n/en"

export type Locale = "en" | "zh" | "ja"

type RawDictionary = typeof appEn & typeof desktopEn
type Dictionary = i18n.Flatten<RawDictionary>

const LOCALES: readonly Locale[] = ["en", "zh", "ja"]

function detectLocale(): Locale {
  if (typeof navigator !== "object") return "en"

  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const language of languages) {
    if (!language) continue
    if (language.toLowerCase().startsWith("en")) return "en"
    if (language.toLowerCase().startsWith("zh")) return "zh"
    if (language.toLowerCase().startsWith("ja")) return "ja"
  }

  return "en"
}

function parseLocale(value: unknown): Locale | null {
  if (!value) return null
  if (typeof value !== "string") return null
  if (value === "zht") return "zh"
  if ((LOCALES as readonly string[]).includes(value)) return value as Locale
  return null
}

function parseRecord(value: unknown) {
  if (!value || typeof value !== "object") return null
  if (Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parseStored(value: unknown) {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function pickLocale(value: unknown): Locale | null {
  const direct = parseLocale(value)
  if (direct) return direct

  const record = parseRecord(value)
  if (!record) return null

  return parseLocale(record.locale)
}

const base = i18n.flatten({ ...appEn, ...desktopEn })

function build(locale: Locale): Dictionary {
  if (locale === "zh") return { ...base, ...i18n.flatten(desktopZh) }
  if (locale === "ja") return { ...base, ...i18n.flatten(desktopJa) }
  return base
}

const state = {
  locale: detectLocale(),
  dict: base as Dictionary,
  init: undefined as Promise<Locale> | undefined,
}

state.dict = build(state.locale)

const translate = i18n.translator(() => state.dict, i18n.resolveTemplate)

export function t(key: keyof Dictionary, params?: Record<string, string | number>) {
  return translate(key, params)
}

export function initI18n(): Promise<Locale> {
  const cached = state.init
  if (cached) return cached

  const promise = (async () => {
    const raw = await window.api.storeGet("redcode.global.dat", "language").catch(() => null)
    const value = parseStored(raw)
    const next = pickLocale(value) ?? state.locale

    state.locale = next
    state.dict = build(next)
    return next
  })().catch(() => state.locale)

  state.init = promise
  return promise
}
