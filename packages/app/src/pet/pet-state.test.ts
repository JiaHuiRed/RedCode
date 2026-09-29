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

/** 260929 Red 活事件源快捷方式：message.part.updated 的 tool part（旧 session.next.tool.* 已死） */
function tool(
  state: PetState,
  sessionID: string,
  tool: string,
  status: "pending" | "running" | "completed" | "error",
  at = NOW,
) {
  feed(state, "message.part.updated", { part: { sessionID, type: "tool", tool, state: { status } } }, at)
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
  test("status busy 兜底 thinking 并重置 worked；纯问答 idle 不庆祝", () => {
    const state = createPetState()
    feed(state, "session.status", { sessionID: "s1", status: { type: "busy" } })
    expect(resolvePet(state, NOW)).toEqual({ kind: "thinking" })
    feed(state, "session.status", { sessionID: "s1", status: { type: "idle" } })
    expect(resolvePet(state, NOW)).toEqual({ kind: "idle" })
    expect(state.flash).toBeUndefined()
  })

  test("tool part running 按工具分类展示，completed 回 thinking 并记 worked", () => {
    const state = createPetState()
    feed(state, "session.status", { sessionID: "s1", status: { type: "busy" } })
    tool(state, "s1", "edit", "running")
    expect(resolvePet(state, NOW)).toEqual({ kind: "coding", tool: "edit" })
    tool(state, "s1", "edit", "completed")
    expect(resolvePet(state, NOW)).toEqual({ kind: "thinking" })
    expect(state.worked["s1"]).toBe(true)
  })

  test("完整回合链 busy → 工具 → completed → idle 才庆祝", () => {
    // 260929 Red 这条钉的是旧判据的漏洞：工具完成后 entry 已回 thinking，
    // 照「最后一个 activity」判断永远庆祝不了——现在靠 worked 标记。
    const state = createPetState()
    feed(state, "session.status", { sessionID: "s1", status: { type: "busy" } })
    tool(state, "s1", "grep", "running")
    tool(state, "s1", "grep", "completed")
    expect(resolvePet(state, NOW)).toEqual({ kind: "thinking" })
    feed(state, "session.status", { sessionID: "s1", status: { type: "idle" } })
    expect(resolvePet(state, NOW)).toEqual({ kind: "success" })
    expect(resolvePet(state, NOW + FLASH_MS + 1)).toEqual({ kind: "idle" })
  })

  test("tool error 记 worked 但不 error flash（agent 自恢复，session.error 兜底）", () => {
    const state = createPetState()
    feed(state, "session.status", { sessionID: "s1", status: { type: "busy" } })
    tool(state, "s1", "bash", "error")
    expect(resolvePet(state, NOW)).toEqual({ kind: "thinking" })
    expect(state.flash).toBeUndefined()
    feed(state, "session.status", { sessionID: "s1", status: { type: "idle" } })
    expect(resolvePet(state, NOW)).toEqual({ kind: "success" })
  })

  test("session.error 触发 error flash 并清 entry/worked，过期回落", () => {
    const state = createPetState()
    tool(state, "s1", "bash", "running")
    feed(state, "session.error", { sessionID: "s1", error: { type: "unknown", message: "boom" } })
    expect(resolvePet(state, NOW)).toEqual({ kind: "error" })
    expect(state.sessions["s1"]).toBeUndefined()
    expect(state.worked["s1"]).toBeUndefined()
    expect(resolvePet(state, NOW + FLASH_MS + 1)).toEqual({ kind: "idle" })
  })

  test("error flash 不盖 permission/question（用户交互最高优先）", () => {
    // 260929 Red 旧实现第一行就 return flash，error flash 的 5 秒窗口内来的
    // permission 会被整段盖住。
    const state = createPetState()
    feed(state, "session.error", { sessionID: "s1", error: { type: "unknown", message: "boom" } })
    feed(state, "permission.asked", { sessionID: "s2", id: "p1" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "permission" })
    feed(state, "permission.replied", { sessionID: "s2", requestID: "p1" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "error" })
    feed(state, "question.asked", { sessionID: "s2", id: "q1" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "waiting" })
  })

  test("permission.asked 提到 permission，replied 回 thinking", () => {
    const state = createPetState()
    tool(state, "s1", "bash", "running")
    feed(state, "permission.asked", { sessionID: "s1", id: "p1" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "permission" })
    feed(state, "permission.replied", { sessionID: "s1", requestID: "p1" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "thinking" })
  })

  test("question.asked 进入 waiting，replied 回 thinking", () => {
    const state = createPetState()
    feed(state, "session.status", { sessionID: "s1", status: { type: "busy" } })
    feed(state, "question.asked", { sessionID: "s1", id: "q1" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "waiting" })
    feed(state, "question.replied", { sessionID: "s1", requestID: "q1" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "thinking" })
  })

  test("compaction part 进 compacting，session.compacted 回 thinking", () => {
    const state = createPetState()
    feed(state, "message.part.updated", { part: { sessionID: "s1", type: "compaction", auto: true } })
    expect(resolvePet(state, NOW)).toEqual({ kind: "compacting" })
    feed(state, "session.compacted", { sessionID: "s1" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "thinking" })
  })

  test("text part 无 entry 时兜底 thinking，不覆盖工具态", () => {
    const state = createPetState()
    feed(state, "message.part.updated", { part: { sessionID: "s1", type: "text", text: "hi" } })
    expect(resolvePet(state, NOW)).toEqual({ kind: "thinking" })
    tool(state, "s1", "bash", "running")
    feed(state, "message.part.updated", { part: { sessionID: "s1", type: "text", text: "more" } })
    expect(resolvePet(state, NOW)).toEqual({ kind: "tool", tool: "bash" })
  })

  test("多会话聚合取最高优先级（permission > coding）", () => {
    const state = createPetState()
    tool(state, "s1", "edit", "running")
    feed(state, "permission.asked", { sessionID: "s2", id: "p1" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "permission" })
  })

  test("stale 兜底：thinking 超过 STALE_MS 后回落 idle", () => {
    const state = createPetState()
    feed(state, "session.status", { sessionID: "s1", status: { type: "busy" } })
    expect(resolvePet(state, NOW + STALE_MS + 1)).toEqual({ kind: "idle" })
  })

  test("waiting/permission 不 stale（等用户不限时）", () => {
    const state = createPetState()
    feed(state, "permission.asked", { sessionID: "s1", id: "p1" })
    expect(resolvePet(state, NOW + STALE_MS * 10)).toEqual({ kind: "permission" })
  })

  test("无 sessionID 的事件安全忽略（含已死的 session.next.* 命名空间）", () => {
    const state = createPetState()
    feed(state, "message.part.updated", { part: { type: "tool", tool: "edit", state: { status: "running" } } })
    feed(state, "session.next.tool.called", { tool: "edit" })
    feed(state, "session.next.reasoning.started")
    feed(state, "session.error")
    expect(state.flash).toEqual({ kind: "error", at: NOW })
    expect(Object.keys(state.sessions)).toHaveLength(0)
  })

  // 260929 Red 下面三条钉 A6/A7：旧实现在同一回合内每个 step 的 busy 都复位 worked，
  // 而 agent loop 每个 step 顶部都发 busy（session/prompt.ts:1138 在 while(true) 里）。
  // 原有测试每回合只喂一次 busy，所以这个漏洞一条都没抓到。
  test("多步回合：下一步的 busy 不抹掉上一步的 worked", () => {
    const state = createPetState()
    feed(state, "session.status", { sessionID: "s1", status: { type: "busy" } })
    tool(state, "s1", "grep", "running")
    tool(state, "s1", "grep", "completed")
    // 第二步开张：又一条 busy，但这一步模型只剩纯文本要吐
    feed(state, "session.status", { sessionID: "s1", status: { type: "busy" } })
    feed(state, "message.part.updated", { part: { sessionID: "s1", type: "text", text: "done" } })
    expect(state.worked["s1"]).toBe(true)
    feed(state, "session.status", { sessionID: "s1", status: { type: "idle" } })
    expect(resolvePet(state, NOW)).toEqual({ kind: "success" })
  })

  test("新回合仍复位 worked：上一回合干过活，这一回合纯问答不庆祝", () => {
    const state = createPetState()
    feed(state, "session.status", { sessionID: "s1", status: { type: "busy" } })
    tool(state, "s1", "grep", "completed")
    feed(state, "session.status", { sessionID: "s1", status: { type: "idle" } })
    expect(resolvePet(state, NOW)).toEqual({ kind: "success" })
    // 让上一回合的 success flash 过期，否则下面分不清是谁在闪
    feed(state, "session.status", { sessionID: "s1", status: { type: "busy" } }, NOW + FLASH_MS + 1)
    expect(state.worked["s1"]).toBe(false)
    feed(state, "session.status", { sessionID: "s1", status: { type: "idle" } }, NOW + FLASH_MS + 2)
    // flash 本身不删、只按时间失效，所以这里验展示态而不是内部字段
    expect(resolvePet(state, NOW + FLASH_MS + 2)).toEqual({ kind: "idle" })
  })

  test("过期 entry 在下一个事件时被清掉，不再只跳不删", () => {
    // resolvePet 是 createMemo 里的纯投影，不能让它顺手删状态；清理放在写入点。
    const state = createPetState()
    feed(state, "session.status", { sessionID: "s1", status: { type: "busy" } })
    feed(state, "session.status", { sessionID: "s2", status: { type: "busy" } })
    expect(Object.keys(state.sessions)).toHaveLength(2)
    // s1 早已过期，s2 是刚来的活会话——一次无关事件的写入应只扫掉 s1
    feed(state, "session.status", { sessionID: "s2", status: { type: "busy" } }, NOW + STALE_MS + 1)
    expect(Object.keys(state.sessions)).toEqual(["s2"])
    expect(state.worked["s1"]).toBeUndefined()
  })
})
