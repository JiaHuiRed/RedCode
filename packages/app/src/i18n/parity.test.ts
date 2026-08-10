import { describe, expect, test } from "bun:test"
import { dict as en } from "./en"
import { dict as ja } from "./ja"
import { dict as zh } from "./zh"
import { dict as uiEn } from "@redcode-ai/ui/i18n/en"
import { dict as uiJa } from "@redcode-ai/ui/i18n/ja"
import { dict as uiZh } from "@redcode-ai/ui/i18n/zh"

// 260810 cc audit R10 + 语种裁剪：18 语 → 中/日/英三语。旧版 parity 只断言 2 个
// 手挑的 key，16 语各缺 84 个键都没拦住；现在改为全键集 diff——en 是基准，zh/ja
// 缺一个键或多一个孤儿键都直接红，app 层与 ui 层两套词典一起管。
type Dict = Record<string, unknown>

function flatten(obj: Dict, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === "object") Object.assign(out, flatten(value as Dict, next))
    else out[next] = String(value)
  }
  return out
}

function diff(base: Dict, target: Dict) {
  const baseKeys = new Set(Object.keys(flatten(base)))
  const targetKeys = new Set(Object.keys(flatten(target)))
  return {
    missing: [...baseKeys].filter((key) => !targetKeys.has(key)),
    extra: [...targetKeys].filter((key) => !baseKeys.has(key)),
  }
}

describe("i18n parity", () => {
  const app = { zh, ja } as const
  const ui = { zh: uiZh, ja: uiJa } as const

  for (const [locale, dict] of Object.entries(app)) {
    test(`app/${locale} has full key parity with en`, () => {
      const result = diff(en, dict)
      expect(result.missing).toEqual([])
      expect(result.extra).toEqual([])
    })
  }

  for (const [locale, dict] of Object.entries(ui)) {
    test(`ui/${locale} has full key parity with en`, () => {
      const result = diff(uiEn, dict)
      expect(result.missing).toEqual([])
      expect(result.extra).toEqual([])
    })
  }
})
