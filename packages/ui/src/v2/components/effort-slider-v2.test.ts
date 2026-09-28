import { describe, expect, test } from "bun:test"
import { availableEffortSteps, selectedEffortIndex } from "./effort-slider-v2"

describe("effort slider steps", () => {
  test("keeps the model's real tiers and does not add a default stop", () => {
    const glm = availableEffortSteps(["none", "high", "max"])
    const openai = availableEffortSteps(["minimal", "low", "medium", "high", "xhigh"])

    expect(glm).toEqual(["none", "high", "max"])
    expect(glm).toHaveLength(3)
    expect(openai).toEqual(["minimal", "low", "medium", "high", "xhigh"])
    expect(openai).toHaveLength(5)
  })

  test("filters the legacy default sentinel", () => {
    expect(availableEffortSteps(["default", "low", "high"])).toEqual(["low", "high"])
    expect(availableEffortSteps(["default"])).toEqual([])
    expect(availableEffortSteps(["low"])).toEqual(["low"])
  })

  test("keeps an unset model choice unselected", () => {
    const steps = availableEffortSteps(["low", "high", "max"])

    expect(selectedEffortIndex(steps, undefined)).toBe(-1)
    expect(selectedEffortIndex(steps, "default")).toBe(-1)
    expect(selectedEffortIndex(steps, "high")).toBe(1)
  })
})
