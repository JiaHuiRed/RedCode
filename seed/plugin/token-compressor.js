// Token Compressor Plugin v1.0.0
// 260612 Red rewrite — port of openhuman/tokenjuice compaction logic to RedCode plugin.
// ONLY uses tool.execute.after hook (safe). No message transforms, no nudges.
// Pass-through safe: skips protected tools, small outputs, and low-ratio compactions.

import { readFileSync, existsSync } from "fs"
import { join } from "path"
import os from "node:os"

// ── constants ──────────────────────────────────────────────────────────
const MIN_COMPACT_BYTES = 512
const MIN_COMPACT_RATIO = 0.95
const STRIP_ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g

// Protected tools — output is never compacted
const PROTECTED = new Set([
  "skill", "read", "write", "edit", "task",
  "todowrite", "todoread", "glob", "grep", "websearch", "webfetch",
])

// ── builtin rules (ported from tokenjuice vendor/rules/) ───────────────
// Each rule: { id, match:{command,argv0,argvIncludes}, skip[], keep[], head, tail, failHead, failTail, counters[], onEmpty }
const RULES = [
  {
    id: "git/status",
    match: { argv0: "git", argvIncludes: "status" },
    skip: [
      /^On branch /,
      /^Your branch is /,
      /^\(use "git .+" to .+\)$/,
      /^no changes added to commit/,
      /^nothing added to commit/,
      /^nothing to commit/,
    ],
    head: 10, tail: 4,
    counters: [
      { name: "modified", pattern: /^\s*modified:|^[MTRU ][MTRU]\s+/i },
      { name: "new file", pattern: /^\s*new file:|^A.\s+/i },
      { name: "deleted", pattern: /^\s*deleted:|^D.\s+/i },
      { name: "untracked", pattern: /^\?\?\s+/ },
    ],
  },
  {
    id: "git/log-oneline",
    match: { argv0: "git", argvIncludes: "log" },
    head: 10, tail: 4,
  },
  {
    id: "git/diff-stat",
    match: { argv0: "git", argvIncludes: "diff" },
    head: 20, tail: 10,
    failHead: 30, failTail: 20,
    counters: [
      { name: "file changed", pattern: /^diff --git/ },
      { name: "addition", pattern: /^\+[^+]/ },
      { name: "deletion", pattern: /^-[^-]/ },
    ],
  },
  {
    id: "git/show",
    match: { argv0: "git", argvIncludes: "show" },
    head: 20, tail: 10,
  },
  {
    id: "build/cargo",
    match: { argv0: "cargo", argvIncludesAny: ["build", "check"] },
    skip: [
      /^\s*Compiling /,
      /^\s*Checking /,
      /^\s*Downloading /,
      /^\s*Downloaded /,
      /^\s*Fresh /,
      /^\s*Locking /,
    ],
    head: 12, tail: 8, failHead: 16, failTail: 16,
    onEmpty: "cargo: build succeeded",
    counters: [
      { name: "error", pattern: /^error/i },
      { name: "warning", pattern: /^warning/i },
    ],
  },
  {
    id: "build/cargo-test",
    match: { argv0: "cargo", argvIncludes: "test" },
    skip: [/^\s*running \d+ tests?$/, /^\s*Compiling /, /^\s*Finished /],
    head: 12, tail: 12, failHead: 20, failTail: 20,
    counters: [
      { name: "passed", pattern: /\.\.\. ok$/i },
      { name: "FAILED", pattern: /\.\.\. FAILED$/i },
    ],
  },
  {
    id: "build/tsc",
    match: { argv0: "tsc" },
    skip: [/^\s*$/],
    head: 12, tail: 8,
    counters: [
      { name: "error", pattern: /error TS\d+/i },
    ],
  },
  {
    id: "build/npm-install",
    match: { argv0: "npm", argvIncludesAny: ["install", "update", "ci"] },
    skip: [/^npm warn /, /^added \d+ packages/],
    head: 8, tail: 4,
    onEmpty: "npm: install succeeded",
  },
  {
    id: "build/bun-install",
    match: { argv0: "bun", argvIncludes: "install" },
    head: 8, tail: 4,
    onEmpty: "bun: install succeeded",
  },
  {
    id: "docker/ps",
    match: { argv0: "docker", argvIncludes: "ps" },
    head: 15, tail: 5,
  },
  {
    id: "filesystem/find",
    match: { argv0: "find" },
    head: 8, tail: 6,
    counters: [{ name: "match", pattern: /^(?!find: ).+\S.*$/ }],
  },
  {
    id: "filesystem/ls",
    match: { argv0: "ls" },
    head: 30, tail: 10,
  },
  {
    id: "search/grep",
    match: { argv0AnyOf: ["grep", "rg"] },
    head: 30, tail: 10,
    counters: [{ name: "match", pattern: /^.+$/ }],
  },
  // generic fallback — always last
  {
    id: "generic/fallback",
    match: {},
    head: 8, tail: 8, failHead: 12, failTail: 20,
    counters: [
      { name: "error", pattern: /error/i },
      { name: "warning", pattern: /warning/i },
    ],
  },
]

