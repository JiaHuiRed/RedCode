import { expect, test } from "bun:test"
import { isTaskSteerRecord, isUserTurn } from "./message-turn"

test("parent receipts never become turns, including before SSE parts arrive", () => {
  const user = { role: "user" }
  expect(isUserTurn(user, undefined)).toBe(false)
  const parts = [{ type: "text", metadata: { task_steer_record: { state: "queued" } } }]
  expect(isUserTurn(user, parts)).toBe(false)
  parts[0].metadata.task_steer_record.state = "delivered"
  expect(isUserTurn(user, parts)).toBe(false)
  expect(isTaskSteerRecord(parts)).toBe(true)
})

test("real steering, compaction, and background result inputs keep their existing semantics", () => {
  const user = { role: "user" }
  expect(isUserTurn(user, [{ type: "text", metadata: { task_steer: { source: "user" } } }])).toBe(true)
  expect(isUserTurn(user, [{ type: "compaction" }])).toBe(true)
  expect(isUserTurn(user, [{ type: "text" }])).toBe(true)
  expect(isUserTurn(user, [{ type: "file" }])).toBe(true)
  expect(isUserTurn({ role: "assistant" }, [{ type: "text" }])).toBe(false)
})
