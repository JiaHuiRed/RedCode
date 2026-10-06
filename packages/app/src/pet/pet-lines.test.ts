import { describe, expect, it } from "bun:test"
import type { PetDisplay } from "./pet-state"
import {
  advancePetPresentation,
  createPetPresentation,
  IDLE_ACTION_LINES,
  LINES,
  pickLine,
  resolvePetBehavior,
  shouldChatter,
} from "./pet-lines"

describe("pet-lines", () => {
  // 全部展示姿态与闲时动作都必须有非空台词池——漏池会让 pickLine 返回 undefined
  const KINDS: PetDisplay["kind"][] = [
    "idle",
    "thinking",
    "coding",
    "searching",
    "tool",
    "waiting",
    "permission",
    "compacting",
    "success",
    "error",
  ]

  it("every display kind has a non-empty line pool", () => {
    for (const kind of KINDS) {
      expect(LINES[kind].length).toBeGreaterThan(0)
      for (const line of LINES[kind]) expect(line.trim().length).toBeGreaterThan(0)
    }
    for (const pool of Object.values(IDLE_ACTION_LINES)) expect(pool.length).toBeGreaterThan(0)
  })

  it("pickLine returns a pool member", () => {
    const pool = ["a", "b", "c"]
    expect(pickLine(pool, () => 0)).toBe("a")
    expect(pickLine(pool, () => 0.999)).toBe("c")
  })

  it("pickLine avoids the previous line when the pool allows", () => {
    // rand=0 → 取候选第一项；avoid "a" 时候选从 "b" 起
    expect(pickLine(["a", "b", "c"], () => 0, "a")).toBe("b")
    // 池只有一句时避无可避，仍然返回它
    expect(pickLine(["only"], () => 0, "only")).toBe("only")
  })

  it("shouldChatter is deterministic for reminder kinds and silent on idle", () => {
    for (const kind of ["permission", "waiting", "success", "error"] as const) {
      expect(shouldChatter(kind, 0, () => 0.999)).toBe(true)
    }
    expect(shouldChatter("idle", 1, () => 0)).toBe(false)
  })

  it("shouldChatter gates activity kinds by chance", () => {
    expect(shouldChatter("thinking", 0.3, () => 0)).toBe(true)
    expect(shouldChatter("thinking", 0.3, () => 0.29)).toBe(true)
    expect(shouldChatter("thinking", 0.3, () => 0.31)).toBe(false)
    expect(shouldChatter("thinking", 0, () => 0)).toBe(false)
  })
})

