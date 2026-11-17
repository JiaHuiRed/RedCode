import { describe, expect, test } from "bun:test"
import { ConfigToolInputGuard } from "../../src/config/tool-input-guard"

describe("tool input guard config", () => {
  test("resolves defaults and explicit values", () => {
    expect(ConfigToolInputGuard.resolve()).toEqual({ maxPendingCalls: 64, idleMs: 120_000 })
    expect(ConfigToolInputGuard.resolve({ maxPendingCalls: 8, idleMs: 30_000 })).toEqual({
      maxPendingCalls: 8,
      idleMs: 30_000,
    })
  })

  test("rejects values outside the supported bounds", () => {
    expect(() => ConfigToolInputGuard.resolve({ maxPendingCalls: 0 })).toThrow()
    expect(() => ConfigToolInputGuard.resolve({ maxPendingCalls: 4097 })).toThrow()
    expect(() => ConfigToolInputGuard.resolve({ idleMs: 999 })).toThrow()
    expect(() => ConfigToolInputGuard.resolve({ idleMs: 1_800_001 })).toThrow()
  })
})
