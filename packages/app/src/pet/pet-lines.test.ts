import { describe, expect, it } from "bun:test"
import type { PetDisplay } from "./pet-state"
import type { ProviderQuota } from "@redcode-ai/sdk/v2/client"
import {
  advancePetPresentation,
  clampPetPosition,
  clampPetPixels,
  createPetPresentation,
  IDLE_ACTION_LINES,
  LINES,
  pickLine,
  petPositionFromOffset,
  petBubblePlacement,
  petQuotaAvailable,
  petQuotaLines,
  petStatus,
  petStroke,
  petTouchIsExpired,
  resolvePetPosition,
  petTouchAt,
  petTouchResponse,
  resolvePetBehavior,
  shouldChatter,
} from "./pet-lines"

describe("pet-lines", () => {
  it("labels every live pet state instead of a fixed quota caption", () => {
    expect(petStatus("idle")).toBe("待命")
    expect(petStatus("unknown")).toBe("状态未知")
    expect(petStatus("thinking")).toBe("思考中")
    expect(petStatus("coding")).toBe("编写中")
    expect(petStatus("waiting")).toBe("等回复")
    expect(petStatus("permission")).toBe("待授权")
    expect(petStatus("success")).toBe("已完成")
    expect(petStatus("error")).toBe("出错了")
  })

  it("shows separate real quota snapshots and never invents zero for non-finite values", () => {
    const window = { usedPercent: 42.25, windowMinutes: 300, resetAfterSeconds: 0, resetAt: 0 }
    const quota: ProviderQuota = {
      providerID: "openai", accountID: "private-account", capturedAt: 1, planType: "plus",
      primary: window, secondary: { ...window, usedPercent: "NaN", windowMinutes: "Infinity" },
      reserve: { ...window, usedPercent: Infinity },
      credits: { balance: 12, has: true, unlimited: false },
    }
    const result = petQuotaLines([quota, { ...quota, accountID: "other", planType: "pro" }])
    expect(result).toHaveLength(2)
    expect(result[0]).toContain("快照 1：openai · plus")
    expect(result[0]).toContain("主窗口（300分钟）已用 42.25%")
    expect(result[0]).toContain("次窗口（时长未知）已用 未知")
    expect(result[0]).toContain("备用窗口（300分钟）已用 未知")
    expect(result[0]).not.toContain("private-account")
    expect(result[0]).toContain("Credits：有 · 非无限 · 数值 12")
    expect(result[1]).toContain("快照 2：openai · pro")
    expect(petQuotaLines([])).toEqual(["暂无订阅额度数据"])
    expect(petQuotaLines([{ providerID: "x", planType: "p", capturedAt: 0 }])[0]).toContain("无窗口用量数据")
  })

  it("shows snapshot and reset times in their actual units and omits invalid timestamps", () => {
    const capturedAt = 1_700_000_000_000
    const resetAt = 1_700_003_600
    const quota: ProviderQuota = {
      providerID: "p", planType: "plan", capturedAt,
      primary: { usedPercent: 2, windowMinutes: 60, resetAt, resetAfterSeconds: 1 },
      secondary: { usedPercent: 3, windowMinutes: 60, resetAt: "NaN", resetAfterSeconds: 1 },
    }
    const line = petQuotaLines([quota])[0]!
    expect(line).toContain(`快照时间：${new Date(capturedAt).toLocaleString()}`)
    expect(line).toContain(`重置 ${new Date(resetAt * 1_000).toLocaleString()}`)
    expect(line.match(/重置 /g)).toHaveLength(1)
    for (const invalid of [0, -1, Infinity, NaN, 9e30, "Infinity"] as const) {
      const text = petQuotaLines([{ ...quota, capturedAt: invalid, primary: { ...quota.primary!, resetAt: invalid } }])[0]!
      expect(text).not.toContain("快照时间：")
      expect(text).not.toContain("重置 ")
    }
  })

  it("reports credit flags and finite values independently without inventing missing values", () => {
    const base: ProviderQuota = { providerID: "p", planType: "plan", capturedAt: 0 }
    expect(petQuotaLines([base])[0]).not.toContain("Credits：")
    expect(petQuotaLines([{ ...base, credits: { has: false, unlimited: true, balance: 0 } }])[0])
      .toContain("Credits：无 · 无限 · 数值 0")
    for (const balance of ["NaN", "Infinity", "-Infinity", Infinity, NaN] as const)
      expect(petQuotaLines([{ ...base, credits: { has: true, unlimited: false, balance } }])[0])
        .toContain("Credits：有 · 非无限 · 数值 未知")
    const missing = {} as NonNullable<ProviderQuota["credits"]>
    expect(petQuotaLines([{ ...base, credits: missing }])[0])
      .toContain("Credits：有无未知 · 是否无限未知 · 数值 未知")
  })

  it("keeps quota independently available during questions and permissions", () => {
    expect(petQuotaAvailable("permission")).toBe(true)
    expect(petQuotaAvailable("waiting")).toBe(true)
    expect(petQuotaAvailable("coding")).toBe(true)
    expect(petQuotaAvailable("idle")).toBe(true)
  })

  it("maps touch points to the visual head and belly hitboxes only", () => {
    expect(petTouchAt(0.43, 0.25)).toBe("head")
    expect(petTouchAt(0.43, 0.53)).toBe("belly")
    expect(petTouchAt(0.1, 0.1)).toBeUndefined()
    expect(petTouchAt(0.43, 0.4)).toBeUndefined()
  })

  it("limits touch responses by cooldown and never replaces important reminders", () => {
    const behavior = resolvePetBehavior()
    expect(petTouchResponse("idle", undefined, 10_000, behavior, "head")?.until).toBe(14_500)
    expect(petTouchResponse("idle", 9_000, 10_000, behavior, "belly")).toBeUndefined()
    for (const kind of ["permission", "waiting", "success", "error"] as const)
      expect(petTouchResponse(kind, undefined, 10_000, behavior, "head")).toBeUndefined()
  })

  it("normalizes and clamps pet positions to the viewport", () => {
    expect(petPositionFromOffset(400, 200, 1_000, 500)).toEqual({ x: 0.4, y: 0.4 })
    expect(clampPetPosition({ x: 0.9, y: 0.95 }, 160, 100, 1_000, 500)).toEqual({ x: 0.84, y: 0.8 })
    expect(clampPetPosition({ x: -1, y: 2 }, 160, 100, 1_000, 500)).toEqual({ x: 0, y: 0.8 })
  })

  it("clamps measured pixel positions and places bubbles from measured dimensions", () => {
    expect(clampPetPixels(900, 450, 160, 100, 1_000, 500)).toEqual({ left: 840, top: 400 })
    expect(clampPetPixels(-20, -10, 160, 100, 1_000, 500)).toEqual({ left: 0, top: 0 })
    expect(petBubblePlacement(0, 0, 160, 1_000, 280, 116)).toEqual({ placement: "below", align: "start" })
    expect(petBubblePlacement(700, 760, 160, 1_000, 280, 116)).toEqual({ placement: "above", align: "end" })
    expect(petTouchIsExpired(4_500, 4_499)).toBe(false)
    expect(petTouchIsExpired(4_500, 4_500)).toBe(true)
    expect(petStroke(500, 1_000)).toBe(1)
    expect(petStroke(-500, 1_000)).toBe(-1)
  })

  it("keeps legacy missing position as default and rejects malformed positions", () => {
    expect(resolvePetPosition(undefined)).toBeUndefined()
    expect(resolvePetPosition({ x: 0.2, y: 1 })).toEqual({ x: 0.2, y: 1 })
    for (const value of [null, [], {}, { x: NaN, y: 0.2 }, { x: 0, y: Infinity }, { x: -0.1, y: 0.2 }, { x: 0.2, y: 1.1 }])
      expect(() => resolvePetPosition(value)).toThrow("general.petPosition")
  })
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
    expect(resolvePetBehavior().touchCooldownMs).toBe(1_800)
    expect(resolvePetBehavior().touchResponseMs).toBe(4_500)
    expect(resolvePetBehavior({ coffeeChance: 0, idleIntervalMs: 10_000 })).toMatchObject({
      coffeeChance: 0, idleIntervalMs: 10_000,
    })
  })

  it("rejects invalid probabilities and timer values", () => {
    for (const value of [-1, 1.1, NaN, Infinity])
      expect(() => resolvePetBehavior({ idleActionChance: value })).toThrow("general.petBehavior.idleActionChance")
    for (const value of [0, -1, 999, Infinity, 86_400_001])
      expect(() => resolvePetBehavior({ idleIntervalMs: value })).toThrow("general.petBehavior.idleIntervalMs")
    for (const value of [0, 999, Infinity, 86_400_001])
      expect(() => resolvePetBehavior({ touchCooldownMs: value })).toThrow("general.petBehavior.touchCooldownMs")
  })

  it("rejects malformed persisted objects and misspelled fields", () => {
    for (const json of ["null", "[]", "42", "true", '{"idleIntervaMs":25000}'])
      expect(() => resolvePetBehavior(JSON.parse(json))).toThrow("general.petBehavior")
  })
})
