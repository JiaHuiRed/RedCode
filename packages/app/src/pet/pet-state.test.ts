import { describe, expect, test } from "bun:test"
import { createStore, produce } from "solid-js/store"
import { applyDirectoryEvent } from "../context/global-sync/event-reducer"
import type { State } from "../context/global-sync/types"
import { petDetail } from "./pet-lines"
import {
  applyPetEvent,
  beginPetBootstrap,
  recordPetBootstrapEvent,
 finishPetBootstrap,
 settlePetBootstrap,
 classifyTool,
  createPetState,
  DEFAULT_OUTFIT,
  FLASH_MS,
  outfitFor,
  resolvePet,
  resolveSessionPet,
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

describe("current session projection", () => {
  test("bootstrap journal keeps newer reducer events until the snapshot is committed, then releases them", () => {
    const state = createPetState()
    beginPetBootstrap(state, "dir")
    const reply = { type: "permission.replied", properties: { sessionID: "a", requestID: "p1" } }
    const idle = { type: "session.status", properties: { sessionID: "a", status: { type: "idle" } } }
    applyPetEvent(state, reply, NOW)
    recordPetBootstrapEvent(state, "dir", reply)
    applyPetEvent(state, idle, NOW + 1)
    recordPetBootstrapEvent(state, "dir", idle)
    const stale = { status: { type: "busy" }, permissions: [
      { id: "p1", permission: "bash" }, { id: "p2", permission: "edit" },
    ] }
    expect(resolveSessionPet(state, NOW + 1, "a", stale, "dir")).toEqual({
      kind: "permission", sessionID: "a", detail: "edit",
    })
    expect(resolveSessionPet(state, NOW + 1, "b", { status: { type: "busy" } }, "dir").kind).toBe("thinking")
    expect(finishPetBootstrap(state, "dir")).toEqual([reply, idle])
    expect(Object.keys(state.bootstraps)).toHaveLength(0)
    expect(resolveSessionPet(state, NOW + 1, "a", { status: { type: "busy" } }, "dir").kind).toBe("thinking")
  })

  test("settle releases only the requested partition and keeps the rest for later snapshots", () => {
    const state = createPetState()
    beginPetBootstrap(state, "dir")
    const reply = { type: "permission.replied", properties: { sessionID: "a", requestID: "p1" } }
    const idle = { type: "session.status", properties: { sessionID: "a", status: { type: "idle" } } }
    recordPetBootstrapEvent(state, "dir", reply)
    recordPetBootstrapEvent(state, "dir", idle)
    expect(settlePetBootstrap(state, "dir", "permission")).toEqual([reply])
    expect(settlePetBootstrap(state, "dir", "permission")).toEqual([])
    expect(resolveSessionPet(state, NOW + 1, "a", { status: { type: "busy" } }, "dir").kind).toBe("idle")
    expect(finishPetBootstrap(state, "dir")).toEqual([idle])
  })

  test("new bootstrap accepts fresh snapshots after old idle and reply", () => {
    const state = createPetState()
    feed(state, "permission.replied", { sessionID: "s", requestID: "p" })
    feed(state, "session.status", { sessionID: "s", status: { type: "idle" } })
    beginPetBootstrap(state, "dir")
    finishPetBootstrap(state, "dir")
    expect(resolveSessionPet(state, NOW, "s", { status: { type: "busy" } }, "dir").kind).toBe("thinking")
    expect(resolveSessionPet(state, NOW, "s", { permissions: [{ id: "p", permission: "bash" }] }, "dir").kind).toBe("permission")
  })

  test("commits concurrent replies and idle through the actual child reducer", () => {
    const state = createPetState()
    const [child, setChild] = createStore({
      session_status: { a: { type: "busy" } },
      permission: { a: [
        { id: "p1", sessionID: "a", permission: "bash", patterns: [], metadata: {}, always: [] },
        { id: "p2", sessionID: "a", permission: "edit", patterns: [], metadata: {}, always: [] },
      ] },
      question: {},
    } as unknown as State)
    beginPetBootstrap(state, "dir")
    for (const event of [
      { type: "permission.replied", properties: { sessionID: "a", requestID: "p1" } },
      { type: "session.status", properties: { sessionID: "a", status: { type: "idle" } } },
    ]) {
      applyPetEvent(state, event, NOW)
      recordPetBootstrapEvent(state, "dir", event)
    }
    for (const event of finishPetBootstrap(state, "dir")) {
      applyDirectoryEvent({
        event: event as Parameters<typeof applyDirectoryEvent>[0]["event"],
        directory: "dir", store: child, setStore: setChild, push() {}, loadLsp() {},
      })
    }
    expect(child.permission.a.map((item) => item.id)).toEqual(["p2"])
    expect(child.session_status.a?.type).toBe("idle")
    expect(Object.keys(state.bootstraps)).toHaveLength(0)
  })

  test("question replies stay scoped across sessions and journal generations", () => {
    const state = createPetState()
    const snapshot = { questions: [
      { id: "q1", questions: [{ header: "第一题", question: "怎么选？" }] },
      { id: "q2", questions: [{ header: "第二题", question: "怎么做？" }] },
    ] }
    for (let round = 0; round < 50; round++) {
      beginPetBootstrap(state, "dir")
      const event = { type: "question.rejected", properties: { sessionID: "a", requestID: "q1" } }
      applyPetEvent(state, event, NOW)
      recordPetBootstrapEvent(state, "dir", event)
      expect(petDetail(resolveSessionPet(state, NOW, "a", snapshot, "dir"))).toBe("问题：第二题")
      expect(petDetail(resolveSessionPet(state, NOW, "b", snapshot, "dir"))).toBe("问题：第一题")
      finishPetBootstrap(state, "dir")
      expect(Object.keys(state.bootstraps)).toHaveLength(0)
    }
  })

  test("journal survives the actual Solid store producer and is released at commit", () => {
    const [state, setState] = createStore(createPetState())
    const event = { type: "question.replied", properties: { sessionID: "s", requestID: "q" } }
    setState(produce((draft) => beginPetBootstrap(draft, "dir")))
    setState(produce((draft) => {
      applyPetEvent(draft, event, NOW)
      recordPetBootstrapEvent(draft, "dir", event)
    }))
    let events: typeof event[] = []
    setState(produce((draft) => {
      events = finishPetBootstrap(draft, "dir") as typeof event[]
    }))
    expect(events).toEqual([event])
    expect(Object.keys(state.bootstraps)).toHaveLength(0)
  })

  test("restores busy and pending requests from snapshots without leaking another session", () => {
    const state = createPetState()
    tool(state, "other", "edit", "running")
    const snapshot = {
      status: { type: "busy" },
      permissions: [{ id: "p", permission: "bash" }],
      questions: [{ id: "q", questions: [{ header: "选择方案", question: "选哪个？" }] }],
    }
    expect(resolveSessionPet(state, NOW, "current", { status: snapshot.status })).toEqual({ kind: "thinking", sessionID: "current" })
    expect(resolveSessionPet(state, NOW, "current", snapshot)).toEqual({ kind: "permission", sessionID: "current", detail: "bash" })
    expect(resolveSessionPet(state, NOW, "current", { questions: snapshot.questions })).toEqual({
      kind: "waiting", sessionID: "current", detail: "选择方案",
    })
    expect(resolvePet(state, NOW).kind).toBe("coding")
  })

  test("real reducer events beat busy snapshots, expire, and clear replied requests", () => {
    const state = createPetState()
    beginPetBootstrap(state, "dir")
    const snapshot = { status: { type: "busy" }, permissions: [{ id: "p", permission: "bash" }] }
    tool(state, "current", "grep", "running")
    expect(resolveSessionPet(state, NOW, "current", snapshot).kind).toBe("permission")
    feed(state, "permission.replied", { sessionID: "current", requestID: "p" })
    recordPetBootstrapEvent(state, "dir", { type: "permission.replied", properties: { sessionID: "current", requestID: "p" } })
    tool(state, "current", "grep", "running")
    expect(resolveSessionPet(state, NOW, "current", snapshot, "dir")).toEqual({ kind: "searching", tool: "grep", sessionID: "current" })
    expect(resolveSessionPet(state, NOW + STALE_MS + 1, "current", snapshot, "dir")).toEqual({ kind: "thinking", sessionID: "current" })
    feed(state, "session.status", { sessionID: "current", status: { type: "idle" } }, NOW + 1)
    recordPetBootstrapEvent(state, "dir", { type: "session.status", properties: { sessionID: "current", status: { type: "idle" } } })
    expect(resolveSessionPet(state, NOW + 1, "current", snapshot, "dir")).toEqual({ kind: "idle", sessionID: "current" })
  })

  test("session switching isolates owned flash and suppresses unowned flash", () => {
    const state = createPetState()
    feed(state, "session.error", { sessionID: "a" })
    expect(resolveSessionPet(state, NOW, "a").kind).toBe("error")
    expect(resolveSessionPet(state, NOW, "b").kind).toBe("unknown")
    feed(state, "session.status", { sessionID: "a", status: { type: "busy" } })
    expect(resolveSessionPet(state, NOW, "a").kind).toBe("thinking")
    feed(state, "session.error")
    expect(resolveSessionPet(state, NOW, "b").kind).toBe("unknown")
    expect(resolvePet(state, NOW).kind).toBe("error")
  })

  test("empty or incomplete data is neutral, explicit idle remains idle", () => {
    const state = createPetState()
    expect(resolveSessionPet(state, NOW, "s")).toEqual({ kind: "unknown", sessionID: "s" })
    expect(resolveSessionPet(state, NOW, "s", {})).toEqual({ kind: "unknown", sessionID: "s" })
    expect(resolveSessionPet(state, NOW, "s", { statusReady: false })).toEqual({ kind: "unknown", sessionID: "s" })
    expect(resolveSessionPet(state, NOW, "s", { statusReady: true })).toEqual({ kind: "idle", sessionID: "s" })
    expect(resolveSessionPet(state, NOW, "s", { status: { type: "idle" } })).toEqual({ kind: "idle", sessionID: "s" })
  })
})

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
  test("real event details follow the winning session and blocker lifecycle", () => {
    const state = createPetState()
    feed(state, "message.part.updated", { part: {
      id: "prt1", sessionID: "s1", messageID: "m1", type: "tool", tool: "grep",
      state: { status: "running", input: { pattern: "secret", path: "C:\\private" } },
    } })
    expect(petDetail(resolvePet(state, NOW))).toBe("工具：grep")
    feed(state, "question.asked", {
      id: "q1", sessionID: "s1", questions: [{ header: "选择方案", question: "完整问题 secret", options: [] }],
    })
    expect(petDetail(resolvePet(state, NOW))).toBe("问题：选择方案")
    feed(state, "permission.asked", {
      id: "p1", sessionID: "s1", permission: "bash", patterns: ["C:\\private"], metadata: { secret: "hidden" }, always: [],
    })
    expect(petDetail(resolvePet(state, NOW))).toBe("权限：bash")
    tool(state, "s1", "edit", "running")
    expect(petDetail(resolvePet(state, NOW))).toBe("权限：bash")
    feed(state, "permission.replied", { sessionID: "s1", requestID: "p1", reply: "once" })
    expect(petDetail(resolvePet(state, NOW))).toBe("问题：选择方案")
    feed(state, "question.rejected", { sessionID: "s1", requestID: "q1" })
    expect(petDetail(resolvePet(state, NOW))).toBeUndefined()
  })

  test("same-kind winner switches details and idle/error clear blockers", () => {
    const state = createPetState()
    feed(state, "question.asked", { id: "q1", sessionID: "a", questions: [{ header: "方案一", question: "哪个方案？" }] })
    feed(state, "question.asked", { id: "q2", sessionID: "b", questions: [{ header: "方案二", question: "怎么选？" }] })
    expect(petDetail(resolvePet(state, NOW))).toBe("问题：方案一")
    feed(state, "session.status", { sessionID: "a", status: { type: "idle" } })
    expect(petDetail(resolvePet(state, NOW))).toBe("问题：方案二")
    feed(state, "session.error", { sessionID: "b" })
    expect(petDetail(resolvePet(state, NOW))).toBeUndefined()
    expect(state.blockers.b).toBeUndefined()
  })

  test("same-kind tool winner updates and expires without stale detail", () => {
    const state = createPetState()
    tool(state, "a", "read", "running")
    tool(state, "b", "grep", "running")
    expect(petDetail(resolvePet(state, NOW))).toBe("工具：read")
    tool(state, "a", "read", "completed")
    expect(petDetail(resolvePet(state, NOW))).toBe("工具：grep")
    expect(petDetail(resolvePet(state, NOW + STALE_MS + 1))).toBeUndefined()
  })

  test("multiple requests in one session remain until their matching replies", () => {
    const state = createPetState()
    feed(state, "permission.asked", { id: "p1", sessionID: "s", permission: "bash" })
    feed(state, "permission.asked", { id: "p2", sessionID: "s", permission: "edit" })
    feed(state, "permission.replied", { sessionID: "s", requestID: "p1" })
    expect(petDetail(resolvePet(state, NOW))).toBe("权限：edit")
    feed(state, "permission.replied", { sessionID: "s", requestID: "p2" })
    expect(resolvePet(state, NOW).kind).toBe("thinking")
  })

  test("unsafe or missing details never expose inputs, paths, secrets or full questions", () => {
    const state = createPetState()
    tool(state, "s1", "C:\\private\\secret", "running")
    expect(petDetail(resolvePet(state, NOW))).toBeUndefined()
    feed(state, "question.asked", { id: "q", sessionID: "s1", questions: [{ header: "密码 secret", question: "完整问题" }] })
    expect(petDetail(resolvePet(state, NOW))).toBeUndefined()
    feed(state, "question.asked", { id: "q", sessionID: "s1", questions: [{ header: "完整问题", question: "完整问题" }] })
    expect(petDetail(resolvePet(state, NOW))).toBeUndefined()
    feed(state, "permission.asked", { id: "p", sessionID: "s1", permission: "C:\\private" })
    expect(petDetail(resolvePet(state, NOW))).toBeUndefined()
  })

  test("message.updated records the session provider outfit", () => {
    const state = createPetState()
    feed(state, "message.updated", {
      info: { sessionID: "s1", model: { providerID: "openai", modelID: "gpt-5" } },
    })
    expect(outfitFor(state, "s1")).toBe("openai")
  })

  test("missing model or sessionID uses the default outfit", () => {
    const state = createPetState()
    feed(state, "message.updated", { info: { sessionID: "s1" } })
    feed(state, "message.updated", { info: { model: { providerID: "openai", modelID: "gpt-5" } } })
    expect(outfitFor(state, "s1")).toBe(DEFAULT_OUTFIT)
    expect(outfitFor(state, undefined)).toBe(DEFAULT_OUTFIT)
  })

  test("model outfit is cleared with idle, error, and stale activity", () => {
    const state = createPetState()
    const setModel = (sessionID: string) =>
      feed(state, "message.updated", { info: { sessionID, model: { providerID: "openai", modelID: "gpt-5" } } })

    setModel("idle")
    feed(state, "session.status", { sessionID: "idle", status: { type: "idle" } })
    expect(outfitFor(state, "idle")).toBe(DEFAULT_OUTFIT)

    setModel("error")
    feed(state, "session.error", { sessionID: "error" })
    expect(outfitFor(state, "error")).toBe(DEFAULT_OUTFIT)

    setModel("stale")
    feed(state, "session.status", { sessionID: "stale", status: { type: "busy" } })
    feed(state, "session.status", { sessionID: "other", status: { type: "busy" } }, NOW + STALE_MS + 1)
    expect(outfitFor(state, "stale")).toBe(DEFAULT_OUTFIT)
  })

  test("winning permission session selects its own outfit", () => {
    const state = createPetState()
    feed(state, "message.updated", {
      info: { sessionID: "session-a", model: { providerID: "provider-a", modelID: "model-a" } },
    })
    feed(state, "message.updated", {
      info: { sessionID: "session-b", model: { providerID: "provider-b", modelID: "model-b" } },
    })
    tool(state, "session-b", "edit", "running")
    feed(state, "permission.asked", { sessionID: "session-a" })
    const display = resolvePet(state, NOW)
    expect(display.sessionID).toBe("session-a")
    expect(outfitFor(state, display.sessionID)).toBe("provider-a")
  })

  test("status busy 兜底 thinking 并重置 worked；纯问答 idle 不庆祝", () => {
    const state = createPetState()
    feed(state, "session.status", { sessionID: "s1", status: { type: "busy" } })
    expect(resolvePet(state, NOW)).toEqual({ kind: "thinking", sessionID: "s1" })
    feed(state, "session.status", { sessionID: "s1", status: { type: "idle" } })
    expect(resolvePet(state, NOW)).toEqual({ kind: "idle" })
    expect(state.flash).toBeUndefined()
  })

  test("tool part running 按工具分类展示，completed 回 thinking 并记 worked", () => {
    const state = createPetState()
    feed(state, "session.status", { sessionID: "s1", status: { type: "busy" } })
    tool(state, "s1", "edit", "running")
    expect(resolvePet(state, NOW)).toEqual({ kind: "coding", tool: "edit", sessionID: "s1" })
    tool(state, "s1", "edit", "completed")
    expect(resolvePet(state, NOW)).toEqual({ kind: "thinking", sessionID: "s1" })
    expect(state.worked["s1"]).toBe(true)
  })

  test("完整回合链 busy → 工具 → completed → idle 才庆祝", () => {
    // 260929 Red 这条钉的是旧判据的漏洞：工具完成后 entry 已回 thinking，
    // 照「最后一个 activity」判断永远庆祝不了——现在靠 worked 标记。
    const state = createPetState()
    feed(state, "session.status", { sessionID: "s1", status: { type: "busy" } })
    tool(state, "s1", "grep", "running")
    tool(state, "s1", "grep", "completed")
    expect(resolvePet(state, NOW)).toEqual({ kind: "thinking", sessionID: "s1" })
    feed(state, "session.status", { sessionID: "s1", status: { type: "idle" } })
    expect(resolvePet(state, NOW)).toEqual({ kind: "success" })
    expect(resolvePet(state, NOW + FLASH_MS + 1)).toEqual({ kind: "idle" })
  })

  test("tool error 记 worked 但不 error flash（agent 自恢复，session.error 兜底）", () => {
    const state = createPetState()
    feed(state, "session.status", { sessionID: "s1", status: { type: "busy" } })
    tool(state, "s1", "bash", "error")
    expect(resolvePet(state, NOW)).toEqual({ kind: "thinking", sessionID: "s1" })
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
    expect(resolvePet(state, NOW)).toEqual({ kind: "permission", sessionID: "s2" })
    feed(state, "permission.replied", { sessionID: "s2", requestID: "p1" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "error" })
    feed(state, "question.asked", { sessionID: "s2", id: "q1" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "waiting", sessionID: "s2" })
  })

  test("permission.asked 提到 permission，replied 回 thinking", () => {
    const state = createPetState()
    tool(state, "s1", "bash", "running")
    feed(state, "permission.asked", { sessionID: "s1", id: "p1" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "permission", sessionID: "s1" })
    feed(state, "permission.replied", { sessionID: "s1", requestID: "p1" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "thinking", sessionID: "s1" })
  })

  test("question.asked 进入 waiting，replied 回 thinking", () => {
    const state = createPetState()
    feed(state, "session.status", { sessionID: "s1", status: { type: "busy" } })
    feed(state, "question.asked", { sessionID: "s1", id: "q1" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "waiting", sessionID: "s1" })
    feed(state, "question.replied", { sessionID: "s1", requestID: "q1" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "thinking", sessionID: "s1" })
  })

  test("compaction part 进 compacting，session.compacted 回 thinking", () => {
    const state = createPetState()
    feed(state, "message.part.updated", { part: { sessionID: "s1", type: "compaction", auto: true } })
    expect(resolvePet(state, NOW)).toEqual({ kind: "compacting", sessionID: "s1" })
    feed(state, "session.compacted", { sessionID: "s1" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "thinking", sessionID: "s1" })
  })

  test("text part 无 entry 时兜底 thinking，不覆盖工具态", () => {
    const state = createPetState()
    feed(state, "message.part.updated", { part: { sessionID: "s1", type: "text", text: "hi" } })
    expect(resolvePet(state, NOW)).toEqual({ kind: "thinking", sessionID: "s1" })
    tool(state, "s1", "bash", "running")
    feed(state, "message.part.updated", { part: { sessionID: "s1", type: "text", text: "more" } })
    expect(resolvePet(state, NOW)).toEqual({ kind: "tool", tool: "bash", sessionID: "s1" })
  })

  test("多会话聚合取最高优先级（permission > coding）", () => {
    const state = createPetState()
    tool(state, "s1", "edit", "running")
    feed(state, "permission.asked", { sessionID: "s2", id: "p1" })
    expect(resolvePet(state, NOW)).toEqual({ kind: "permission", sessionID: "s2" })
  })

  test("stale 兜底：thinking 超过 STALE_MS 后回落 idle", () => {
    const state = createPetState()
    feed(state, "session.status", { sessionID: "s1", status: { type: "busy" } })
    expect(resolvePet(state, NOW + STALE_MS + 1)).toEqual({ kind: "idle" })
  })

  test("waiting/permission 不 stale（等用户不限时）", () => {
    const state = createPetState()
    feed(state, "permission.asked", { sessionID: "s1", id: "p1" })
    expect(resolvePet(state, NOW + STALE_MS * 10)).toEqual({ kind: "permission", sessionID: "s1" })
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

  // 260930 Red 下面一组钉流式心跳与获胜归属：产出期真正的高频事件是 message.part.delta，
  // 旧实现不认它，长回复中途 entry 90s 超时被打回 idle，worked 连坐被清，success 也丢了。
  test("delta 心跳续命：长流式回合不超时，idle 后 success 保留", () => {
    const state = createPetState()
    feed(state, "session.status", { sessionID: "s1", status: { type: "busy" } })
    tool(state, "s1", "edit", "completed") // worked=true，之后纯文本生成
    for (let t = 10_000; t <= 120_000; t += 10_000) {
      feed(
        state,
        "message.part.delta",
        { sessionID: "s1", messageID: "m1", partID: "p1", field: "text", delta: "x" },
        NOW + t,
      )
    }
    expect(resolvePet(state, NOW + 125_000)).toEqual({ kind: "thinking", sessionID: "s1" })
    expect(state.worked["s1"]).toBe(true)
    feed(state, "session.status", { sessionID: "s1", status: { type: "idle" } }, NOW + 126_000)
    expect(resolvePet(state, NOW + 126_000)).toEqual({ kind: "success" })
  })

  test("delta 不覆盖工具态，也不打扰等用户的 waiting/permission", () => {
    const state = createPetState()
    tool(state, "s1", "edit", "running")
    feed(
      state,
      "message.part.delta",
      { sessionID: "s1", messageID: "m1", partID: "p1", field: "text", delta: "x" },
      NOW + 50_000,
    )
    expect(resolvePet(state, NOW + 50_000)).toEqual({ kind: "coding", tool: "edit", sessionID: "s1" })
    feed(state, "question.asked", { sessionID: "s1", id: "q1" }, NOW + 51_000)
    feed(
      state,
      "message.part.delta",
      { sessionID: "s1", messageID: "m1", partID: "p1", field: "text", delta: "x" },
      NOW + 52_000,
    )
    expect(resolvePet(state, NOW + 52_000)).toEqual({ kind: "waiting", sessionID: "s1" })
  })

  test("text part.updated 刷新已有 thinking（低频定型事件之间不再超时）", () => {
    const state = createPetState()
    feed(state, "session.status", { sessionID: "s1", status: { type: "busy" } })
    feed(state, "message.part.updated", { part: { sessionID: "s1", type: "text", text: "half" } }, NOW + 80_000)
    expect(resolvePet(state, NOW + 85_000)).toEqual({ kind: "thinking", sessionID: "s1" })
  })

  test("后续 step 的 busy 刷新 thinking 心跳，但 worked 不复位", () => {
    const state = createPetState()
    feed(state, "session.status", { sessionID: "s1", status: { type: "busy" } })
    tool(state, "s1", "grep", "completed")
    feed(state, "session.status", { sessionID: "s1", status: { type: "busy" } }, NOW + 80_000)
    expect(resolvePet(state, NOW + 85_000)).toEqual({ kind: "thinking", sessionID: "s1" })
    expect(state.worked["s1"]).toBe(true)
  })

  test("无 sessionID 的 delta 安全忽略", () => {
    const state = createPetState()
    feed(state, "message.part.delta", { messageID: "m1", partID: "p1", field: "text", delta: "x" })
    expect(Object.keys(state.sessions)).toHaveLength(0)
  })
})
