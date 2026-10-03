import { beforeAll, describe, expect, mock, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { messageIdFromHash } from "./message-id-from-hash"

describe("messageIdFromHash", () => {
  test("parses hash with leading #", () => {
    expect(messageIdFromHash("#message-abc123")).toBe("abc123")
  })

  test("parses raw hash fragment", () => {
    expect(messageIdFromHash("message-42")).toBe("42")
  })

  test("ignores non-message anchors", () => {
    expect(messageIdFromHash("#review-panel")).toBeUndefined()
  })
})

// 261003 Red latch 回归：loadMore 持续失败时同一目标不再随 loading 翻转无限重发；
// 换目标或换会话不受已失败的 latch 影响。
// 注意本文件必须以 `bun test --conditions browser` 运行：SSR 版 solid 的 effect 是 no-op，
// 漏了条件会表现为 calls=0 的假红（而不是假绿）。
// 另有 rAF polyfill 仅为让 hook 内的 queue 可调度。

if (typeof globalThis.requestAnimationFrame !== "function") {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 16) as unknown as number) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame
}

let useSessionHashScroll!: typeof import("./use-session-hash-scroll").useSessionHashScroll

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useLocation: () => ({ pathname: "/", search: "", hash: "" }),
    useNavigate: () => () => undefined,
  }))
  const mod = await import("./use-session-hash-scroll")
  useSessionHashScroll = mod.useSessionHashScroll
})

describe("useSessionHashScroll failure latch", () => {
  const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0))

  const setup = (input: {
    loading: () => boolean
    pending: () => string | undefined
    loadMore: () => Promise<void>
  }) => {
    let dispose!: () => void
    createRoot((d) => {
      dispose = d
      useSessionHashScroll({
        sessionKey: () => "s1",
        sessionID: () => "s1",
        messagesReady: () => true,
        visibleUserMessages: () => [],
        historyMore: () => true,
        historyLoading: input.loading,
        loadMore: input.loadMore,
        currentMessageId: () => undefined,
        pendingMessage: input.pending,
        setPendingMessage: () => undefined,
        setActiveMessage: () => undefined,
        autoScroll: { pause: () => undefined, forceScrollToBottom: () => undefined },
        scroller: () => undefined,
        anchor: (id) => id,
        scheduleScrollState: () => undefined,
        consumePendingMessage: () => undefined,
      })
    })
    return dispose
  }

  test("does not refire loadMore for the same target after a rejection", async () => {
    const [loading, setLoading] = createSignal(false)
    let calls = 0
    const dispose = setup({
      loading,
      pending: () => "m1",
      loadMore: async () => {
        calls += 1
        throw new Error("synthetic failure")
      },
    })

    await nextTick()
    expect(calls).toBe(1)

    setLoading(true)
    await nextTick()
    setLoading(false)
    await nextTick()
    expect(calls).toBe(1)

    dispose()
  })

  test("allows a different target after a failure", async () => {
    const [pending, setPending] = createSignal<string | undefined>("m1")
    let calls = 0
    const dispose = setup({
      loading: () => false,
      pending,
      loadMore: async () => {
        calls += 1
        throw new Error("synthetic failure")
      },
    })

    await nextTick()
    expect(calls).toBe(1)

    setPending("m2")
    await nextTick()
    expect(calls).toBe(2)

    dispose()
  })
})
