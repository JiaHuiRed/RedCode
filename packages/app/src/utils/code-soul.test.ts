import { describe, expect, test } from "bun:test"
import { chooseCodeSoul } from "./code-soul"

describe("Code Soul defaults", () => {
  const souls = [{ id: "partner" }, { id: "review" }, { id: "build" }]
  const companions = [{ soulID: "partner" }]
  test("keeps a saved Code choice before the server default", () => {
    expect(chooseCodeSoul({ souls, companions, saved: "review", serverDefault: "build" })).toBe("review")
  })
  test("a saved Chat identity falls back to a valid Code default", () => {
    expect(chooseCodeSoul({ souls, companions, saved: "partner", serverDefault: "build" })).toBe("build")
  })
  test("a Chat server default falls back to the first Code identity", () => {
    expect(chooseCodeSoul({ souls, companions, saved: "missing", serverDefault: "partner" })).toBe("review")
  })
  test("a registry with only the companion uses built-in Code behavior without inventing a Soul", () => {
    expect(
      chooseCodeSoul({ souls: [{ id: "partner" }], companions, saved: "partner", serverDefault: "partner" }),
    ).toBeUndefined()
    expect(chooseCodeSoul({ souls: [], companions: [] })).toBeUndefined()
  })
})
