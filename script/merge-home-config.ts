#!/usr/bin/env bun
// 260625 Red  Merge repo template into user's home config (JSONC-aware).
// Template new keys are added; existing user keys are never overwritten.
// Comments and formatting in the user's file are preserved.
// Called by sync-home.bat instead of a blind `copy /y`.

import { readFileSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const repoRoot = join(import.meta.dirname, "..")
// 260805 模板目录 .opencode -> seed（它从来不是项目配置，引擎只扫 .redcode）
const templatePath = join(repoRoot, "seed", "redcode.home.jsonc")
const homePath = join(homedir(), ".redcode", "redcode.jsonc")
// 260812 cc 本地层（机器覆盖层，私仓 gitignore）。引擎按 config.ts:489-490 的顺序加载这两个
// 文件，本脚本只关心"键在不在"，用来遮蔽模板：见 deepMergeUserWins 的第三参数。
const localPaths = [
  join(homedir(), ".redcode", "redcode.local.json"),
  join(homedir(), ".redcode", "redcode.local.jsonc"),
]

// ---- JSONC strip (comments + trailing commas) --------------------------------

function stripJsonc(text: string): string {
  let result = ""
  let i = 0
  let inString = false
  let stringChar = ""
  while (i < text.length) {
    const ch = text[i]!
    const next = text[i + 1]
    if (inString) {
      result += ch
      if (ch === "\\" && i + 1 < text.length) { result += next; i += 2; continue }
      if (ch === stringChar) inString = false
      i++
      continue
    }
    if (ch === '"') { inString = true; stringChar = ch; result += ch; i++; continue }
    if (ch === "/" && next === "/") { i += 2; while (i < text.length && text[i] !== "\n") i++; continue }
    if (ch === "/" && next === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; continue }
    result += ch
    i++
  }
  return result.replace(/,(\s*[}\]])/g, "$1")
}

function parseJsonc(text: string): Record<string, unknown> {
  return JSON.parse(stripJsonc(text))
}

// ---- Deep merge (user wins on conflict) --------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

// 260812 cc `local` 是本地层遮蔽：本地层里已有的键，视同"用户已经有了"，模板不得再把它
// 补回同步文件 redcode.jsonc。没有这一层，任何**下沉到本地层**的键都会在下一次
// sync-home 时被下面"用户没有的键就加"的逻辑复活——键从 redcode.jsonc 移走后就变成
// "用户没有"，模板于是补回，看起来就像"本地层被提升进同步层"。provider.ollama 与
// small_model 260811/260812 两次回潮都是这么来的；同一根因 260713 的 FreeLLMAPI 已经栽过
// 一次（见 CHANGELOG）。整棵子树归本地层所有，模板也不再往里滴新子键。
function deepMergeUserWins(
  user: Record<string, unknown>,
  template: Record<string, unknown>,
  local: Record<string, unknown> = {},
): Record<string, unknown> {
  const merged = { ...user }
  for (const key of Object.keys(template)) {
    if (!(key in merged)) {
      if (key in local) continue
      merged[key] = template[key]
    } else if (isPlainObject(merged[key]) && isPlainObject(template[key])) {
      merged[key] = deepMergeUserWins(
        merged[key] as Record<string, unknown>,
        template[key] as Record<string, unknown>,
        isPlainObject(local[key]) ? (local[key] as Record<string, unknown>) : {},
      )
    }
  }
  return merged
}

// 读出本地层的键形状用于遮蔽。只取并集，值无所谓——判断只看 `key in local`。
function readLocalShadow(): Record<string, unknown> {
  let shadow: Record<string, unknown> = {}
  for (const file of localPaths) {
    if (!existsSync(file)) continue
    try {
      shadow = deepMergeUserWins(shadow, parseJsonc(readFileSync(file, "utf-8")))
    } catch (err) {
      // 本地层语法坏了不该阻断同步，但必须喊出来：静默退回空遮蔽 = 悄悄恢复回潮 bug。
      console.warn(`[merge-config] 本地层解析失败，本轮不做遮蔽: ${file}`, err instanceof Error ? err.message : err)
    }
  }
  return shadow
}

