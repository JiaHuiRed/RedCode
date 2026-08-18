import { describe, expect, test } from "bun:test"
import { PromptCaches, settlePromptCaches } from "../../src/session/prompt-caches"

// 260811 cc audit R4: 分代结算的边界语义——只清目标会话的 msgPin/modelMsgs，
// system/tools 与别的会话不受牵连。

function seed(sessionID: string) {
  PromptCaches.msgPin.set(sessionID, { sessionID, messages: new Map([["m1", [{ type: "text", text: "hi" }]]]) })
  PromptCaches.modelMsgs.set(sessionID, new Map([["p/m", { sessionID, modelKey: "p/m", messages: [{ role: "user", content: "hi" }] }]]))
  PromptCaches.system.set(
    sessionID,
    new Map([["p/m", { sessionID, modelKey: "p/m", skills: undefined, env: ["env"], instructions: ["ins"] }]]),
  )
  PromptCaches.tools.set(sessionID, { sessionID, defs: new Map() })
}

describe("session.prompt-caches", () => {
  test("settle drops msgPin and modelMsgs for the session, keeps system/tools", () => {
    seed("ses_a")
    const dropped = settlePromptCaches("ses_a", "test")
    expect(dropped).toBe(2)
    expect(PromptCaches.msgPin.has("ses_a")).toBe(false)
    expect(PromptCaches.modelMsgs.has("ses_a")).toBe(false)
    expect(PromptCaches.system.get("ses_a")?.get("p/m")?.sessionID).toBe("ses_a")
    expect(PromptCaches.tools.get("ses_a")?.sessionID).toBe("ses_a")
  })

  test("settle for another session is a no-op", () => {
    seed("ses_b")
    const dropped = settlePromptCaches("ses_other", "test")
    expect(dropped).toBe(0)
    expect(PromptCaches.msgPin.get("ses_b")?.sessionID).toBe("ses_b")
    expect(PromptCaches.modelMsgs.get("ses_b")?.get("p/m")?.sessionID).toBe("ses_b")
  })

  test("settle is idempotent", () => {
    seed("ses_c")
    settlePromptCaches("ses_c", "test")
    expect(settlePromptCaches("ses_c", "test")).toBe(0)
  })

  test("keeps concurrent sessions and model variants isolated", () => {
    seed("ses_parent")
    seed("ses_child")
    PromptCaches.modelMsgs.set(
      "ses_parent",
      new Map([
        ["p/m", { sessionID: "ses_parent", modelKey: "p/m", messages: [{ role: "user", content: "parent" }] }],
        ["q/n", { sessionID: "ses_parent", modelKey: "q/n", messages: [{ role: "user", content: "other model" }] }],
      ]),
    )

    expect(PromptCaches.msgPin.get("ses_parent")?.sessionID).toBe("ses_parent")
    expect(PromptCaches.msgPin.get("ses_child")?.sessionID).toBe("ses_child")
    expect(PromptCaches.modelMsgs.get("ses_parent")?.get("p/m")?.messages[0]?.content).toBe("parent")
    expect(PromptCaches.modelMsgs.get("ses_parent")?.get("q/n")?.messages[0]?.content).toBe("other model")
    expect(PromptCaches.modelMsgs.get("ses_child")?.get("p/m")?.sessionID).toBe("ses_child")
    expect(PromptCaches.system.get("ses_parent")?.get("p/m")?.sessionID).toBe("ses_parent")
    expect(PromptCaches.system.get("ses_child")?.get("p/m")?.sessionID).toBe("ses_child")
    expect(PromptCaches.tools.get("ses_parent")?.sessionID).toBe("ses_parent")
    expect(PromptCaches.tools.get("ses_child")?.sessionID).toBe("ses_child")

    settlePromptCaches("ses_parent", "test")
    expect(PromptCaches.msgPin.has("ses_parent")).toBe(false)
    expect(PromptCaches.msgPin.get("ses_child")?.sessionID).toBe("ses_child")
    expect(PromptCaches.modelMsgs.has("ses_parent")).toBe(false)
    expect(PromptCaches.modelMsgs.get("ses_child")?.get("p/m")?.sessionID).toBe("ses_child")
    expect(PromptCaches.system.get("ses_parent")?.get("p/m")?.sessionID).toBe("ses_parent")
    expect(PromptCaches.system.get("ses_child")?.get("p/m")?.sessionID).toBe("ses_child")
    expect(PromptCaches.tools.get("ses_parent")?.sessionID).toBe("ses_parent")
    expect(PromptCaches.tools.get("ses_child")?.sessionID).toBe("ses_child")
  })
})
