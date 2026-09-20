import { describe, expect, test } from "bun:test"
import { createInstanceDisposer } from "./instance-dispose"
import { directoryKey } from "./utils"

describe("createInstanceDisposer", () => {
  test("deduplicates normalized directories while a request is pending", async () => {
    const calls: string[] = []
    let resolve!: () => void
    const pending = new Promise<void>((next) => {
      resolve = next
    })
    const dispose = createInstanceDisposer({
      key: directoryKey,
      dispose: async (directory) => {
        calls.push(directory)
        await pending
      },
    })

    const first = dispose("C:\\tmp\\demo")
    const second = dispose("C:/tmp/demo")

    expect(second).toBe(first)
    expect(calls).toEqual([])

    resolve()
    await first
    expect(calls).toEqual(["C:\\tmp\\demo"])
  })

  test("allows a later request after the previous one completes", async () => {
    const calls: string[] = []
    const dispose = createInstanceDisposer({
      key: directoryKey,
      dispose: async (directory) => {
        calls.push(directory)
      },
    })

    await dispose("C:\\tmp\\demo")
    await dispose("C:/tmp/demo")

    expect(calls).toEqual(["C:\\tmp\\demo", "C:/tmp/demo"])
  })

  test("allows retry after a failed request", async () => {
    let attempts = 0
    const dispose = createInstanceDisposer({
      dispose: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("network failure")
      },
    })

    await dispose("C:/tmp/demo")
    await dispose("C:/tmp/demo")

    expect(attempts).toBe(2)
  })
})
