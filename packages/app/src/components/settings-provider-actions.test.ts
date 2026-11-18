import { describe, expect, test } from "bun:test"
import { disconnectSettingsProvider, ProviderRefreshError } from "./settings-provider-actions"

describe("settings provider disconnect", () => {
  test("failed credential removal keeps the server running and rejects the action", async () => {
    const steps: string[] = []
    await expect(
      disconnectSettingsProvider({
        configured: false,
        disable: async () => {
          steps.push("disable")
        },
        removeCredentials: async () => {
          throw new Error("Could not remove credentials")
        },
        refresh: async () => {
          steps.push("refresh")
        },
      }),
    ).rejects.toThrow("Could not remove credentials")
    expect(steps).toEqual([])
  })

  test("identifies a failed refresh after successful credential removal", async () => {
    const result = await disconnectSettingsProvider({
      configured: false,
      disable: async () => {
        throw new Error("Unexpected config change")
      },
      removeCredentials: async () => true,
      refresh: async () => {
        throw new Error("Server did not respond")
      },
    }).catch((error: unknown) => error)
    expect(result).toBeInstanceOf(ProviderRefreshError)
    expect((result as Error).message).toBe("Server did not respond")
  })

  test("does not remove credentials when a configured provider could not be disabled", async () => {
    const steps: string[] = []
    await expect(
      disconnectSettingsProvider({
        configured: true,
        disable: async () => {
          throw new Error("Config is read-only")
        },
        removeCredentials: async () => {
          steps.push("remove")
        },
        refresh: async () => {
          steps.push("refresh")
        },
      }),
    ).rejects.toThrow("Config is read-only")
    expect(steps).toEqual([])
  })
})
