import { describe, expect, test } from "bun:test"
import { PromptCaches, settlePromptCaches } from "../../src/session/prompt-caches"

// 260811 cc audit R4: 分代结算的边界语义——只清目标会话的 msgPin/modelMsgs，
// system/tools 与别的会话不受牵连。

function seed(sessionID: string) {
  PromptCaches.msgPin = { sessionID, messages: new Map([["m1", [{ type: "text", text: "hi" }]]]) }
  PromptCaches.modelMsgs = { sessionID, modelKey: "p/m", messages: [{ role: "user", content: "hi" }] }
  PromptCaches.system = { sessionID, modelKey: "p/m", skills: undefined, env: ["env"], instructions: ["ins"] }
  PromptCaches.tools = { sessionID, defs: new Map() }
}

describe("session.prompt-caches", () => {
  test("settle drops msgPin and modelMsgs for the session, keeps system/tools", () => {
    seed("ses_a")
    const dropped = settlePromptCaches("ses_a", "test")
    expect(dropped).toBe(2)
    expect(PromptCaches.msgPin).toBeUndefined()
    expect(PromptCaches.modelMsgs).toBeUndefined()
    expect(PromptCaches.system?.sessionID).toBe("ses_a")
    expect(PromptCaches.tools?.sessionID).toBe("ses_a")
  })

  test("settle for another session is a no-op", () => {
    seed("ses_b")
    const dropped = settlePromptCaches("ses_other", "test")
    expect(dropped).toBe(0)
    expect(PromptCaches.msgPin?.sessionID).toBe("ses_b")
    expect(PromptCaches.modelMsgs?.sessionID).toBe("ses_b")
  })

  test("settle is idempotent", () => {
    seed("ses_c")
    settlePromptCaches("ses_c", "test")
    expect(settlePromptCaches("ses_c", "test")).toBe(0)
  })
})