// ── rule matching ──────────────────────────────────────────────────────
function extractCommandArgv(args) {
  const command = typeof args?.command === "string" ? args.command : ""
  if (!command) return { command: "", argv: [] }
  const argv = command.split(/\s+/).filter(Boolean)
  return { command, argv }
}

function matchRule(toolName, command, argv) {
  for (const rule of RULES) {
    const m = rule.match
    if (!m || Object.keys(m).length === 0) {
      if (rule.id === "generic/fallback") continue // fallback handled separately
      return rule
    }
    const a0 = argv[0] || ""
    if (m.argv0 && a0 !== m.argv0) continue
    if (m.argv0AnyOf && !m.argv0AnyOf.includes(a0)) continue
    if (m.argvIncludes && !argv.includes(m.argvIncludes)) continue
    if (m.argvIncludesAny && !m.argvIncludesAny.some(k => argv.includes(k))) continue
    return rule
  }
  return RULES[RULES.length - 1] // generic/fallback
}

// ── compaction pipeline ────────────────────────────────────────────────
function stripAnsi(text) {
  return text.replace(STRIP_ANSI_RE, "")
}

function dedupeAdjacent(lines) {
  return lines.filter((line, i) => i === 0 || line !== lines[i - 1])
}

function trimEmptyEdges(lines) {
  let start = 0, end = lines.length - 1
  while (start <= end && !lines[start].trim()) start++
  while (end >= start && !lines[end].trim()) end--
  return lines.slice(start, end + 1)
}

function headTail(lines, head, tail) {
  if (lines.length <= head + tail) return { result: lines, omitted: 0 }
  const omitted = lines.length - head - tail
  return {
    result: [
      ...lines.slice(0, head),
      `... (${omitted} lines omitted)`,
      ...lines.slice(-tail),
    ],
    omitted,
  }
}

function runCounters(lines, counters) {
  if (!counters?.length) return ""
  const counts = counters.map(c => ({ name: c.name, count: 0 }))
  for (const line of lines) {
    for (let i = 0; i < counters.length; i++) {
      if (counters[i].pattern.test(line)) counts[i].count++
    }
  }
  const parts = counts.filter(c => c.count > 0).map(c => `${c.count} ${c.name}${c.count > 1 ? "s" : ""}`)
  return parts.length ? ` [${parts.join(", ")}]` : ""
}

function compact(output, rule, exitCode) {
  let text = stripAnsi(output)
  let lines = text.split("\n")

  // apply filters
  if (rule.skip) lines = lines.filter(l => !rule.skip.some(p => p.test(l)))
  if (rule.keep) lines = lines.filter(l => rule.keep.some(p => p.test(l)))

  lines = dedupeAdjacent(lines)
  lines = trimEmptyEdges(lines)

  // empty after filtering?
  if (lines.length === 0 && rule.onEmpty) return rule.onEmpty

  // head/tail
  const isFail = exitCode && exitCode !== 0
  const h = isFail && rule.failHead ? rule.failHead : rule.head
  const t = isFail && rule.failTail ? rule.failTail : rule.tail
  const originalLen = lines.length
  const { result, omitted } = headTail(lines, h, t)

  // counters
  const counterSuffix = runCounters(lines, rule.counters)

  const compacted = result.join("\n")
  const header = omitted > 0 ? `[${rule.id}] ${originalLen} lines${counterSuffix}\n` : ""
  return header + compacted
}

// ── plugin export ──────────────────────────────────────────────────────
export default {
  id: "token-compressor",
  server: async (_input) => ({
    "tool.execute.after": async (input, output) => {
      const toolName = input.tool || ""
      if (PROTECTED.has(toolName)) return
      if (!output.output || typeof output.output !== "string") return
      if (output.output.length < MIN_COMPACT_BYTES) return

      const { command, argv } = extractCommandArgv(input.args)
      // only compact shell/bash tool output (not domain tools without commands)
      if (toolName !== "bash" && toolName !== "shell" && !command) return

      const rule = matchRule(toolName, command, argv)
      const compacted = compact(output.output, rule, 0)

      // pass-through safety: only apply if meaningfully smaller
      if (compacted.length >= output.output.length * MIN_COMPACT_RATIO) return

      output.output = compacted
    },
  }),
}
