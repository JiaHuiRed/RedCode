import { describe, expect, test } from "bun:test"
import { checkUpdateForWindow, installUpdateForWindow } from "./update-bridge"

describe("renderer update bridge", () => {
  test("reports disabled instead of up to date when the window has no updater", async () => {
    let called = false

    await expect(
      checkUpdateForWindow({ updaterEnabled: false }, async () => {
        called = true
        return { updateAvailable: false, status: "up-to-date" }
      }),
    ).resolves.toEqual({ updateAvailable: false, status: "disabled" })
    expect(called).toBe(false)
  })

  test("passes the main process check result through when the updater is enabled", async () => {
    await expect(
      checkUpdateForWindow({ updaterEnabled: true }, async () => ({
        updateAvailable: false,
        status: "failed",
        error: "offline",
      })),
    ).resolves.toEqual({ updateAvailable: false, status: "failed", error: "offline" })
  })

  test("reports a disabled install as skipped without calling the bridge", async () => {
    let called = false

    await expect(
      installUpdateForWindow({ updaterEnabled: false }, async () => {
        called = true
        return { status: "downloaded", version: "0.12.0" }
      }),
    ).resolves.toEqual({ status: "skipped", reason: "disabled" })
    expect(called).toBe(false)
  })

  test("passes the install result through when the updater is enabled", async () => {
    await expect(
      installUpdateForWindow({ updaterEnabled: true }, async () => ({
        status: "failed",
        reason: "download",
        error: "connection reset",
      })),
    ).resolves.toEqual({ status: "failed", reason: "download", error: "connection reset" })
  })
})