// ---- JSONC-aware patching (insert new keys without stripping comments) --------

// 260625 Red Skip whitespace and JSONC comments, return next meaningful position
function skipTrivia(text: string, pos: number): number {
  while (pos < text.length) {
    if (/\s/.test(text[pos]!)) { pos++; continue }
    if (text[pos] === "/" && text[pos + 1] === "/") {
      pos += 2
      while (pos < text.length && text[pos] !== "\n") pos++
      continue
    }
    if (text[pos] === "/" && text[pos + 1] === "*") {
      pos += 2
      while (pos < text.length && !(text[pos] === "*" && text[pos + 1] === "/")) pos++
      pos += 2
      continue
    }
    break
  }
  return pos
}

// Find matching } or ] for { or [ at pos (JSONC-aware)
function findClose(text: string, pos: number): number {
  const open = text[pos]!
  const close = open === "{" ? "}" : "]"
  let depth = 0
  let i = pos
  let inStr = false
  while (i < text.length) {
    const ch = text[i]!
    if (inStr) {
      if (ch === "\\" && i + 1 < text.length) { i += 2; continue }
      if (ch === '"') inStr = false
      i++
      continue
    }
    if (ch === '"') { inStr = true; i++; continue }
    if (ch === "/" && text[i + 1] === "/") { i += 2; while (i < text.length && text[i] !== "\n") i++; continue }
    if (ch === "/" && text[i + 1] === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; continue }
    if (ch === open) depth++
    if (ch === close) { depth--; if (depth === 0) return i }
    i++
  }
  return -1
}

// Skip a JSON value at pos, return position after it
function skipVal(text: string, pos: number): number {
  const ch = text[pos]!
  if (ch === "{" || ch === "[") return findClose(text, pos) + 1
  if (ch === '"') {
    let i = pos + 1
    while (i < text.length) {
      if (text[i] === "\\" && i + 1 < text.length) { i += 2; continue }
      if (text[i] === '"') return i + 1
      i++
    }
    return i
  }
  // number, bool, null
  let i = pos
  while (i < text.length && /[^\s,}\]]/.test(text[i]!)) i++
  return i
}

// In object at objPos ({), find value start position for targetKey
function findKeyPos(text: string, objPos: number, targetKey: string): number | null {
  let i = skipTrivia(text, objPos + 1)
  while (i < text.length && text[i] !== "}") {
    if (text[i] === ",") { i = skipTrivia(text, i + 1); continue }
    if (text[i] !== '"') return null
    // Read key
    let key = ""
    let j = i + 1
    while (j < text.length && text[j] !== '"') {
      if (text[j] === "\\") { key += text.slice(j, j + 2); j += 2; continue }
      key += text[j]!
      j++
    }
    j = skipTrivia(text, j + 1) // past closing " to :
    if (text[j] !== ":") return null
    j = skipTrivia(text, j + 1) // past : to value start
    if (key === targetKey) return j
    i = skipTrivia(text, skipVal(text, j))
  }
  return null
}

// Navigate to object at key path, return its { position
function navigateTo(text: string, path: string[]): number {
  let pos = skipTrivia(text, 0)
  for (const key of path) {
    const vp = findKeyPos(text, pos, key)
    if (vp === null || text[vp] !== "{") return -1
    pos = vp
  }
  return pos
}

// Find last entry's end position and trailing-comma status in object
function lastEntryInfo(
  text: string,
  objPos: number,
  closePos: number,
): { end: number; hasComma: boolean } | null {
  let lastEnd = -1
  let comma = false
  let i = skipTrivia(text, objPos + 1)
  while (i < closePos && text[i] !== "}") {
    if (text[i] === ",") { comma = true; i = skipTrivia(text, i + 1); continue }
    if (text[i] !== '"') break
    comma = false
    // Skip key
    let j = i + 1
    while (j < text.length && text[j] !== '"') { if (text[j] === "\\") j++; j++ }
    j = skipTrivia(text, j + 1)
    if (text[j] !== ":") break
    j = skipTrivia(text, j + 1)
    j = skipVal(text, j)
    lastEnd = j
    i = skipTrivia(text, j)
  }
  return lastEnd < 0 ? null : { end: lastEnd, hasComma: comma }
}

