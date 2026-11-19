import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { applyDirectoryEvent } from "@/context/global-sync/event-reducer"
import type { State } from "@/context/global-sync/types"
import {
  applyPetEvent,
  beginPetBootstrap,
  finishPetBootstrap,
  recordPetBootstrapEvent,
  createPetState,
} from "@redcode-ai/ui/pet-state"

// 261119 Red 规则层下沉 @redcode-ai/ui 后，与 app child-store reducer 的集成用例留在 app：
// 钉的是 journal 释放的事件能被真实 event-reducer 消费（快照可能比窗口内事件旧）。
const NOW = 1_000_000

describe("pet journal × child reducer", () => {
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
})
