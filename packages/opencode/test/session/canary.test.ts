import { describe, expect, test } from "bun:test"
import { Canary } from "../../src/session/canary"

describe("session.canary", () => {
  test("get returns RC- followed by 8 hex chars", () => {
    const token = Canary.get("s1")
    expect(token).toMatch(/^RC-[0-9a-f]{16}$/)
  })

  test("same session gets same token", () => {
    const a = Canary.get("s1")
    const b = Canary.get("s1")
    expect(a).toBe(b)
  })

  test("different sessions get different tokens", () => {
    const a = Canary.get("s1")
    const b = Canary.get("s2")
    expect(a).not.toBe(b)
  })

  test("check returns true for matching token", () => {
    const token = Canary.get("s1")
    expect(Canary.check(`contains ${token} here`, "s1")).toBe(true)
  })

  test("check is case-insensitive", () => {
    const token = Canary.get("s1")
    expect(Canary.check(token.toUpperCase(), "s1")).toBe(true)
  })

  test("check returns false for wrong session", () => {
    Canary.get("s1")
    expect(Canary.check("RC-deadbeef", "s2")).toBe(false)
  })

  test("token is stable across calls (deterministic derivation)", () => {
    const a = Canary.get("s-stable")
    const b = Canary.get("s-stable")
    expect(a).toBe(b)
    expect(Canary.check(a, "s-stable")).toBe(true)
  })
})
