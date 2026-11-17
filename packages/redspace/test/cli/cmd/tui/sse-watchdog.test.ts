import { describe, expect, test } from "bun:test"
import { createSseWatchdog } from "../../../../src/cli/cmd/tui/context/sdk"

describe("sse watchdog", () => {
  test("stays silent inside the timeout and fires once the connection goes stale", async () => {
    let stale = 0
    const watchdog = createSseWatchdog({ timeout: 60, interval: 10, onStale: () => stale++ })
    await Bun.sleep(40)
    expect(stale).toBe(0)
    await Bun.sleep(50)
    expect(stale).toBeGreaterThan(0)
    watchdog.stop()
  })

  test("continuous events keep the connection alive", async () => {
    let stale = 0
    const watchdog = createSseWatchdog({ timeout: 60, interval: 10, onStale: () => stale++ })
    // heartbeat cadence: an event every 30ms must never trip a 60ms timeout
    for (let i = 0; i < 10; i++) {
      await Bun.sleep(30)
      watchdog.touch()
    }
    expect(stale).toBe(0)
    watchdog.stop()
  })

  test("stop prevents further callbacks", async () => {
    let stale = 0
    const watchdog = createSseWatchdog({ timeout: 30, interval: 10, onStale: () => stale++ })
    await Bun.sleep(60)
    const fired = stale
    expect(fired).toBeGreaterThan(0)
    watchdog.stop()
    await Bun.sleep(60)
    expect(stale).toBe(fired)
  })
})
