import { describe, expect, test } from "bun:test"
import {
  applyPetEvent,
  classifyTool,
  createPetState,
  FLASH_MS,
  resolvePet,
  STALE_MS,
  type PetState,
} from "./pet-state"

const NOW = 1_000_000

function feed(state: PetState, type: string, properties: Record<string, unknown> = {}, at = NOW) {
  applyPetEvent(state, { type, properties }, at)
}

describe("classifyTool", () => {
  test("edit/write 类归 coding", () => {
    expect(classifyTool("edit")).toBe("coding")
    expect(classifyTool("write")).toBe("coding")
  })
  test("grep/glob/read 类归 searching", () => {
    expect(classifyTool("grep")).toBe("searching")
    expect(classifyTool("glob")).toBe("searching")
  })
  test("其余归 tool", () => {
    expect(classifyTool("bash")).toBe("tool")
    expect(classifyTool("todowrite")).toBe("tool")
  })
})

describe("applyPetEvent", () => {
  test("reasoning.started 进入 thinking", () => {
    const state = createPetState()
    feed(state, "session.next.reasoning.started", { sessionID: "s1" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "thinking" })
  })

  test("tool.called 按工具分类覆盖 thinking", () => {
    const state = createPetState()
    feed(state, "session.next.reasoning.started", { sessionID: "s1" })
    feed(state, "session.next.tool.called", { sessionID: "s1", tool: "edit" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "coding", tool: "edit" })
  })

  test("tool.success 回到 thinking（agent 继续生成）", () => {
    const state = createPetState()
    feed(state, "session.next.tool.called", { sessionID: "s1", tool: "grep" })
    feed(state, "session.next.tool.success", { sessionID: "s1" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "thinking" })
  })

  test("permission.asked 提到 permission，replied 回 thinking", () => {
    const state = createPetState()
    feed(state, "session.next.tool.called", { sessionID: "s1", tool: "bash" })
    feed(state, "permission.asked", { sessionID: "s1", id: "p1" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "permission" })
    feed(state, "permission.replied", { sessionID: "s1", requestID: "p1" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "thinking" })
  })

  test("question.asked 进入 waiting，replied 回 thinking", () => {
    const state = createPetState()
    feed(state, "session.next.reasoning.started", { sessionID: "s1" })
    feed(state, "question.asked", { sessionID: "s1", id: "q1" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "waiting" })
    feed(state, "question.replied", { sessionID: "s1", requestID: "q1" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "thinking" })
  })

  test("compaction started/ended", () => {
    const state = createPetState()
    feed(state, "session.next.compaction.started", { sessionID: "s1", reason: "auto" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "compacting" })
    feed(state, "session.next.compaction.ended", { sessionID: "s1" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "thinking" })
  })

  test("status busy 兜底 thinking，纯问答 idle 收尾不庆祝", () => {
    const state = createPetState()
    feed(state, "session.status", { sessionID: "s1", status: { type: "busy" } })
    expect(resolvePet(state, NOW)).toEqual({ kind: "thinking" })
    feed(state, "session.status", { sessionID: "s1", status: { type: "idle" } })
    expect(resolvePet(state, NOW)).toEqual({ kind: "idle" })
    expect(state.flash).toBeUndefined()
  })

  test("工具型活动后 status idle 触发 success flash，过期回落 idle", () => {
    const state = createPetState()
    feed(state, "session.next.tool.called", { sessionID: "s1", tool: "edit" })
    feed(state, "session.status", { sessionID: "s1", status: { type: "idle" } })
    expect(resolvePet(state, NOW)).toEqual({ kind: "success" })
    expect(resolvePet(state, NOW + FLASH_MS + 1)).toEqual({ kind: "idle" })
  })

  test("session.error 触发 error flash 并清 entry，过期回落", () => {
    const state = createPetState()
    feed(state, "session.next.tool.called", { sessionID: "s1", tool: "bash" })
    feed(state, "session.error", { sessionID: "s1", error: { type: "unknown", message: "boom" } })
    expect(resolvePet(state, NOW)).toEqual({ kind: "error" })
    expect(state.sessions["s1"]).toBeUndefined()
    expect(resolvePet(state, NOW + FLASH_MS + 1)).toEqual({ kind: "idle" })
  })

  test("多会话聚合取最高优先级（permission > thinking）", () => {
    const state = createPetState()
    feed(state, "session.next.reasoning.started", { sessionID: "s1" })
    feed(state, "permission.asked", { sessionID: "s2", id: "p1" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "permission" })
  })

  test("stale 兜底：thinking 超过 STALE_MS 后回落 idle", () => {
    const state = createPetState()
    feed(state, "session.next.reasoning.started", { sessionID: "s1" })
    expect(resolvePet(state, NOW + STALE_MS + 1)).toEqual({ kind: "idle" })
  })

  test("waiting/permission 不 stale（等用户不限时）", () => {
    const state = createPetState()
    feed(state, "permission.asked", { sessionID: "s1", id: "p1" })
    expect(resolvePet(state, NOW + STALE_MS * 10)).toEqual({ kind: "permission" })
  })

  test("无 sessionID 的事件安全忽略", () => {
    const state = createPetState()
    feed(state, "session.next.reasoning.started")
    feed(state, "session.error")
    expect(state.flash).toEqual({ kind: "error", at: NOW })
    expect(Object.keys(state.sessions)).toHaveLength(0)
  })
})
