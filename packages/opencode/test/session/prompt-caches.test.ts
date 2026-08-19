import { describe, expect, test } from "bun:test"
import { dropSession, PromptCaches, settlePromptCaches, touchSession } from "../../src/session/prompt-caches"

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

  // 260819 cc audit：会话维度回收。此前四个 Map 只增不减——settle 只管 msgPin/modelMsgs，
  // system/tools 无删除点，全仓也没人订阅 Session.Event.Deleted 清缓存。
  describe("冷会话回收", () => {
    const HOUR = 60 * 60 * 1000

    function fresh() {
      for (const m of [PromptCaches.system, PromptCaches.msgPin, PromptCaches.modelMsgs, PromptCaches.tools]) m.clear()
      PromptCaches.seen.clear()
    }

    test("dropSession 四个缓存一起摘干净（settle 只摘两个）", () => {
      fresh()
      seed("ses_x")
      expect(dropSession("ses_x")).toBe(4)
      expect(PromptCaches.msgPin.has("ses_x")).toBe(false)
      expect(PromptCaches.modelMsgs.has("ses_x")).toBe(false)
      expect(PromptCaches.system.has("ses_x")).toBe(false)
      expect(PromptCaches.tools.has("ses_x")).toBe(false)
      expect(PromptCaches.seen.has("ses_x")).toBe(false)
    })

    test("超过 TTL 的会话被回收，未超过的原样留着", () => {
      fresh()
      const t0 = 1_000_000_000_000
      seed("ses_cold")
      touchSession("ses_cold", t0)
      seed("ses_warm")
      touchSession("ses_warm", t0 + HOUR / 2)
      seed("ses_now")

      // 回收发生在「有人来 touch」的那一刻：这一轮里 ses_cold 已冷 90 分钟（超 TTL），
      // ses_warm 冷 60 分钟——恰好卡在边界上（<= TTL 判留），用来钉住边界不是 <。
      const evicted = touchSession("ses_now", t0 + HOUR * 1.5)

      expect(evicted).toEqual(["ses_cold"])
      expect(PromptCaches.system.has("ses_cold")).toBe(false)
      expect(PromptCaches.tools.has("ses_cold")).toBe(false)
      expect(PromptCaches.system.has("ses_warm")).toBe(true)
      expect(PromptCaches.system.has("ses_now")).toBe(true)
    })

    // 回收活跃会话是有代价的：丢 msgPin/modelMsgs 等于让 DCP 攒下的改写一次性生效、
    // 整条前缀从最早改写处重写。当前会话永远不能被自己的这次 touch 顺手回收掉。
    test("当前会话永不被自己触发的回收清掉", () => {
      fresh()
      const t0 = 1_000_000_000_000
      seed("ses_self")
      touchSession("ses_self", t0)
      // 隔了 10 小时再来一轮：自己虽然"最冷"，也必须留下
      const evicted = touchSession("ses_self", t0 + 10 * HOUR)
      expect(evicted).toEqual([])
      expect(PromptCaches.system.has("ses_self")).toBe(true)
      expect(PromptCaches.msgPin.has("ses_self")).toBe(true)
    })

    test("数量上限兜底：同一时刻堆到 33 个会话，最冷的被挤掉", () => {
      fresh()
      const t0 = 1_000_000_000_000
      for (let i = 0; i < 33; i++) {
        seed(`ses_${i}`)
        touchSession(`ses_${i}`, t0) // 同一时刻 => TTL 永远不触发，只能靠数量兜底
      }
      expect(PromptCaches.seen.size).toBe(32)
      expect(PromptCaches.system.has("ses_0")).toBe(false) // 最先进来的被挤掉
      expect(PromptCaches.system.has("ses_1")).toBe(true)
      expect(PromptCaches.system.has("ses_32")).toBe(true)
    })

    test("反复 touch 同一会话不会把别人挤掉", () => {
      fresh()
      const t0 = 1_000_000_000_000
      seed("ses_a")
      touchSession("ses_a", t0)
      seed("ses_b")
      for (let i = 0; i < 100; i++) touchSession("ses_b", t0 + i)
      expect(PromptCaches.seen.size).toBe(2)
      expect(PromptCaches.system.has("ses_a")).toBe(true)
    })
  })
})
