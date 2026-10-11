import { describe, expect, test } from "bun:test"
import {
  capabilitySet,
  capabilityDenied,
  capabilityDeniedForSet,
  capabilityForTool,
  effectiveCapabilities,
  isCapabilityAllowed,
  type ChildCapability,
} from "../../src/tool/capability"

describe("child capability policy", () => {
  test("intersects parent authority, profile capabilities, and packet scope", () => {
    const parent = capabilitySet(["read", "search", "write", "shell", "task"])
    const requested = capabilitySet(["read", "search", "write", "shell"])

    expect([...effectiveCapabilities({ parent, profile: "explore", requested })]).toEqual(["read", "search", "shell"])
  })

  test("explore cannot acquire mutation or nested delegation", () => {
    const capabilities = effectiveCapabilities({
      parent: capabilitySet(["read", "search", "write", "shell", "task", "commit", "push"]),
      profile: "explore",
      requested: capabilitySet(["read", "write", "shell", "task", "commit", "push"]),
    })

    for (const capability of ["write", "task", "commit", "push"] as ChildCapability[]) {
      expect(isCapabilityAllowed(capabilities, capability)).toBe(false)
    }
    // 261011 Red explore 含 shell（bash 进工具表），命令面由 md 白名单收口，本层只做粗粒度开关
    expect(isCapabilityAllowed(capabilities, "shell")).toBe(true)
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
    // 261011 Red bash（shell capability）进 explore 集合后 profile 层放行；命令面白名单在 permission 层
    expect(capabilityDenied("explore", "bash")).toBeUndefined()
    expect(capabilityDenied("explore", "mcp__unknown__click")).toContain("not available")
  })

  test("enforces the canonical capability set instead of the profile name", () => {
    const capabilities = capabilitySet(["read"])

    expect(capabilityDeniedForSet(capabilities, "read")).toBeUndefined()
    expect(capabilityDeniedForSet(capabilities, "grep")).toContain("not available")
  })
})
