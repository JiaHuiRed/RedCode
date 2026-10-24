import { describe, expect, test } from "bun:test"
import { awaitStartupHealth } from "./startup-health"

// 261024 Red ConnectionGate 启动闸门的轮询语义单测：时钟与休眠全注入，不用真等待。

/** 手动拨针的假时钟：sleep 推进 now，调用序记录在案。 */
function fakeClock() {
  let time = 0
  const sleeps: number[] = []
  return {
    now: () => time,
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      time += ms
    },
  }
}

const base = {
  connectionType: "sidecar" as const,
  shouldBackground: () => false,
  intervalMs: 500,
  timeoutMs: 10_000,
}

describe("awaitStartupHealth", () => {
  test("healthy on the first probe passes without sleeping", async () => {
    const clock = fakeClock()
    let calls = 0
    const result = await awaitStartupHealth({
      ...base,
      now: clock.now,
      sleep: clock.sleep,
      check: () => {
        calls += 1
        return Promise.resolve({ healthy: true })
      },
    })
    expect(result).toBe(true)
    expect(calls).toBe(1)
    expect(clock.sleeps).toEqual([])
  })

  test("http connections fail fast on the first unhealthy probe", async () => {
    const clock = fakeClock()
    let calls = 0
    const result = await awaitStartupHealth({
      ...base,
      connectionType: "http",
      now: clock.now,
      sleep: clock.sleep,
      check: () => {
        calls += 1
        return Promise.resolve({ healthy: false })
      },
    })
    expect(result).toBe(false)
    expect(calls).toBe(1)
  })

  test("sidecar connections poll with a fixed interval until healthy", async () => {
    const clock = fakeClock()
    let calls = 0
    const result = await awaitStartupHealth({
      ...base,
      now: clock.now,
      sleep: clock.sleep,
      check: () => {
        calls += 1
        return Promise.resolve({ healthy: calls >= 3 })
      },
    })
    expect(result).toBe(true)
    expect(calls).toBe(3)
    expect(clock.sleeps).toEqual([500, 500])
  })

  test("switching to background stops the blocking grace immediately", async () => {
    const clock = fakeClock()
    let background = false
    const result = await awaitStartupHealth({
      ...base,
      now: clock.now,
      sleep: clock.sleep,
      shouldBackground: () => background,
      check: () => {
        background = true
        return Promise.resolve({ healthy: false })
      },
    })
    expect(result).toBe(false)
    expect(clock.sleeps).toEqual([])
  })

  test("the budget stops the next round from starting", async () => {
    const clock = fakeClock()
    let calls = 0
    const result = await awaitStartupHealth({
      ...base,
      timeoutMs: 1200,
      now: clock.now,
      sleep: clock.sleep,
      check: () => {
        calls += 1
        return Promise.resolve({ healthy: false })
      },
    })
    expect(result).toBe(false)
    // t=0 探测 → 睡到 500/1000 各探测一轮；t=1000 + 500 > 1200，不再起下一轮。
    expect(calls).toBe(3)
    expect(clock.sleeps).toEqual([500, 500])
  })

  test("each probe carries the remaining budget as its own request timeout", async () => {
    const clock = fakeClock()
    const timeouts: Array<number | undefined> = []
    await awaitStartupHealth({
      ...base,
      timeoutMs: 1200,
      now: clock.now,
      sleep: clock.sleep,
      check: (opts) => {
        timeouts.push(opts?.timeoutMs)
        return Promise.resolve({ healthy: false })
      },
    })
    // 261024 Red 单轮探测也受总预算约束：t=0 拿满 1200，t=500 剩 700，t=1000 剩 200。
    expect(timeouts).toEqual([1200, 700, 200])
  })

  test("a hanging first probe ends at the budget, not at its own 30s default", async () => {
    const clock = fakeClock()
    let calls = 0
    const result = await awaitStartupHealth({
      ...base,
      timeoutMs: 1000,
      intervalMs: 500,
      now: clock.now,
      sleep: clock.sleep,
      // 模拟无响应服务器：请求挂到本轮超时（= 剩余预算）才以 unhealthy 落地。
      check: (opts) => {
        calls += 1
        return clock.sleep(opts?.timeoutMs ?? 0).then(() => ({ healthy: false }))
      },
    })
    expect(result).toBe(false)
    // 首轮探测按剩余预算 1000ms 自灭，下一轮已无预算——总耗时就是预算线本身。
    expect(calls).toBe(1)
    expect(clock.now()).toBe(1000)
  })
})
