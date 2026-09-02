import { createMemo, createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { UserMessage } from "@redcode-ai/sdk/v2"
import { same } from "@/utils/same"

const emptyUserMessages: UserMessage[] = []

type SessionHistoryWindowInput = {
  sessionID: () => string | undefined
  loaded: () => number
  visibleUserMessages: () => UserMessage[]
  historyMore: () => boolean
  historyLoading: () => boolean
  loadMore: (sessionID: string) => Promise<void>
  userScrolled: () => boolean
  scroller: () => HTMLDivElement | undefined
}

export function createSessionHistoryLoader(input: SessionHistoryWindowInput) {
  const historyScrollThreshold = 200
  let shiftFrame: number | undefined

  const [state, setState] = createStore({
    shift: false,
  })

  const userMessages = createMemo(() => input.visibleUserMessages(), emptyUserMessages, {
    equals: same,
  })

  const cancelShiftReset = () => {
    if (shiftFrame === undefined) return
    cancelAnimationFrame(shiftFrame)
    shiftFrame = undefined
  }

  const scheduleShiftReset = () => {
    cancelShiftReset()
    shiftFrame = requestAnimationFrame(() => {
      shiftFrame = undefined
      setState("shift", false)
    })
  }

  const fetchOlderMessages = async () => {
    const id = input.sessionID()
    if (!id) return
    if (!input.historyMore() || input.historyLoading()) return

    const beforeVisible = input.visibleUserMessages().length
    let loaded = input.loaded()
    let growth = 0

    cancelShiftReset()
    setState("shift", true)

    while (true) {
      await input.loadMore(id)
      if (input.sessionID() !== id) return

      const nextLoaded = input.loaded()
      const raw = nextLoaded - loaded
      loaded = nextLoaded
      growth = input.visibleUserMessages().length - beforeVisible

      if (growth > 0) break
      if (raw <= 0) break
      if (!input.historyMore()) break
    }

    if (growth > 0) {
      scheduleShiftReset()
      return
    }

    setState("shift", false)
  }

  const loadAndReveal = () => fetchOlderMessages()

  /**
   * 一路往前翻，直到目标用户消息进入已加载窗口。轮次导航栏点一条历史用的就是它。
   *
   * 260901 cc 采自 DSH 的 `Session.loadThrough(seq)`（note: 2026-08-30-web-turn-rail-outline-jump）。
   * 上游按 seq 算页，本仓的分页游标是消息 id，判据换成「目标是否已在
   * visibleUserMessages 里」—— 目录的锚点就是 user 消息 id，两边天然对齐。
   *
   * 三个终止条件缺一不可：
   * ① `historyMore()` 为假 —— 历史翻到底了，目标不在这个会话里（或已被压缩掉）。
   * ② **无进展**：翻了一页但 `loaded()` 没涨。这里**不当场放弃**，而是等一拍再试 ——
   *    `directory-sync` 的 `loadMessages` 对并发调用是静默 no-op（`if (meta.loading[key]) return`），
   *    所以"没进展"最常见的原因是用户同时往上滚触发了另一次翻页，pager 被占着。
   *    上游那条 `fix(ui-chat): hold jumps while a plain pull owns the pager` 修的正是
   *    这种情况下跳转退化成"落在最近一条"。连续 MAX_STALLS 次都没进展才算真的空页。
   * ③ 页数上限，纯兜底：无进展保护才是真正的终止器，这条只防我没想到的循环。
   *
   * 返回是否真的把目标带进了窗口 —— 调用方据此决定滚过去还是提示够不到。
   */
  const MAX_JUMP_PAGES = 200
  const MAX_STALLS = 8
  const STALL_WAIT_MS = 60

  const loadThrough = async (messageID: string) => {
    const id = input.sessionID()
    if (!id) return false
    const arrived = () => input.visibleUserMessages().some((message) => message.id === messageID)
    if (arrived()) return true

    cancelShiftReset()
    setState("shift", true)
    try {
      let loaded = input.loaded()
      let stalls = 0
      for (let page = 0; page < MAX_JUMP_PAGES; page++) {
        if (arrived()) return true
        if (!input.historyMore()) return false

        await input.loadMore(id)
        if (input.sessionID() !== id) return false

        const next = input.loaded()
        if (next > loaded) {
          loaded = next
          stalls = 0
          continue
        }
        if (++stalls > MAX_STALLS) return false
        await new Promise((resolve) => setTimeout(resolve, STALL_WAIT_MS))
      }
      return arrived()
    } finally {
      scheduleShiftReset()
    }
  }

  const onScrollerScroll = () => {
    if (!input.userScrolled()) return
    const el = input.scroller()
    if (!el) return
    if (el.scrollTop >= historyScrollThreshold) return

    void fetchOlderMessages()
  }

  createEffect(
    on(
      input.sessionID,
      () => {
        cancelShiftReset()
        setState({ shift: false })
      },
      { defer: true },
    ),
  )

  onCleanup(cancelShiftReset)

  return {
    userMessages,
    shift: () => state.shift,
    loadAndReveal,
    loadThrough,
    onScrollerScroll,
  }
}
