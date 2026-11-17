/**
 * 已退役配置键的登记表与迁移（261021 第三方审计 RC21-01）。
 *
 * 260821 那次只解决了「报错要说人话」（见 parse.ts:41）；配置退役本身仍靠人手删。结果是
 * 升级到移除某键的版本时，旧配置让 server 直接起不来：`ConfigInvalidError: Unrecognized key:
 * image` 同时打死 config.providers / provider.list / app.agents / config.get 四个启动请求，
 * TUI 走致命退出。审计要求的是「显式、可重复执行的迁移，覆盖引擎真正读取的每一层配置」，
 * 而不是把未知键一律静默丢掉 —— 未登记的键继续由 parse.ts 明确报错。
 *
 * 加一项的前提：该键已经从 Config.Info schema 里移除，且没有任何代码再读它。
 * 决策与验收见 docs/notes/implemented/bug-fix/2026-10-21-config-retired-migration.md。
 */
export * as ConfigRetire from "./retire"

import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"

export const RETIRED = [{ key: "image", since: "0.12.17", reason: "生图工具已移除，字段不再被任何代码读取" }] as const

/** 配置数据里实际出现的退役键。只认顶层 —— schema 的未知键检查也只覆盖顶层。 */
export function present(data: unknown): string[] {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return []
  return RETIRED.filter((item) => Object.hasOwn(data, item.key)).map((item) => item.key)
}

/**
 * 内存剥离：远程配置、REDCODE_CONFIG_CONTENT、以及写盘失败的本地文件都只能走这条。
 * 返回新对象，不改传入的那个（调用方手里的 parsed 可能还要用于日志）。
 */
export function strip(data: unknown): { data: unknown; removed: string[] } {
  const removed = present(data)
  if (!removed.length) return { data, removed }
  const next = { ...(data as Record<string, unknown>) }
  for (const key of removed) delete next[key]
  return { data: next, removed }
}

/** 诊断用：文本里还有哪些退役键。语法坏掉的文本返回空 —— 那该由 ConfigParse.jsonc 定位。 */
export function scanText(text: string): string[] {
  const errors: ParseError[] = []
  const data = parse(text, errors, { allowTrailingComma: true })
  if (errors.length) return []
  return present(data)
}

/**
 * 文件迁移：用 jsonc-edit 精确删键，注释与其余格式保持原样（不用 parse 后重新 print）。
 * 重复执行时已经没有可删的键，结果不再变化。
 */
export function migrateText(text: string): { text: string; removed: string[] } {
  const errors: ParseError[] = []
  const data = parse(text, errors, { allowTrailingComma: true })
  if (errors.length) return { text, removed: [] }
  const removed = present(data)
  if (!removed.length) return { text, removed }
  const next = removed.reduce(
    (current, key) =>
      applyEdits(current, modify(current, [key], undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } })),
    text,
  )
  return { text: next, removed }
}

/** 迁移日志与 doctor 展示用：键名 + 退役版本 + 原因，不含任何配置值。 */
export function describe(keys: string[]) {
  return keys
    .map((key) => {
      const item = RETIRED.find((entry) => entry.key === key)
      return item ? `${key} (retired ${item.since}: ${item.reason})` : key
    })
    .join(", ")
}
