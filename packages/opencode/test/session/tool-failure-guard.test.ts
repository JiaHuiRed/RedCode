import { expect, test } from "bun:test"
import { Schema } from "effect"
import * as ConfigToolFailure from "@/config/tool-failure"
import * as ToolFailureGuard from "@/session/tool-failure-guard"

test("failure budget rejects invalid configuration instead of silently defaulting", () => {
  expect(ConfigToolFailure.resolve()).toBe(2)
  expect(ConfigToolFailure.resolve(3)).toBe(3)
  for (const invalid of [0, -1, 21, 1.5]) {
    expect(() => ConfigToolFailure.resolve(invalid)).toThrow()
  }
  expect(Schema.decodeUnknownSync(ConfigToolFailure.Limit)(20)).toBe(20)
})

test("failure fingerprints ignore object key order without merging tools or array order", () => {
  const first = ToolFailureGuard.inputSignature("task_status", { wait: false, nested: { b: 2, a: 1 } })
  expect(first).toBe(ToolFailureGuard.inputSignature("task_status", { nested: { a: 1, b: 2 }, wait: false }))
  expect(first).not.toBe(ToolFailureGuard.inputSignature("another_tool", { wait: false, nested: { a: 1, b: 2 } }))
  expect(ToolFailureGuard.inputSignature("x", [1, 2])).not.toBe(ToolFailureGuard.inputSignature("x", [2, 1]))
  expect(first).toHaveLength(64)
})

test("failure notice has a fixed byte bound independent of tool arguments", () => {
  expect(Buffer.byteLength(ToolFailureGuard.reminder(20), "utf8")).toBeLessThan(1024)
})
