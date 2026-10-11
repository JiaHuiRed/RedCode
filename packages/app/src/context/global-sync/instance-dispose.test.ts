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

  test("失败后冷却内不重发，冷却结束后恢复重试", async () => {
    let attempts = 0
    const dispose = createInstanceDisposer({
      dispose: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("network failure")
      },
      retryCooldownMs: 50,
    })

    await dispose("C:/tmp/demo")
    await dispose("C:/tmp/demo")
    expect(attempts).toBe(1)

    await new Promise((resolve) => setTimeout(resolve, 60))
    await dispose("C:/tmp/demo")
    expect(attempts).toBe(2)
  })

  test("并发 dispose 串行执行（不批量占满同 host 连接槽）", async () => {
    const started: string[] = []
    let inFlight = 0
    let maxInFlight = 0
    const gates = new Map<string, () => void>()
    const dispose = createInstanceDisposer({
      dispose: (directory) => {
        started.push(directory)
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        return new Promise<void>((resolve) => {
          gates.set(directory, () => {
            inFlight -= 1
            resolve()
          })
        })
      },
    })
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

    const first = dispose("C:/a")
    const second = dispose("C:/b")
    const third = dispose("C:/c")
    await tick()
    expect(started).toEqual(["C:/a"])

    gates.get("C:/a")?.()
    await tick()
    expect(started).toEqual(["C:/a", "C:/b"])

    gates.get("C:/b")?.()
    await tick()
    expect(started).toEqual(["C:/a", "C:/b", "C:/c"])

    gates.get("C:/c")?.()
    await Promise.all([first, second, third])
    expect(started).toEqual(["C:/a", "C:/b", "C:/c"])
    expect(maxInFlight).toBe(1)
  })

  test("一个目录失败不阻塞后续目录", async () => {
    const calls: string[] = []
    const dispose = createInstanceDisposer({
      dispose: async (directory) => {
        calls.push(directory)
        if (directory === "C:/bad") throw new Error("boom")
      },
    })

    await dispose("C:/bad")
    await dispose("C:/ok")

    expect(calls).toEqual(["C:/bad", "C:/ok"])
  })
})
