import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ConfigMCP } from "../../src/config/mcp"
import { McpRetry } from "../../src/mcp/retry"

describe("MCP retry policy", () => {
  test("retry none fails after the first call without reconnecting", async () => {
    const error = new Error("action outcome is unknown")
    let calls = 0
    let reconnects = 0

    const result = await McpRetry.run({
      mode: "none",
      call: async () => {
        calls += 1
        throw error
      },
      reconnect: async () => {
        reconnects += 1
      },
      delay: async () => {},
    }).then(
      () => undefined,
      (cause) => cause,
    )

    expect(result).toBe(error)
    expect(calls).toBe(1)
    expect(reconnects).toBe(0)
  })

  test("default mode preserves three attempts and two reconnects", async () => {
    let calls = 0
    let reconnects = 0

    const result = await McpRetry.run({
      call: async () => {
        calls += 1
        throw new Error("temporary transport failure")
      },
      reconnect: async () => {
        reconnects += 1
      },
      delay: async () => {},
    }).then(
      () => undefined,
      (cause) => cause,
    )

    expect(result).toBeInstanceOf(Error)
    expect(calls).toBe(3)
    expect(reconnects).toBe(2)
  })

  test("an already aborted signal skips the first attempt and reconnect", async () => {
    const controller = new AbortController()
    const reason = new DOMException("Aborted", "AbortError")
    controller.abort(reason)
    let calls = 0
    let reconnects = 0

    const result = await McpRetry.run({
      signal: controller.signal,
      call: async () => {
        calls += 1
        throw new Error("must not call")
      },
      reconnect: async () => {
        reconnects += 1
      },
    }).then(
      () => undefined,
      (cause) => cause,
    )

    expect(result).toBe(reason)
    expect(calls).toBe(0)
    expect(reconnects).toBe(0)
  })

  test("an abort after a failed call skips reconnect and the next attempt", async () => {
    const controller = new AbortController()
    const reason = new DOMException("Aborted", "AbortError")
    let calls = 0
    let reconnects = 0

    const result = await McpRetry.run({
      signal: controller.signal,
      call: async () => {
        calls += 1
        controller.abort(reason)
        throw new Error("transport failure")
      },
      reconnect: async () => {
        reconnects += 1
      },
      delay: async () => {},
    }).then(
      () => undefined,
      (cause) => cause,
    )

    expect(result).toBe(reason)
    expect(calls).toBe(1)
    expect(reconnects).toBe(0)
  })

  test("an abort during backoff prevents the next attempt", async () => {
    const controller = new AbortController()
    const reason = new DOMException("Aborted", "AbortError")
    let calls = 0
    let reconnects = 0
    let signalObserved: AbortSignal | undefined
    let resolveDelayStarted!: () => void
    const delayStarted = new Promise<void>((resolve) => {
      resolveDelayStarted = resolve
    })

    const task = McpRetry.run({
      signal: controller.signal,
      call: async () => {
        calls += 1
        throw new Error("temporary transport failure")
      },
      reconnect: async () => {
        reconnects += 1
      },
      delay: async (_milliseconds, signal) => {
        signalObserved = signal
        resolveDelayStarted()
        if (!signal) return
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      },
    }).then(
      () => undefined,
      (cause) => cause,
    )

    await delayStarted
    controller.abort(reason)
    const result = await task

    expect(signalObserved).toBe(controller.signal)
    expect(result).toBe(reason)
    expect(calls).toBe(1)
    expect(reconnects).toBe(1)
  })

  test("MCP config accepts retry none for an observe-only server", () => {
    const config = Schema.decodeUnknownSync(ConfigMCP.Info)({
      type: "local",
      command: ["cua-driver-mcp"],
      retry: "none",
      tools: ["computer_observe", "computer_status"],
    })

    expect(config.retry).toBe("none")
    expect(config.tools).toEqual(["computer_observe", "computer_status"])
  })
})
