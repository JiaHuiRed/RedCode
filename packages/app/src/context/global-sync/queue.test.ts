import { describe, expect, test } from "bun:test"
import { createRefreshQueue } from "./queue"
import { directoryKey } from "./utils"

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

describe("createRefreshQueue", () => {
  test("clears queued directories by normalized key", async () => {
    const calls: string[] = []
    const queue = createRefreshQueue({
      paused: () => false,
      key: directoryKey,
      bootstrap: async () => {},
      bootstrapInstance: (directory) => {
        calls.push(directory)
      },
    })

    queue.push("C:\\tmp\\demo")
    queue.clear("C:/tmp/demo")

    await tick()

    expect(calls).toEqual([])
    queue.dispose()
  })

  test("passes the original directory to bootstrapInstance", async () => {
    const calls: string[] = []
    const queue = createRefreshQueue({
      paused: () => false,
      key: directoryKey,
      bootstrap: async () => {},
      bootstrapInstance: (directory) => {
        calls.push(directory)
      },
    })

    queue.push("C:\\tmp\\demo")

    await tick()

    expect(calls).toEqual(["C:\\tmp\\demo"])
    queue.dispose()
  })

  test("does not continue a root drain after disposal", async () => {
    let resolveBootstrap!: () => void
    let bootstrapStarted!: () => void
    const started = new Promise<void>((resolve) => {
      bootstrapStarted = resolve
    })
    const bootstrap = new Promise<void>((resolve) => {
      resolveBootstrap = resolve
    })
    let instanceCalls = 0
    const queue = createRefreshQueue({
      paused: () => false,
      bootstrap: () => {
        bootstrapStarted()
        return bootstrap
      },
      bootstrapInstance: () => {
        instanceCalls += 1
      },
    })

    queue.refresh()
    await started
    queue.dispose()
    resolveBootstrap()
    await tick()

    expect(instanceCalls).toBe(0)
  })

  test("does not process queued directories after an instance batch is disposed", async () => {
    const startedDirectories: string[] = []
    let resolveBatch!: () => void
    let resolveStarted!: () => void
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const batch = new Promise<void>((resolve) => {
      resolveBatch = resolve
    })
    const queue = createRefreshQueue({
      paused: () => false,
      bootstrap: async () => {},
      bootstrapInstance: async (directory) => {
        startedDirectories.push(directory)
        if (startedDirectories.length === 2) resolveStarted()
        await batch
      },
    })

    queue.push("A")
    queue.push("B")
    queue.push("C")
    await started
    queue.dispose()
    resolveBatch()
    await tick()

    expect(startedDirectories).toEqual(["A", "B"])
  })

  test("ignores refreshes and pushes after disposal", async () => {
    let calls = 0
    const queue = createRefreshQueue({
      paused: () => false,
      bootstrap: async () => {
        calls += 1
      },
      bootstrapInstance: async () => {
        calls += 1
      },
    })

    queue.dispose()
    queue.refresh()
    queue.push("A")
    await tick()

    expect(calls).toBe(0)
  })
})
