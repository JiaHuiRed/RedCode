import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Config } from "../../src/config/config"
import { SessionChanges } from "../../src/session/changes"

describe("session_changes config", () => {
  test("resolves bounded defaults and explicit values", () => {
    expect(SessionChanges.resolve()).toEqual({
      enabled: true,
      max_events_per_session: 256,
      max_total_events: 10_000,
      retention_ms: 86_400_000,
      page_size: 64,
    })
    const decoded = Schema.decodeUnknownSync(Config.Info)({
      session_changes: {
        enabled: false,
        max_events_per_session: 50,
        max_total_events: 500,
        retention_ms: 60_000,
        page_size: 32,
      },
    })
    expect(SessionChanges.resolve(decoded.session_changes)).toMatchObject({
      enabled: false,
      max_events_per_session: 50,
      max_total_events: 500,
      retention_ms: 60_000,
      page_size: 32,
    })
  })

  test("rejects invalid bounds and page sizes above the wire cap", () => {
    expect(() => Schema.decodeUnknownSync(Config.Info)({ session_changes: { max_total_events: 0 } })).toThrow()
    expect(() => Schema.decodeUnknownSync(Config.Info)({ session_changes: { page_size: 257 } })).toThrow()
  })
})
