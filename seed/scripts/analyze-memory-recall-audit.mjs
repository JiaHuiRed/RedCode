#!/usr/bin/env node
// 260915 Red 把自动召回审计转成有标签回放指标，决策见：
// docs/notes/implemented/process/2026-09-15-memory-recall-replay.md
import { statSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const DEFAULT_AUDIT = join(homedir(), ".redcode", "data", "log", "memory-recall-audit.jsonl")
const MAX_INPUT_BYTES = positiveInt("MEMORY_RECALL_ANALYZE_MAX_BYTES", 16 * 1024 * 1024)
const args = process.argv.slice(2)
const auditPath = option("--audit") || DEFAULT_AUDIT
const labelsPath = option("--labels")

if (args.includes("--help")) {
  console.log(
    "用法：analyze-memory-recall-audit.mjs [--audit <audit.jsonl>] [--labels <labels.jsonl>]\n" +
      '标签行格式：{"message_id":"...","expected_ids":[1,2]}',
  )
  process.exit(0)
}

const audit = readJsonl(auditPath)
const injected = audit.flatMap((event) => event.injected_ids ?? [])
const tokens = audit.map((event) => Number(event.tokens) || 0)

console.log(`Audit events: ${audit.length}`)
console.log(`Injected events: ${audit.filter((event) => (event.injected_ids ?? []).length > 0).length}`)
console.log(`Injected memories: ${injected.length}`)
console.log(`Injected tokens: p50 ${percentile(tokens, 0.5)}, p95 ${percentile(tokens, 0.95)}`)

if (!labelsPath) {
  console.log("No labels supplied; precision and recall are intentionally not inferred.")
  process.exit(0)
}

const labels = readJsonl(labelsPath)
const events = new Map(audit.filter((event) => event.message_id).map((event) => [event.message_id, event]))
const labelled = labels.filter((label) => events.has(label.message_id))
const expected = labelled.flatMap((label) => label.expected_ids)
const matched = labelled.flatMap((label) => {
  const injected = new Set(events.get(label.message_id).injected_ids ?? [])
  return label.expected_ids.filter((id) => injected.has(id))
})
const predicted = labelled.flatMap((label) => events.get(label.message_id).injected_ids ?? [])
const noMemory = labelled.filter((label) => label.expected_ids.length === 0)
const falsePositives = noMemory.filter((label) => (events.get(label.message_id).injected_ids ?? []).length > 0)

console.log(`Labelled events: ${labelled.length}/${labels.length}`)
console.log(`Precision@injected: ${ratio(matched.length, predicted.length)} (${matched.length}/${predicted.length})`)
console.log(`Recall: ${ratio(matched.length, expected.length)} (${matched.length}/${expected.length})`)
console.log(
  `No-memory false-positive rate: ${ratio(falsePositives.length, noMemory.length)} (${falsePositives.length}/${noMemory.length})`,
)

function option(name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function positiveInt(name, fallback) {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function readJsonl(filepath) {
  const size = statSync(filepath).size
  if (size > MAX_INPUT_BYTES) {
    throw new Error(`${filepath} is ${size} bytes, over MEMORY_RECALL_ANALYZE_MAX_BYTES=${MAX_INPUT_BYTES}`)
  }
  return readFileSync(filepath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        const item = JSON.parse(line)
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
          throw new Error("must be an object")
        }
        if (!Array.isArray(item.injected_ids ?? item.expected_ids ?? [])) {
          throw new Error("memory ids must be an array")
        }
        return item
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`${filepath}:${index + 1}: ${message}`)
      }
    })
}

function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * p) - 1]
}

function ratio(numerator, denominator) {
  return denominator === 0 ? "n/a" : `${((numerator / denominator) * 100).toFixed(1)}%`
}
