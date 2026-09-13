#!/usr/bin/env bun
// 260625 Red  Merge repo template into user's home config (JSONC-aware).
// Template new keys are added; existing user keys are never overwritten.
// Comments and formatting in the user's file are preserved.
// Called by sync-home.bat instead of a blind `copy /y`.
//
// 260913 Red 改用 jsonc-parser 的语法树编辑。此前是手写扫描器：单行对象带尾逗号时
// 它用 `text[c] !== ","` 线性找逗号，不跳块注释——新键会被插进 /* ... */ 里面，
// 日志还照样报"已合并"。语法树编辑从根上消除这类缺陷，写盘前再重新解析校验。
// 决策记录：docs/notes/implemented/bug-fix/2026-09-13-jsonc-ast-merge.md

import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { isDeepStrictEqual } from "util"
import { applyEdits, getNodeValue, modify, parseTree, printParseErrorCode, type ParseError } from "jsonc-parser"
import { writeAtomic } from "./home-files"

const repoRoot = join(import.meta.dirname, "..")
// 260805 模板目录 .opencode -> seed（它从来不是项目配置，引擎只扫 .redcode）
const templatePath = join(repoRoot, "seed", "redcode.home.jsonc")
const homePath = join(homedir(), ".redcode", "redcode.jsonc")

// 260812 cc 本地层（机器覆盖层，私仓 gitignore）。引擎按 config.ts:489-490 的顺序加载这两个
// 文件，本脚本只关心"键在不在"，用来遮蔽模板：见 mergeUserWins 的第三参数。
const localPaths = [
  join(homedir(), ".redcode", "redcode.local.json"),
  join(homedir(), ".redcode", "redcode.local.jsonc"),
]

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseConfig(text: string, source = "config"): Record<string, unknown> {
  const errors: ParseError[] = []
  const tree = parseTree(text, errors, { allowTrailingComma: true })
  if (errors.length) {
    throw new Error(
      `${source}: ${errors.map((error) => `${printParseErrorCode(error.error)} at ${error.offset}`).join(", ")}`,
    )
  }
  if (!tree || tree.type !== "object") throw new Error(`${source}: expected a JSON object`)
  return JSON.parse(JSON.stringify(getNodeValue(tree))) as Record<string, unknown>
}

// 260812 cc `local` 是本地层遮蔽：本地层里已有的键，视同"用户已经有了"，模板不得再把它
// 补回同步文件 redcode.jsonc。没有这一层，任何**下沉到本地层**的键都会在下一次
// sync-home 时被下面"用户没有的键就加"的逻辑复活。provider.ollama 与 small_model
// 260811/260812 两次回潮都是这么来的；同一根因 260713 的 FreeLLMAPI 已经栽过一次（见 CHANGELOG）。
export function mergeUserWins(
  user: Record<string, unknown>,
  template: Record<string, unknown>,
  local: Record<string, unknown> = {},
): Record<string, unknown> {
  const merged = { ...user }
  for (const key of Object.keys(template)) {
    if (!Object.hasOwn(merged, key)) {
      if (Object.hasOwn(local, key)) continue
      merged[key] = template[key]
      continue
    }
    if (isObject(merged[key]) && isObject(template[key])) {
      merged[key] = mergeUserWins(
        merged[key] as Record<string, unknown>,
        template[key] as Record<string, unknown>,
        isObject(local[key]) ? (local[key] as Record<string, unknown>) : {},
      )
    }
  }
  return merged
}

// 260913 Red 只补缺失键，其余文本（注释、排版、既有值）交给 jsonc-parser 原样保留。
function patchMissing(
  text: string,
  user: Record<string, unknown>,
  merged: Record<string, unknown>,
  keys: string[] = [],
): string {
  for (const key of Object.keys(merged)) {
    if (!Object.hasOwn(user, key)) {
      text = applyEdits(
        text,
        modify(text, [...keys, key], merged[key], {
          formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" },
        }),
      )
      continue
    }
    if (isObject(user[key]) && isObject(merged[key])) text = patchMissing(text, user[key], merged[key], [...keys, key])
  }
  return text
}

// 读出本地层的键形状用于遮蔽。只取并集，值无所谓——判断只看键在不在。
function readLocalShadow(): Record<string, unknown> {
  let shadow: Record<string, unknown> = {}
  for (const file of localPaths) {
    if (!existsSync(file)) continue
    try {
      shadow = mergeUserWins(shadow, parseConfig(readFileSync(file, "utf-8"), "local config"))
    } catch (err) {
      // 260812 cc 本地层语法坏了不该阻断同步，但必须喊出来：静默退回空遮蔽 = 悄悄恢复回潮 bug。
      console.warn(`[merge-config] 本地层解析失败，本轮不做遮蔽: ${file}`, err instanceof Error ? err.message : err)
    }
  }
  return shadow
}

export function mergeConfigText(raw: string, templateText: string, local: Record<string, unknown> = {}) {
  const user = parseConfig(raw, "user config")
  const template = parseConfig(templateText, "template")
  const merged = mergeUserWins(user, template, local)
  const patched = patchMissing(raw, user, merged)
  // 260913 Red 写盘前重新解析校验：语法树编辑一旦走偏，宁可报错退出也不能写坏用户配置。
  if (!isDeepStrictEqual(parseConfig(patched, "merged config"), merged)) {
    throw new Error("merged JSONC did not retain all values; original config was not changed")
  }
  return patched
}

if (import.meta.main) {
  if (!existsSync(templatePath)) process.exit(0)

  const templateText = readFileSync(templatePath, "utf-8")
  const local = readLocalShadow()
  const seeded = !existsSync(homePath)
  const raw = seeded ? "{}\n" : readFileSync(homePath, "utf-8")

  const patched = mergeConfigText(raw, templateText, local)
  if (!seeded && patched === raw) {
    console.log("[merge-config] no changes needed")
    process.exit(0)
  }
  // 260913 Red 没有本地遮蔽的首次播种保留模板里的说明注释。
  await writeAtomic(homePath, seeded && Object.keys(local).length === 0 ? templateText : patched)
  console.log(seeded ? "[merge-config] seeded" : "[merge-config] merged template into", homePath)
}
