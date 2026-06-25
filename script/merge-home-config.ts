#!/usr/bin/env bun
// 260625 Red  Merge repo template into user's home config (JSONC-aware).
// Template new keys are added; existing user keys are never overwritten.
// Called by sync-home.bat instead of a blind `copy /y`.

import { readFileSync, writeFileSync, existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"

const repoRoot = join(import.meta.dirname, "..")
const templatePath = join(repoRoot, ".opencode", "redcode.home.jsonc")
const homePath = join(homedir(), ".redcode", "redcode.jsonc")

// ---- JSONC strip (comments + trailing commas) --------------------------------

function stripJsonc(text: string): string {
  // Remove // line comments and /* block comments */, but not inside strings
  let result = ""
  let i = 0
  let inString = false
  let stringChar = ""

  while (i < text.length) {
    const ch = text[i]!
    const next = text[i + 1]

    if (inString) {
      result += ch
      if (ch === "\\" && i + 1 < text.length) {
        result += next
        i += 2
        continue
      }
      if (ch === stringChar) inString = false
      i++
      continue
    }

    if (ch === '"') {
      inString = true
      stringChar = ch
      result += ch
      i++
      continue
    }

    if (ch === "/" && next === "/") {
      // skip to end of line
      i += 2
      while (i < text.length && text[i] !== "\n") i++
      continue
    }

    if (ch === "/" && next === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i += 2 // skip */
      continue
    }

    result += ch
    i++
  }

  // Remove trailing commas before } or ]
  result = result.replace(/,(\s*[}\]])/g, "$1")
  return result
}

function parseJsonc(text: string): Record<string, unknown> {
  return JSON.parse(stripJsonc(text))
}

// ---- Deep merge (user wins on conflict) --------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function deepMergeUserWins(
  user: Record<string, unknown>,
  template: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...user }
  for (const key of Object.keys(template)) {
    if (!(key in merged)) {
      // New key from template — add it
      merged[key] = template[key]
    } else if (isPlainObject(merged[key]) && isPlainObject(template[key])) {
      // Both objects — recurse
      merged[key] = deepMergeUserWins(
        merged[key] as Record<string, unknown>,
        template[key] as Record<string, unknown>,
      )
    }
    // else: user value wins, keep as-is
  }
  return merged
}

// ---- Main --------------------------------------------------------------------

if (!existsSync(templatePath)) {
  // No template — nothing to do
  process.exit(0)
}

if (!existsSync(homePath)) {
  // First install — just copy
  const content = readFileSync(templatePath, "utf-8")
  writeFileSync(homePath, content, "utf-8")
  console.log("[merge-config] seeded", homePath)
  process.exit(0)
}

const template = parseJsonc(readFileSync(templatePath, "utf-8"))
const user = parseJsonc(readFileSync(homePath, "utf-8"))

const merged = deepMergeUserWins(user, template)

// Only write if something actually changed
const userJson = JSON.stringify(user)
const mergedJson = JSON.stringify(merged)

if (userJson === mergedJson) {
  console.log("[merge-config] no changes needed")
  process.exit(0)
}

writeFileSync(homePath, JSON.stringify(merged, null, 2) + "\n", "utf-8")
console.log("[merge-config] merged template into", homePath)
