import { describe, expect, test } from "bun:test"
import { waitForSidecarHealth } from "./server-health"

describe("sidecar health contract", () => {
  test("resolves only after a health probe succeeds", async () => {
    let now = 0
    let checks = 0

    await waitForSidecarHealth({
      timeoutMs: 250,
      check: async () => ++checks >= 2,
      now: () => now,
      sleep: async (ms) => {
        now += ms
      },
    })

    expect(checks).toBe(2)
  })

  test("rejects when the health deadline expires", async () => {
    let now = 0

    await expect(
      waitForSidecarHealth({
        timeoutMs: 250,
        check: async () => false,
        now: () => now,
        sleep: async (ms) => {
          now += ms
        },
      }),
    ).rejects.toThrow("Sidecar health check timed out after 250ms")
  })

  test("rejects when the sidecar exits before becoming healthy", async () => {
    let now = 0
    let exited = false

    await expect(
      waitForSidecarHealth({
        timeoutMs: 250,
        check: async () => false,
        getFailure: () => (exited ? new Error("sidecar exited") : undefined),
        now: () => now,
        sleep: async (ms) => {
          exited = true
          now += ms
        },
      }),
    ).rejects.toThrow("sidecar exited")
  })
})
