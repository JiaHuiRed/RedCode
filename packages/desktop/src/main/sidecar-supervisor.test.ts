import { describe, expect, test } from "bun:test"
import { createSidecarSupervisor } from "./sidecar-supervisor"

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

async function until(label: string, done: () => boolean) {
  for (let index = 0; index < 100; index++) {
    if (done()) return
    await tick()
  }
  throw new Error(`timed out waiting for ${label}`)
}

type Spawned = {
  exit: (code: number) => void
  healthy: (ok: boolean) => void
}

function harness(options: { maxInWindow?: number } = {}) {
  const spawned: Spawned[] = []
  const delays: number[] = []
  const events: string[] = []
  const phases: string[] = []
  let quitting = false
  let now = 1_000
  let killed = 0

  const supervisor = createSidecarSupervisor({
    spawn: async (onExit) => {
      let resolve!: () => void
      let reject!: (error: Error) => void
      const health = new Promise<void>((res, rej) => {
        resolve = res
        reject = rej
      })
      spawned.push({
        // 真实链路里 server.ts 的 getFailure 会让 waitUntilHealthy 在进程退出后立刻 reject，
        // 这里同步模拟，否则测试会挂在「等一个永远不会来的健康结果」上。
        exit: (code) => {
          onExit(code)
          reject(new Error(`exited with code ${code}`))
        },
        healthy: (ok) => (ok ? resolve() : reject(new Error("unhealthy"))),
      })
      return { pid: 1_000 + spawned.length, waitHealthy: () => health }
    },
    kill: async () => {
      killed += 1
    },
    delay: async (ms) => {
      delays.push(ms)
    },
    now: () => now,
    quitting: () => quitting,
    log: (event) => {
      events.push(event)
    },
    onState: (state) => {
      phases.push(state.phase)
    },
    maxInWindow: options.maxInWindow,
  })

  return {
    supervisor,
    spawned,
    delays,
    events,
    phases,
    killed: () => killed,
    setQuitting: (value: boolean) => (quitting = value),
    advance: (ms: number) => (now += ms),
  }
}

describe("sidecar supervisor", () => {
  test("start resolves only after the health check passes", async () => {
    const h = harness()
    const starting = h.supervisor.start()
    await until("first spawn", () => h.spawned.length === 1)
    expect(h.supervisor.state().phase).toBe("starting")

    h.spawned[0]!.healthy(true)
    await starting
    expect(h.supervisor.state().phase).toBe("running")
    expect(h.delays).toHaveLength(0)
  })

  // 261021 Red 审计 RC21-06 回归锁：ready 之后、健康检查通过之前退出，旧实现会由「退出」与
  // 「健康失败」各推一次恢复，同一次故障吃两个预算。这里只能计一次、只能有一个恢复任务。
  test("exiting before the health check charges one recovery and spawns one replacement", async () => {
    const h = harness()
    const starting = h.supervisor.start()
    await until("first spawn", () => h.spawned.length === 1)

    // 真实链路里这两个信号几乎同时到：exit 回调 + getFailure 让 waitUntilHealthy reject。
    h.spawned[0]!.exit(1)
    h.spawned[0]!.healthy(false)

    await expect(starting).rejects.toThrow()
    await until("replacement spawn", () => h.spawned.length === 2)
    await tick()

    expect(h.delays).toHaveLength(1)
    expect(h.spawned).toHaveLength(2)
    expect(h.supervisor.recovering()).toBe(true)

    h.spawned[1]!.healthy(true)
    await until("running again", () => h.supervisor.state().phase === "running")
    expect(h.supervisor.recovering()).toBe(false)
  })

  test("a late exit from an old generation cannot start a second recovery", async () => {
    const h = harness()
    const starting = h.supervisor.start()
    await until("first spawn", () => h.spawned.length === 1)
    h.spawned[0]!.exit(1)
    await expect(starting).rejects.toThrow()
    await until("replacement spawn", () => h.spawned.length === 2)

    // 旧代次的退出再来一次（例如 kill 期间的重复回报）不应再推恢复。
    h.spawned[0]!.exit(1)
    await tick()
    expect(h.delays).toHaveLength(1)
    expect(h.spawned).toHaveLength(2)
    expect(h.supervisor.recovering()).toBe(true)

    h.spawned[1]!.healthy(true)
    await until("running", () => h.supervisor.state().phase === "running")
  })

  test("an intentional stop does not spawn the sidecar back", async () => {
    const h = harness()
    const starting = h.supervisor.start()
    await until("first spawn", () => h.spawned.length === 1)
    h.spawned[0]!.healthy(true)
    await starting

    // 用户退出/切换时先 stop 再停进程：退出回调不能把这次主动停当成猝死。
    h.supervisor.stop()
    h.spawned[0]!.exit(0)
    await tick()

    expect(h.spawned).toHaveLength(1)
    expect(h.delays).toHaveLength(0)
  })

  test("quitting stops late callbacks from spawning again", async () => {
    const h = harness()
    const starting = h.supervisor.start()
    await until("first spawn", () => h.spawned.length === 1)
    h.spawned[0]!.healthy(true)
    await starting
    expect(h.supervisor.state().phase).toBe("running")

    h.setQuitting(true)
    h.spawned[0]!.exit(0)
    await tick()

    expect(h.spawned).toHaveLength(1)
    expect(h.delays).toHaveLength(0)
  })

  test("gives up into failed after the delay budget and a retry starts one task", async () => {
    const h = harness()
    const starting = h.supervisor.start()
    await until("first spawn", () => h.spawned.length === 1)
    h.spawned[0]!.healthy(true)
    await starting

    // 已经起来过的 sidecar 猝死，进入恢复；每次恢复都拉起一个不健康的新进程，直到预算耗尽。
    h.spawned[0]!.exit(1)
    for (let round = 0; round < 3; round++) {
      await until(`replacement ${round}`, () => h.spawned.length === round + 2)
      h.spawned.at(-1)!.healthy(false)
    }
    await until("failed state", () => h.supervisor.state().phase === "failed")

    expect(h.delays).toHaveLength(3)
    expect(h.spawned).toHaveLength(4)
    expect(h.supervisor.state().reason).toContain("gave up")

    const before = h.spawned.length
    const retry = h.supervisor.retry()
    const concurrent = h.supervisor.retry()
    expect(concurrent).toBe(retry)
    await until("retry spawn", () => h.spawned.length === before + 1)
    expect(h.supervisor.recovering()).toBe(true)
    expect(h.spawned.filter((_, index) => index >= before)).toHaveLength(1)

    h.spawned.at(-1)!.healthy(true)
    await until("running after retry", () => h.supervisor.state().phase === "running")
    expect(h.supervisor.recovering()).toBe(false)
  })

  test("rate limit stops a sidecar that keeps dying after becoming healthy", async () => {
    const h = harness({ maxInWindow: 2 })
    const starting = h.supervisor.start()
    await until("first spawn", () => h.spawned.length === 1)
    h.spawned[0]!.healthy(true)
    await starting

    // 起来又死：每次都真过了健康检查，靠时间窗闸门才会停手。
    for (let round = 0; round < 2; round++) {
      h.spawned.at(-1)!.exit(1)
      await until(`round ${round} restart`, () => h.spawned.length === round + 2)
      h.spawned.at(-1)!.healthy(true)
      await until("healthy", () => h.supervisor.state().phase === "running")
    }

    h.spawned.at(-1)!.exit(1)
    await until("stopped", () => h.supervisor.state().phase === "failed")
    expect(h.supervisor.state().reason).toContain("within")
    expect(h.spawned).toHaveLength(3)
  })
})
