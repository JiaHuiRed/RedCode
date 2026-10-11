// 261011 Red C1（审计 RC-GUI-01）：压缩提交的最小交互保障——失败显式可见、在途去重、
// 跨会话隔离、settle 后恢复。审计五场景的自动化子集：reject 反馈（T02）、连点去重（T03）、
// 切会话隔离（T05）、成功恢复（T01）；busy 语义由服务端 ensureRunning 兜底（拒绝走 onError
// → toast），客户端不再另起状态机。showToast 的组件接线靠 typecheck 与真机冒烟。
import { describe, expect, test } from "bun:test"
import { createCompactSubmit } from "./session-context-usage"

const args = (sessionID = "s1") => ({ sessionID, modelID: "m", providerID: "p" })
// summarize → then/finally 的 microtask 链全部落定
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("createCompactSubmit", () => {
  test("reject → onError 收到错误一次；settle 后同会话可再次提交（T02/T01）", async () => {
    const errors: unknown[] = []
    let calls = 0
    const submit = createCompactSubmit({
      summarize: () => {
        calls++
        return Promise.reject(new Error("network down"))
      },
      onError: (error) => errors.push(error),
    })

    expect(submit(args())).toBe(true)
    await settle()

    expect(calls).toBe(1)
    expect(errors).toHaveLength(1)
    expect((errors[0] as Error).message).toBe("network down")
    // pending 已清，恢复可提交
    expect(submit(args())).toBe(true)
    expect(calls).toBe(2)
  })

  test("在途时同会话第二发被去重：summarize 只调一次，返回 false（T03）", async () => {
    let calls = 0
    let release: ((value: unknown) => void) | undefined
    const submit = createCompactSubmit({
      summarize: () => {
        calls++
        return new Promise((resolve) => (release = resolve))
      },
      onError: () => {},
    })

    expect(submit(args())).toBe(true)
    expect(submit(args())).toBe(false)
    expect(calls).toBe(1)

    release?.(undefined)
    await settle()
    expect(submit(args())).toBe(true)
    expect(calls).toBe(2)
  })

  test("A 在途时提交 B 不被去重：跨会话隔离（T05）", async () => {
    const called: string[] = []
    let releaseA: ((value: unknown) => void) | undefined
    const submit = createCompactSubmit({
      summarize: (input) => {
        called.push(input.sessionID)
        if (input.sessionID === "a") return new Promise((resolve) => (releaseA = resolve))
        return Promise.resolve(undefined)
      },
      onError: () => {},
    })

    expect(submit(args("a"))).toBe(true)
    expect(submit(args("b"))).toBe(true)
    expect(called).toEqual(["a", "b"])

    releaseA?.(undefined)
    await settle()
  })

  test("成功 settle 后 pending 清除，可再次提交（T01）", async () => {
    let calls = 0
    const submit = createCompactSubmit({
      summarize: () => {
        calls++
        return Promise.resolve(undefined)
      },
      onError: () => {},
    })

    expect(submit(args())).toBe(true)
    await settle()
    expect(submit(args())).toBe(true)
    expect(calls).toBe(2)
  })

  test("onError 自身抛错不产生 unhandled rejection，pending 照常清理", async () => {
    let calls = 0
    const submit = createCompactSubmit({
      summarize: () => {
        calls++
        return Promise.reject(new Error("boom"))
      },
      onError: () => {
        throw new Error("toast failed")
      },
    })

    expect(submit(args())).toBe(true)
    await settle()
    // pending 已清（清理在 finally，不因 onError 二次故障丢失）
    expect(submit(args())).toBe(true)
    expect(calls).toBe(2)
  })
})
