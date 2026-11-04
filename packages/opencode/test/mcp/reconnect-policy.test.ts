import { describe, expect, test } from "bun:test"
import { McpReconnectPolicy } from "../../src/mcp/reconnect-policy"

describe("MCP reconnect policy", () => {
  test("starts at attempt 1 without a budget", () => {
    expect(McpReconnectPolicy.decide({ budget: undefined, now: 1_000 })).toEqual({ type: "connect", attempt: 1 })
  })

  test("backoff doubles from 500ms and caps at 30s", () => {
    expect(McpReconnectPolicy.delayFor(1)).toBe(500)
    expect(McpReconnectPolicy.delayFor(2)).toBe(1_000)
    expect(McpReconnectPolicy.delayFor(3)).toBe(2_000)
    expect(McpReconnectPolicy.delayFor(6)).toBe(16_000)
    expect(McpReconnectPolicy.delayFor(7)).toBe(30_000)
    expect(McpReconnectPolicy.delayFor(9)).toBe(30_000)
  })

  test("waits until the backoff deadline", () => {
    expect(McpReconnectPolicy.decide({ budget: { failures: 1, nextAt: 2_000 }, now: 1_000 })).toEqual({
      type: "wait",
      waitMs: 1_000,
    })
    expect(McpReconnectPolicy.decide({ budget: { failures: 1, nextAt: 2_000 }, now: 2_000 })).toEqual({
      type: "connect",
      attempt: 2,
    })
  })

  test("exhausts after ten failures", () => {
    expect(McpReconnectPolicy.decide({ budget: { failures: 10, nextAt: 0 }, now: 0 })).toEqual({ type: "exhausted" })
  })

  test("a connection stable for 30s resets the budget", () => {
    expect(
      McpReconnectPolicy.decide({
        budget: { failures: 9, nextAt: 0, connectedAt: 1_000 },
        now: 1_000 + McpReconnectPolicy.STABLE_MS,
      }),
    ).toEqual({ type: "connect", attempt: 1 })
  })

  test("a flapping connection keeps its accumulated failures", () => {
    expect(
      McpReconnectPolicy.decide({
        budget: { failures: 3, nextAt: 0, connectedAt: 1_000 },
        now: 1_000 + McpReconnectPolicy.STABLE_MS - 1,
      }),
    ).toEqual({ type: "connect", attempt: 4 })
  })
})
