import { describe, expect, test } from "bun:test"
import {
  capabilitySet,
  capabilityDenied,
  capabilityForTool,
  effectiveCapabilities,
  isCapabilityAllowed,
  type ChildCapability,
} from "../../src/tool/capability"

describe("child capability policy", () => {
  test("intersects parent authority, profile capabilities, and packet scope", () => {
    const parent = capabilitySet(["read", "search", "write", "shell", "task"])
    const requested = capabilitySet(["read", "search", "write", "shell"])

    expect([...effectiveCapabilities({ parent, profile: "explore", requested })]).toEqual(["read", "search"])
  })

  test("explore cannot acquire mutation, shell, or nested delegation", () => {
    const capabilities = effectiveCapabilities({
      parent: capabilitySet(["read", "search", "write", "shell", "task", "commit", "push"]),
      profile: "explore",
      requested: capabilitySet(["read", "write", "shell", "task", "commit", "push"]),
    })

    for (const capability of ["write", "shell", "task", "commit", "push"] as ChildCapability[]) {
      expect(isCapabilityAllowed(capabilities, capability)).toBe(false)
    }
    expect(isCapabilityAllowed(capabilities, "read")).toBe(true)
  })

  test("execute remains bounded by parent authority and requested scope", () => {
    const capabilities = effectiveCapabilities({
      parent: capabilitySet(["read", "search", "write"]),
      profile: "execute",
      requested: capabilitySet(["read", "write", "shell", "task"]),
    })

    expect([...capabilities]).toEqual(["read", "write"])
    expect(isCapabilityAllowed(capabilities, "shell")).toBe(false)
    expect(isCapabilityAllowed(capabilities, "task")).toBe(false)
  })

  test("unknown capability names are not allowed", () => {
    const capabilities = effectiveCapabilities({
      parent: capabilitySet(["read"]),
      profile: "explore",
      requested: capabilitySet(["read", "unknown" as ChildCapability]),
    })

    expect(isCapabilityAllowed(capabilities, "unknown" as ChildCapability)).toBe(false)
  })

  test("hard denies further narrow an otherwise permitted profile", () => {
    const capabilities = effectiveCapabilities({
      parent: capabilitySet(["read", "search", "write", "shell"]),
      profile: "execute",
      requested: capabilitySet(["read", "write", "shell"]),
      hardDeny: capabilitySet(["shell"]),
    })

    expect([...capabilities]).toEqual(["read", "write"])
  })

  test("maps known read tools and rejects unknown tools for explore", () => {
    expect(capabilityForTool("read")).toBe("read")
    expect(capabilityForTool("jcodemunch_search_text")).toBe("search")
    expect(capabilityForTool("mcp__unknown__click")).toBeUndefined()
    expect(capabilityDenied("explore", "grep")).toBeUndefined()
    expect(capabilityDenied("explore", "bash")).toContain("not available")
    expect(capabilityDenied("explore", "mcp__unknown__click")).toContain("not available")
  })
})