describe("pet presentation", () => {
  const behavior = resolvePetBehavior({ activityChatterChance: 1, idleActionChance: 1, coffeeChance: 1 })

  it("keeps reminder text stable without drawing again on heartbeats", () => {
    const state = createPetPresentation()
    let draws = 0
    const rand = () => {
      draws++
      return 0
    }
    advancePetPresentation(state, "permission", true, 0, behavior, rand)
    const line = state.line
    for (let now = 1_000; now <= 120_000; now += 1_000)
      advancePetPresentation(state, "permission", true, now, behavior, rand)
    expect(state.line).toBe(line)
    expect(draws).toBe(1)
  })

  it("does not retry a missed activity chatter roll on later ticks", () => {
    const state = createPetPresentation()
    let draws = 0
    const quiet = resolvePetBehavior({ activityChatterChance: 0 })
    const rand = () => {
      draws++
      return 0
    }
    advancePetPresentation(state, "thinking", true, 0, quiet, rand)
    advancePetPresentation(state, "thinking", true, 45_000, quiet, rand)
    expect(state.line).toBeUndefined()
    expect(draws).toBe(1)
  })

  it("expires activity text without retriggering it in the same pose", () => {
    const state = createPetPresentation()
    advancePetPresentation(state, "coding", true, 0, behavior, () => 0)
    expect(state.line?.text).toBe(LINES.coding[0])
    advancePetPresentation(state, "coding", true, behavior.chatterMs - 1, behavior, () => 0)
    expect(state.line).toBeDefined()
    advancePetPresentation(state, "coding", true, behavior.chatterMs, behavior, () => 0)
    expect(state.line).toBeUndefined()
    advancePetPresentation(state, "coding", true, 120_000, behavior, () => 0)
    expect(state.line).toBeUndefined()
  })

  it("respects activity cooldown but never suppresses reminders", () => {
    const state = createPetPresentation()
    advancePetPresentation(state, "thinking", true, 0, behavior, () => 0)
    advancePetPresentation(state, "coding", true, 1_000, behavior, () => 0)
    expect(state.line).toBeUndefined()
    advancePetPresentation(state, "waiting", true, 2_000, behavior, () => 0)
    expect(state.line?.text).toBe(LINES.waiting[0])
    advancePetPresentation(state, "searching", true, 46_999, behavior, () => 0)
    expect(state.line).toBeUndefined()
    advancePetPresentation(state, "coding", true, 47_000, behavior, () => 0)
    expect(state.line?.text).toBe(LINES.coding[0])
  })

  it("requires continuous idle time before a coffee action", () => {
    const state = createPetPresentation()
    advancePetPresentation(state, "thinking", true, 0, behavior, () => 0)
    advancePetPresentation(state, "idle", true, 24_000, behavior, () => 0)
    advancePetPresentation(state, "idle", true, 25_000, behavior, () => 0)
    expect(state.action).toBeUndefined()
    advancePetPresentation(state, "idle", true, 24_000 + behavior.idleIntervalMs, behavior, () => 0)
    expect(state.action).toBe("coffee")
    expect(state.line?.text).toBe(IDLE_ACTION_LINES.coffee[0])
  })

  it("ends an idle action and bubble together", () => {
    const state = createPetPresentation()
    advancePetPresentation(state, "idle", true, 0, behavior, () => 0)
    advancePetPresentation(state, "idle", true, behavior.idleIntervalMs, behavior, () => 0)
    advancePetPresentation(
      state, "idle", true, behavior.idleIntervalMs + behavior.idleActionMs, behavior, () => 0,
    )
    expect(state.action).toBeUndefined()
    expect(state.line).toBeUndefined()
  })

  it("interrupts coffee immediately and never expires the new permission bubble", () => {
    const state = createPetPresentation()
    advancePetPresentation(state, "idle", true, 0, behavior, () => 0)
    advancePetPresentation(state, "idle", true, behavior.idleIntervalMs, behavior, () => 0)
    expect(state.action).toBe("coffee")
    advancePetPresentation(state, "permission", true, behavior.idleIntervalMs + 1, behavior, () => 0)
    expect(state.action).toBeUndefined()
    expect(state.actionUntil).toBeUndefined()
    const line = state.line
    advancePetPresentation(state, "permission", true, 120_000, behavior, () => 0)
    expect(state.line).toBe(line)
  })

  it("cancels idle activity while disabled and restarts its idle deadline on reopening", () => {
    const state = createPetPresentation()
    advancePetPresentation(state, "idle", true, 0, behavior, () => 0)
    advancePetPresentation(state, "idle", true, behavior.idleIntervalMs, behavior, () => 0)
    advancePetPresentation(state, "idle", false, 26_000, behavior, () => 0)
    expect(state.action).toBeUndefined()
    expect(state.line).toBeUndefined()
    expect(state.idleDue).toBeUndefined()
    advancePetPresentation(state, "idle", true, 120_000, behavior, () => 0)
    expect(state.action).toBeUndefined()
    expect(state.idleDue).toBe(120_000 + behavior.idleIntervalMs)
  })

  it("restores sticky text on reopening during the same permission state", () => {
    const state = createPetPresentation()
    advancePetPresentation(state, "permission", true, 0, behavior, () => 0)
    advancePetPresentation(state, "permission", false, 1_000, behavior, () => 0)
    expect(state.line).toBeUndefined()
    advancePetPresentation(state, "permission", true, 2_000, behavior, () => 0)
    expect(state.line).toBeDefined()
    expect(state.line?.until).toBeUndefined()
  })

  it("supports chatter-only idle actions and a disabled idle probability", () => {
    const state = createPetPresentation()
    const chatter = resolvePetBehavior({ idleActionChance: 1, coffeeChance: 0 })
    advancePetPresentation(state, "idle", true, 0, chatter, () => 0)
    advancePetPresentation(state, "idle", true, chatter.idleIntervalMs, chatter, () => 0)
    expect(state.action).toBe("chatter")
    const silent = resolvePetBehavior({ idleActionChance: 0 })
    const quiet = createPetPresentation()
    advancePetPresentation(quiet, "idle", true, 0, silent, () => 0)
    advancePetPresentation(quiet, "idle", true, silent.idleIntervalMs, silent, () => 0)
    expect(quiet.action).toBeUndefined()
    expect(quiet.line).toBeUndefined()
  })
})

describe("pet behavior settings", () => {
  it("fills missing legacy settings and honors overrides", () => {
    expect(resolvePetBehavior().idleIntervalMs).toBe(25_000)
    expect(resolvePetBehavior({ coffeeChance: 0, idleIntervalMs: 10_000 })).toMatchObject({
      coffeeChance: 0, idleIntervalMs: 10_000,
    })
  })

  it("rejects invalid probabilities and timer values", () => {
    for (const value of [-1, 1.1, NaN, Infinity])
      expect(() => resolvePetBehavior({ idleActionChance: value })).toThrow("general.petBehavior.idleActionChance")
    for (const value of [0, -1, 999, Infinity, 86_400_001])
      expect(() => resolvePetBehavior({ idleIntervalMs: value })).toThrow("general.petBehavior.idleIntervalMs")
  })

  it("rejects malformed persisted objects and misspelled fields", () => {
    for (const json of ["null", "[]", "42", "true", '{"idleIntervaMs":25000}'])
      expect(() => resolvePetBehavior(JSON.parse(json))).toThrow("general.petBehavior")
  })
})
