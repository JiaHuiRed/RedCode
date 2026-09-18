import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { UserMessage } from "@redcode-ai/sdk/v2"
import { createSessionHistoryLoader } from "./session-history-loader"

const message = (id: string) => ({ id }) as UserMessage
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

// 260918 Red 回归锁：拉历史失败后必须停手。500 的失败不只在 UI 转圈——session.tsx 的 fill()
// effect 依赖 historyLoading()，失败让 loading 从 true 翻回 false，effect 重跑，而
// "内容填不满视口"的进入条件在失败后依然成立，于是每轮网络往返再发一次。实测渲染日志里
// 7 分钟同一个请求重试 12000 次（全部 400）。
function setup(loadMore: (id: string) => Promise<void>) {
  let messages: UserMessage[] = []
  let loads = 0
  const root = createRoot((dispose) => {
    const loader = createSessionHistoryLoader({
      sessionID: () => "ses_test",
      loaded: () => messages.length,
      visibleUserMessages: () => messages,
      historyMore: () => true,
      historyLoading: () => false,
      loadMore: async (id) => {
        loads += 1
        await loadMore(id)
      },
      userScrolled: () => true,
      scroller: () => ({ scrollTop: 0 }) as HTMLDivElement,
    })
    return { loader, dispose }
  })
  return { ...root, count: () => loads }
}

describe("createSessionHistoryLoader", () => {
  test("stops auto-filling once a page fetch fails", async () => {
    const ctx = setup(async () => {
      throw new Error("400 Bad Request")
    })

    await ctx.loader.loadAndReveal()
    await ctx.loader.loadAndReveal()
    await ctx.loader.loadAndReveal()

    expect(ctx.count()).toBe(1)
    ctx.dispose()
  })

  test("lets an explicit scroll retry after a failure", async () => {
    let failing = true
    const ctx = setup(async () => {
      if (failing) throw new Error("400 Bad Request")
    })

    await ctx.loader.loadAndReveal()
    expect(ctx.count()).toBe(1)

    ctx.loader.onScrollerScroll()
    await tick()

    expect(ctx.count()).toBe(2)
    ctx.dispose()
  })

  test("keeps filling while pages arrive", async () => {
    const ctx = setup(async () => {})

    await ctx.loader.loadAndReveal()

    expect(ctx.count()).toBe(1)
    ctx.dispose()
  })

  test("loadThrough reports an unreachable target instead of rejecting", async () => {
    const ctx = setup(async () => {
      throw new Error("400 Bad Request")
    })

    expect(await ctx.loader.loadThrough("m1")).toBe(false)
    ctx.dispose()
  })
})