// Insert "key": value into object at objPos, before its closing }
function insertEntry(text: string, objPos: number, key: string, value: unknown): string {
  const closePos = findClose(text, objPos)
  if (closePos < 0) return text

  // Detect indent from closing brace line
  let cl = closePos
  while (cl > 0 && text[cl - 1] !== "\n") cl--
  const braceIndent = (text.slice(cl, closePos).match(/^(\s*)/) ?? ["", ""])[1]!
  const indent = braceIndent + "  "

  // Serialize value with proper indentation
  const ser = JSON.stringify(value, null, 2)
    .split("\n")
    .map((l, i) => (i === 0 ? l : indent + l))
    .join("\n")
  const entry = indent + JSON.stringify(key) + ": " + ser + "\n"

  // Empty object?
  if (text[skipTrivia(text, objPos + 1)] === "}") {
    return text.slice(0, objPos + 1) + "\n" + entry + braceIndent + text.slice(closePos)
  }

  const info = lastEntryInfo(text, objPos, closePos)
  if (!info) return text

  // 260708 Red single-line object ({ ... } all on one line): `cl` (start of the
  // closing brace's line) sits BEFORE the last value, so the multi-line math below
  // produces text.slice(info.end, cl) === "" and text.slice(cl) re-duplicates the
  // whole line while dropping the closing brace — corrupting the file. Insert the
  // new entry inline right after the last value instead.
  if (!text.slice(info.end, closePos).includes("\n")) {
    const inline = JSON.stringify(key) + ": " + JSON.stringify(value)
    if (info.hasComma) {
      let c = info.end
      while (c < closePos && text[c] !== ",") c++
      return text.slice(0, c + 1) + " " + inline + "," + text.slice(c + 1)
    }
    return text.slice(0, info.end) + ", " + inline + text.slice(info.end)
  }

  if (info.hasComma) {
    // Trailing comma exists — just insert entry before } line
    return text.slice(0, cl) + entry + text.slice(cl)
  }
  // No trailing comma — add comma after last value, then insert entry
  return text.slice(0, info.end) + "," + text.slice(info.end, cl) + entry + text.slice(cl)
}

// Recursively patch new keys from merged into raw JSONC text
function patchNewKeys(
  text: string,
  user: Record<string, unknown>,
  merged: Record<string, unknown>,
  path: string[] = [],
): string {
  for (const key of Object.keys(merged)) {
    if (!(key in user)) {
      const objPos = path.length === 0 ? skipTrivia(text, 0) : navigateTo(text, path)
      if (objPos >= 0) text = insertEntry(text, objPos, key, merged[key])
    } else if (isPlainObject(user[key]) && isPlainObject(merged[key])) {
      text = patchNewKeys(
        text,
        user[key] as Record<string, unknown>,
        merged[key] as Record<string, unknown>,
        [...path, key],
      )
    }
  }
  return text
}

// ---- Main --------------------------------------------------------------------

if (!existsSync(templatePath)) process.exit(0)

if (!existsSync(homePath)) {
  writeFileSync(homePath, readFileSync(templatePath, "utf-8"), "utf-8")
  console.log("[merge-config] seeded", homePath)
  process.exit(0)
}

const rawUser = readFileSync(homePath, "utf-8")
const template = parseJsonc(readFileSync(templatePath, "utf-8"))
const user = parseJsonc(rawUser)
const merged = deepMergeUserWins(user, template, readLocalShadow())

if (JSON.stringify(user) === JSON.stringify(merged)) {
  console.log("[merge-config] no changes needed")
  process.exit(0)
}

// 260625 Red Patch new keys into raw JSONC (preserves comments + formatting)
const patched = patchNewKeys(rawUser, user, merged)
writeFileSync(homePath, patched, "utf-8")
console.log("[merge-config] merged template into", homePath)
