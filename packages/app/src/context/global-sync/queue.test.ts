import { describe, expect, test } from "bun:test"
import { createRefreshQueue } from "./queue"
import { directoryKey } from "./utils"

const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

// 261011 Red: Windows 定时器粒度 ~15ms，重试要多轮 setTimeout(0)，固定短等待不可靠。
const waitFor = async (predicate: () => boolean, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

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

  // 261011 Red B1-a: 单目录 reject 此前会中断整批（Promise.all 逃逸）+ 失败目录从
  // queued 消失且无人记录。以下四例按审计文档 §2.2 的失败注入清单补回归。
  test("isolates a rejected directory: siblings still run, retries are bounded, failure is recorded", async () => {
    const calls: string[] = []
    const failures: Array<{ directory: string | undefined; error: unknown }> = []
    const queue = createRefreshQueue({
      paused: () => false,
      key: directoryKey,
      bootstrap: async () => {},
      bootstrapInstance: async (directory) => {
        calls.push(directory)
        if (directory === "A") throw new Error("boom")
      },
      onFail: (directory, error) => failures.push({ directory, error }),
    })

    queue.push("A")
    queue.push("B")
    queue.push("C")
    await waitFor(() => failures.length > 0)

    expect(calls).toContain("B")
    expect(calls).toContain("C")
    expect(calls.filter((directory) => directory === "A")).toHaveLength(3)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.directory).toBe("A")
    expect(failures[0]?.error).toBeInstanceOf(Error)
    queue.dispose()
  })

  test("a transient failure is retried and succeeds without parking", async () => {
    let calls = 0
    const failures: unknown[] = []
    const queue = createRefreshQueue({
      paused: () => false,
      bootstrap: async () => {},
      bootstrapInstance: async () => {
        calls += 1
        if (calls === 1) throw new Error("flaky")
      },
      onFail: (_directory, error) => failures.push(error),
    })

    queue.push("A")
    await waitFor(() => calls === 2)

    expect(calls).toBe(2)
    expect(failures).toEqual([])
    queue.dispose()
  })

  test("recovers after a root bootstrap rejection without an unhandled rejection", async () => {
    let calls = 0
    const rejections: unknown[] = []
    const listener = (reason: unknown) => rejections.push(reason)
    process.on("unhandledRejection", listener)
    try {
      const queue = createRefreshQueue({
        paused: () => false,
        bootstrap: async () => {
          calls += 1
          if (calls === 1) throw new Error("root boom")
        },
        bootstrapInstance: () => {},
      })

      queue.refresh()
      await tick()
      queue.refresh()
      await tick()

      expect(calls).toBe(2)
      expect(rejections).toEqual([])
      queue.dispose()
    } finally {
      process.off("unhandledRejection", listener)
    }
  })

  test("dispose cancels pending retries", async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const queue = createRefreshQueue({
      paused: () => false,
      bootstrap: async () => {},
      bootstrapInstance: async () => {
        calls += 1
        await gate
        throw new Error("boom")
      },
    })

    queue.push("A")
    await tick()
    queue.dispose()
    release()
    await new Promise((resolve) => setTimeout(resolve, 100))

    expect(calls).toBe(1)
  })
})
