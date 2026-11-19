import { describe, expect, test } from "bun:test"
import { createPetHostRegistry } from "./pet-host-registry"

// 261119 Red 来源仲裁 FSM：显式激活接管、代次/序号防过期覆盖、断连交接。
const SNAPSHOT = { kind: "thinking", outfit: "openai", behavior: {
  activityChatterChance: 0, chatterCooldownMs: 1, chatterMs: 1, idleIntervalMs: 1,
  idleActionChance: 0, idleActionMs: 1, coffeeChance: 0, touchCooldownMs: 1, touchResponseMs: 1,
} } as const

function create(t0 = 1_000) {
  let now = t0
  const changes: string[] = []
  const registry = createPetHostRegistry({
    now: () => now,
    onChange: () => changes.push(registry.active()?.sourceID ?? "none"),
  })
  return {
    registry,
    tick: (ms: number) => {
      now += ms
    },
    changes,
  }
}

describe("pet host registry", () => {
  test("未激活的来源不驱动赤；激活者显式接管", () => {
    const { registry } = create()
    registry.register("gui", "gui", 1)
    registry.attach("gui")
    registry.snapshot("gui", 1, 1, SNAPSHOT)
    expect(registry.active()).toBeUndefined()
    registry.activate("gui", 1)
    expect(registry.active()?.sourceID).toBe("gui")
  })

  test("后激活的来源接管，先激活者保持快照不变", () => {
    const { registry, tick } = create()
    registry.register("gui", "gui", 1)
    registry.attach("gui")
    registry.snapshot("gui", 1, 1, { ...SNAPSHOT, kind: "coding", tool: "edit" })
    registry.activate("gui", 1)
    expect(registry.active()?.snapshot).toEqual({ ...SNAPSHOT, kind: "coding", tool: "edit" })
    tick(100)
    registry.register("tui", "tui", 1)
    registry.attach("tui")
    registry.snapshot("tui", 1, 1, { ...SNAPSHOT, kind: "idle", outfit: "default" })
    expect(registry.active()?.sourceID).toBe("gui")
    registry.activate("tui", 1)
    expect(registry.active()?.sourceID).toBe("tui")
    expect(registry.active()?.snapshot?.kind).toEqual("idle")
  })

  test("旧代次的注册/激活/快照都被拒绝", () => {
    const { registry } = create()
    registry.register("gui", "gui", 3)
    expect(registry.register("gui", "gui", 2)).toBe("stale")
    expect(registry.activate("gui", 2)).toBe(false)
    expect(registry.snapshot("gui", 2, 5, SNAPSHOT)).toBe(false)
    expect(registry.active()).toBeUndefined()
  })

  test("序号必须单调递增，过期快照不覆盖", () => {
    const { registry } = create()
    registry.register("gui", "gui", 1)
    registry.attach("gui")
    registry.activate("gui", 1)
    expect(registry.snapshot("gui", 1, 2, SNAPSHOT)).toBe(true)
    expect(registry.snapshot("gui", 1, 1, { ...SNAPSHOT, kind: "error" })).toBe(false)
    expect(registry.snapshot("gui", 1, 2, { ...SNAPSHOT, kind: "error" })).toBe(false)
    expect(registry.active()?.snapshot?.kind).toBe("thinking")
  })

  test("活跃来源断连后交接给仍激活的来源；无人激活则不显示", () => {
    const { registry, tick } = create()
    registry.register("gui", "gui", 1)
    registry.attach("gui")
    registry.snapshot("gui", 1, 1, { ...SNAPSHOT, kind: "idle" })
    registry.activate("gui", 1)
    tick(50)
    registry.register("tui", "tui", 1)
    registry.attach("tui")
    registry.snapshot("tui", 1, 1, { ...SNAPSHOT, kind: "thinking" })
    registry.activate("tui", 1)
    registry.detach("tui")
    expect(registry.active()?.sourceID).toBe("gui")
    registry.detach("gui")
    expect(registry.active()).toBeUndefined()
  })

  test("激活过的来源断连再重连，恢复其资格", () => {
    const { registry } = create()
    registry.register("gui", "gui", 1)
    registry.attach("gui")
    registry.snapshot("gui", 1, 1, SNAPSHOT)
    registry.activate("gui", 1)
    registry.detach("gui")
    expect(registry.active()).toBeUndefined()
    registry.attach("gui")
    expect(registry.active()?.sourceID).toBe("gui")
  })

  test("release 移除来源；同 ID 更新一代次重注册后可重新激活", () => {
    const { registry } = create()
    registry.register("gui", "gui", 1)
    registry.attach("gui")
    registry.release("gui")
    expect(registry.connectedCount()).toBe(0)
    registry.register("gui", "gui", 2)
    expect(registry.activate("gui", 1)).toBe(false)
    registry.attach("gui")
    registry.activate("gui", 2)
    expect(registry.active()?.sourceID).toBe("gui")
  })

  test("onChange 只在显示可能变化时触发（attach/activate/snapshot/detach）", () => {
    const { changes, registry } = create()
    registry.register("gui", "gui", 1)
    expect(changes).toHaveLength(1)
    registry.attach("gui")
    registry.snapshot("gui", 1, 1, SNAPSHOT)
    registry.activate("gui", 1)
    registry.detach("gui")
    // register + attach + snapshot + activate + detach = 5 次
    expect(changes).toHaveLength(5)
  })

  test("onActivate 在 onChange 之前触发，且仅成功激活时触发（宿主靠它清 close latch）", () => {
    const order: string[] = []
    const registry = createPetHostRegistry({
      now: () => 1_000,
      onActivate: () => order.push("activate"),
      onChange: () => order.push("change"),
    })
    registry.register("gui", "gui", 1)
    expect(registry.activate("gui", 9)).toBe(false)
    expect(order).toEqual(["change"]) // register 的 change；失败激活不触发 onActivate
    order.length = 0
    registry.activate("gui", 1)
    expect(order).toEqual(["activate", "change"])
  })
})
