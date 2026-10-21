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

// 261021 Red 核心签名：同工具同错误文本即同链，参数无关字段抖动不再重开失败预算。
// 场景还原（redmind ses_ffe5ea…）：read 同一不存在文件连错 10 次，content 参数在
// 缺省→整段正文→"x" 之间抖动，精确 inputSignature 每换一次就重新计数，防线被绕过。
test("core signature follows the error text, ignoring argument-level jitter", () => {
  const error = "File not found: D:\\proj\\.redcode\\temp\\commit-msg.txt"
  const jittered = [
    { filePath: "D:\\proj\\.redcode\\temp\\commit-msg.txt" },
    { filePath: "D:\\proj\\.redcode\\temp\\commit-msg.txt", content: "[Wonyoung] feat: body" },
    { filePath: "D:\\proj\\.redcode\\temp\\commit-msg.txt", content: "x" },
  ]
  const signatures = jittered.map((input) => ToolFailureGuard.coreSignature("read", error))
  expect(new Set(signatures).size).toBe(1)
  expect(signatures[0]).not.toBe(ToolFailureGuard.coreSignature("read", "File not found: other.txt"))
  expect(signatures[0]).not.toBe(ToolFailureGuard.coreSignature("bash", error))
  expect(signatures[0]).toHaveLength(64)
})

// 精确签名维度保留：参数实质不同的失败不该被核心签名误并（换目标文件的自救仍算新链）
test("input signature still separates genuinely different arguments", () => {
  const first = ToolFailureGuard.inputSignature("read", { filePath: "a.txt" })
  expect(first).not.toBe(ToolFailureGuard.inputSignature("read", { filePath: "b.txt" }))
})
