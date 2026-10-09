import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import type { UserMessage } from "@redcode-ai/sdk/v2"
import { createSessionHistoryLoader } from "./session-history-loader"

const message = (id: string) => ({ id }) as UserMessage
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

// 260918 Red 回归锁：拉历史失败后必须停手。500 的失败不只在 UI 转圈——session.tsx 的 fill()
// effect 依赖 historyLoading()，失败让 loading 从 true 翻回 false，effect 重跑，而
// "内容填不满视口"的进入条件在失败后依然成立，于是每轮网络往返再发一次。实测渲染日志里
// 7 分钟同一个请求重试 12000 次（全部 400）。
function setup(loadMore: (id: string) => Promise<void>, loadNewer = loadMore) {
  let loads = 0
  let errors = 0
  let restores = 0
  const root = createRoot((dispose) => {
    const [state, setState] = createStore({
      messages: [] as UserMessage[],
      sessionID: "ses_test" as string | undefined,
    })
    const loader = createSessionHistoryLoader({
      sessionID: () => state.sessionID,
      boundary: () => state.messages[0]?.id,
      visibleUserMessages: () => state.messages,
      historyMore: () => true,
      historyLoading: () => false,
      loadMore: async (id) => {
        loads += 1
        await loadMore(id)
      },
      newerBoundary: () => state.messages.at(-1)?.id,
      historyNewer: () => true,
      loadNewer: async (id) => {
        loads += 1
        await loadNewer(id)
      },
      retainViewport: () => () => restores++,
      onLoadError: () => errors++,
      userScrolled: () => true,
      scroller: () => ({ scrollTop: 0 }) as HTMLDivElement,
    })
    return {
      loader,
      messages: () => state.messages,
      setMessages: (messages: UserMessage[]) => setState("messages", messages),
      setSessionID: (sessionID: string | undefined) => setState("sessionID", sessionID),
      dispose,
    }
  })
  return { ...root, count: () => loads, errors: () => errors, restores: () => restores }
}

function gate() {
  let enter!: () => void
  let release!: () => void
  return {
    entered: new Promise<void>((resolve) => (enter = resolve)),
    pending: new Promise<void>((resolve) => (release = resolve)),
    enter: () => enter(),
    release: () => release(),
  }
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

  test("stops automatic filling on a successful but nonadvancing page", async () => {
    const ctx = setup(async () => {})

    await ctx.loader.loadAndReveal()
    await ctx.loader.loadAndReveal()
    await ctx.loader.loadAndReveal()

    expect(ctx.count()).toBe(1)
    ctx.dispose()
  })

  test("newer fetch failures do not retry on scroll events and an explicit action can retry", async () => {
    let failing = true
    const ctx = setup(async () => {}, async () => {
      if (failing) throw new Error("400 Bad Request")
      ctx.setMessages([message("old"), message("new")])
    })
    ctx.setMessages([message("old")])
    await ctx.loader.loadNewer()
    await ctx.loader.loadNewer()
    ctx.loader.onNewerScroll()
    await tick()
    expect(ctx.count()).toBe(1)
    expect(ctx.errors()).toBe(1)
    failing = false
    await ctx.loader.loadNewer(true)
    expect(ctx.count()).toBe(2)
    expect(ctx.restores()).toBe(1)
    ctx.dispose()
  })

  test("newer paging does not restore or report errors in a different session", async () => {
    const pending = gate()
    const ctx = setup(async () => {}, async () => {
      pending.enter()
      await pending.pending
      throw new Error("old-session failure")
    })
    const loading = ctx.loader.loadNewer()
    await pending.entered
    ctx.setSessionID("ses_next")
    pending.release()
    await loading
    expect(ctx.errors()).toBe(0)
    expect(ctx.restores()).toBe(0)
    ctx.dispose()
  })

  test("continues loading when a capped window advances its oldest boundary", async () => {
    let page = 0
    const ctx = setup(async () => {
      page += 1
      const first = ctx.messages()
      if (page < 4) {
        ctx.setMessages([...first.slice(1), message(`next-${page}`)])
        return
      }
      ctx.setMessages([message("target"), ...first.slice(0, 399)])
    })
    ctx.setMessages(Array.from({ length: 400 }, (_, i) => message(`m${i}`)))

    expect(await ctx.loader.loadThrough("target")).toBe(true)

    expect(ctx.messages()).toHaveLength(400)
    expect(ctx.messages()[0]?.id).toBe("target")
    expect(ctx.loader.userMessages()).toHaveLength(400)
    expect(ctx.loader.userMessages()[0]?.id).toBe("target")
    expect(ctx.count()).toBe(4)
    ctx.dispose()
  })

  test("loadThrough reports an unreachable target instead of rejecting", async () => {
    const ctx = setup(async () => {
      throw new Error("400 Bad Request")
    })

    expect(await ctx.loader.loadThrough("m1")).toBe(false)
    ctx.dispose()
  })

  test("publishes the timeline projection once after a multi-page turn jump", async () => {
    const first = gate()
    const second = gate()
    const firstStarted = gate()
    const secondStarted = gate()
    let setMessages!: (messages: UserMessage[]) => void
    let page = 0
    const ctx = setup(async () => {
      if (page++ === 0) {
        firstStarted.enter()
        await first.pending
        setMessages([message("older-1"), message("current")])
        return
      }
      secondStarted.enter()
      await second.pending
      setMessages([message("target"), message("older-1"), message("current")])
    })
    setMessages = ctx.setMessages
    ctx.setMessages([message("current")])

    const loading = ctx.loader.loadThrough("target")
    await firstStarted.entered
    expect(ctx.loader.userMessages().map((item) => item.id)).toEqual(["current"])

    first.release()
    await secondStarted.entered
    expect(ctx.messages().map((item) => item.id)).toEqual(["older-1", "current"])
    expect(ctx.loader.userMessages().map((item) => item.id)).toEqual(["current"])

    second.release()
    expect(await loading).toBe(true)
    expect(ctx.loader.userMessages().map((item) => item.id)).toEqual(["target", "older-1", "current"])
    ctx.dispose()
  })

  test("does not expose a staged projection after switching sessions", async () => {
    const page = gate()
    const started = gate()
    const ctx = setup(async () => {
      started.enter()
      await page.pending
    })
    ctx.setMessages([message("current")])

    const loading = ctx.loader.loadThrough("target")
    await started.entered
    ctx.setSessionID("ses_next")
    ctx.setMessages([message("next-session")])

    expect(ctx.loader.userMessages().map((item) => item.id)).toEqual(["next-session"])
    page.release()
    expect(await loading).toBe(false)
    expect(ctx.loader.userMessages().map((item) => item.id)).toEqual(["next-session"])
    ctx.dispose()
  })
})
