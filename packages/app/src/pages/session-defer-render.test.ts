import { describe, expect, test } from "bun:test"
import { createDeferRender } from "./session-defer-render"

// 261011 Red B1-c: 用可手动驱动的假调度器跨 rAF / setTimeout 两个边界做回归
// （审计文档 GUI-06：A→B→C 连续切换，只有最后版本允许解锁；dispose 后不写 store）。
const createFakes = () => {
  const frames = new Map<number, () => void>()
  const timers = new Map<number, () => void>()
  let nextID = 0
  return {
    frames,
    raf: (callback: () => void) => {
      const id = ++nextID
      frames.set(id, callback)
      return id
    },
    cancelRaf: (handle: number) => {
      frames.delete(handle)
    },
    delay: (callback: () => void) => {
      const id = ++nextID
      timers.set(id, callback)
      return id
    },
    cancelDelay: (handle: unknown) => {
      timers.delete(handle as number)
    },
    fireFrames: () => {
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) callback()
    },
    fireTimers: () => {
      const pending = [...timers.values()]
      timers.clear()
      for (const callback of pending) callback()
    },
  }
}

const createGate = (fakes: ReturnType<typeof createFakes>, current: { key: string }) => {
  const calls: boolean[] = []
  const gate = createDeferRender({
    key: () => current.key,
    set: (value) => calls.push(value),
    raf: fakes.raf,
    cancelRaf: fakes.cancelRaf,
    delay: fakes.delay,
    cancelDelay: fakes.cancelDelay,
  })
  return { gate, calls }
}

describe("createDeferRender", () => {
  test("连续三次切换：只有最后一次允许解锁", () => {
    const fakes = createFakes()
    const current = { key: "A" }
    const { gate, calls } = createGate(fakes, current)

    gate.arm("A")
    current.key = "B"
    gate.arm("B")
    current.key = "C"
    gate.arm("C")
    fakes.fireFrames()
    fakes.fireTimers()

    expect(calls).toEqual([true, true, true, false])
  })

  test("已排队的旧回调无法解锁新会话（key 守卫兜底）", () => {
    const fakes = createFakes()
    const current = { key: "A" }
    const { gate, calls } = createGate(fakes, current)

    gate.arm("A")
    const staleFrame = [...fakes.frames.values()][0]!
    current.key = "C"
    gate.arm("C")

    // 旧 frame 的取消失效（时机已过），它仍执行并排出自己的 timer
    staleFrame()
    fakes.fireTimers()
    fakes.fireFrames()
    fakes.fireTimers()

    expect(calls).toEqual([true, true, false])
  })

  test("cancel（组件卸载）后不再写 store", () => {
    const fakes = createFakes()
    const current = { key: "A" }
    const { gate, calls } = createGate(fakes, current)

    gate.arm("A")
    gate.cancel()
    fakes.fireFrames()
    fakes.fireTimers()

    expect(calls).toEqual([true])
  })
})
