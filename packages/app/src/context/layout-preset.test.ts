import { describe, expect, test } from "bun:test"
import { LAYOUT_PRESETS, presetPlan } from "./layout-preset"

describe("presetPlan", () => {
  test("focus collapses both side panels and leaves the workbench alone", () => {
    expect(presetPlan("focus")).toEqual({ fileTree: false, reviewPanel: false })
  })

  test("build opens the tree and docks the workbench on the context tab", () => {
    expect(presetPlan("build")).toEqual({
      fileTree: true,
      reviewPanel: true,
      workbench: "docked",
      tab: "context",
    })
  })

  test("review trades the tree for diff width and lands on the review tab", () => {
    expect(presetPlan("review")).toEqual({
      fileTree: false,
      reviewPanel: true,
      workbench: "docked",
      tab: "review",
    })
  })

  test("every exported preset has a plan", () => {
    expect(LAYOUT_PRESETS).toEqual(["focus", "build", "review"])
    for (const preset of LAYOUT_PRESETS) expect(presetPlan(preset)).toBeDefined()
  })
})
