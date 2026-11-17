import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT = fileURLToPath(new URL("../../../../seed/scripts/analyze-memory-recall-audit.mjs", import.meta.url))

test("reports recall precision, recall, and no-memory false positives from labels", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "memory-recall-audit-"))
  const audit = path.join(dir, "audit.jsonl")
  const labels = path.join(dir, "labels.jsonl")
  writeFileSync(
    audit,
    [
      JSON.stringify({ injected_ids: [1, 2], message_id: "m1", tokens: 120 }),
      JSON.stringify({ injected_ids: [3], message_id: "m2", tokens: 80 }),
      JSON.stringify({ injected_ids: [], message_id: "m3", tokens: 0 }),
    ].join("\n") + "\n",
  )
  writeFileSync(
    labels,
    [
      JSON.stringify({ expected_ids: [1], message_id: "m1" }),
      JSON.stringify({ expected_ids: [], message_id: "m2" }),
      JSON.stringify({ expected_ids: [4], message_id: "m3" }),
    ].join("\n") + "\n",
  )

  const proc = Bun.spawnSync(["bun", SCRIPT, "--audit", audit, "--labels", labels], {
    stderr: "pipe",
    stdout: "pipe",
  })
  const output = new TextDecoder().decode(proc.stdout)

  expect(proc.exitCode).toBe(0)
  expect(output).toContain("Precision@injected: 33.3% (1/3)")
  expect(output).toContain("Recall: 50.0% (1/2)")
  expect(output).toContain("No-memory false-positive rate: 100.0% (1/1)")
})

test("aggregates audit events by message before coverage and label scoring", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "memory-recall-audit-"))
  const audit = path.join(dir, "audit.jsonl")
  const labels = path.join(dir, "labels.jsonl")
  writeFileSync(
    audit,
    [
      JSON.stringify({ type: "recall-skip", message_id: "m1" }),
      JSON.stringify({ type: "recall-miss", message_id: "m2" }),
      JSON.stringify({ type: "drift", message_id: "m3" }),
      JSON.stringify({ injected_ids: [1, 2], message_id: "m1", tokens: 120 }),
      JSON.stringify({ injected_ids: [2, 3], message_id: "m1", tokens: 80 }),
      JSON.stringify({ type: "recall-skip", message_id: "m1" }),
      JSON.stringify({ injected_ids: [4], message_id: "m2", tokens: 40 }),
      JSON.stringify({ type: "recall-miss", message_id: "m3" }),
      JSON.stringify({ injected_ids: [5], tokens: 20 }),
    ].join("\n") + "\n",
  )
  writeFileSync(
    labels,
    [
      JSON.stringify({ expected_ids: [1, 2, 3], message_id: "m1" }),
      JSON.stringify({ expected_ids: [4], message_id: "m2" }),
      JSON.stringify({ expected_ids: [6], message_id: "m3" }),
    ].join("\n") + "\n",
  )

  const proc = Bun.spawnSync(["bun", SCRIPT, "--audit", audit, "--labels", labels], {
    stderr: "pipe",
    stdout: "pipe",
  })
  const output = new TextDecoder().decode(proc.stdout)

  expect(proc.exitCode).toBe(0)
  expect(output).toContain("Audit events: 9 (recall 4, miss 2, skip 2, drift 1)")
  expect(output).toContain("Injected memories: 6")
  expect(output).toContain("Turn coverage: 75.0% (injected / injected+miss+skip)")
  expect(output).toContain("Labelled events: 3/3")
  expect(output).toContain("Precision@injected: 100.0% (4/4)")
  expect(output).toContain("Recall: 80.0% (4/5)")
})
