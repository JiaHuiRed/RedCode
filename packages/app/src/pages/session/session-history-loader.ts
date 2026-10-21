import { createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { UserMessage } from "@redcode-ai/sdk/v2"

type SessionHistoryWindowInput = {
  sessionID: () => string | undefined
  boundary: () => string | undefined
  visibleUserMessages: () => UserMessage[]
  historyMore: () => boolean
  historyLoading: () => boolean
  loadMore: (sessionID: string) => Promise<void>
  newerBoundary?: () => string | undefined
  historyNewer?: () => boolean
  loadNewer?: (sessionID: string) => Promise<void>
  /**
   * 261021 Red 整份会话的用户消息 id，旧→新（轮次目录就是它）。
   * 窗口只是日志的一个分页后缀，目标落在窗口外时只有这份顺序能判断它在哪一侧；
   * 拿不到就退回「只向旧翻」的旧行为。
   */
  targetOrder?: () => string[] | undefined
  retainViewport?: () => () => void
  onLoadError?: () => void
  userScrolled: () => boolean
  scroller: () => HTMLDivElement | undefined
}

export function createSessionHistoryLoader(input: SessionHistoryWindowInput) {
  const historyScrollThreshold = 200
  let shiftFrame: number | undefined
  // 260918 Red 自动填充失败后停手：historyLoading 的 true→false 会让 session.tsx 的 effect 重跑
  // fill()，而 fill() 的进入条件（内容填不满视口）在拉取失败后依然成立 —— 每轮网络往返就再发一次，
  // 实测渲染日志里 7 分钟同一个请求重试 12000 次（全部 400）。用户滚动是显式意图，允许强制重试。
  let stalled = false
  let newerStalled = false
  let newerPending: object | undefined
  // 261021 Red 审计 RC21-03：会话归属不能只比 id —— A→B→A 时迟到的 A 请求会重新
  //   落进 A 的状态。每次切换会话推进代次，写入停滞/错误/视口状态前统一校验
  //   「同一个会话且同一代次」。
  let generation = 0

  const [state, setState] = createStore({
    shift: false,
    stagedHistory: undefined as { sessionID: string; token: symbol; messages: UserMessage[] } | undefined,
  })

  const userMessages = () => {
    const staged = state.stagedHistory
    if (staged && staged.sessionID === input.sessionID()) return staged.messages
    return input.visibleUserMessages()
  }

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

  const fetchOlderMessages = async (force = false) => {
    const id = input.sessionID()
    if (!id) return
    if (stalled && !force) return
    if (!input.historyMore() || input.historyLoading()) return

    const gen = generation
    // 261021 Red 发起时就绑定归属；之后每个写状态的出口都过这道闸。
    const owned = () => input.sessionID() === id && generation === gen
    let boundary = input.boundary()
    let progress = false

    cancelShiftReset()
    setState("shift", true)
    const restore = input.retainViewport?.()

    try {
      while (true) {
        await input.loadMore(id)
        if (!owned()) return

        const nextBoundary = input.boundary()
        progress = nextBoundary !== boundary
        boundary = nextBoundary
        if (progress) break
        // 261009 Red 固定窗口或并发 join 没推进边界时停手，不能形成无界微任务请求循环。
        stalled = input.historyMore()
        setState("shift", false)
        return
      }
    } catch {
      // 260918 Red 拉历史失败（后端 4xx / 网络抖动）：以前错误冒成 uncaught promise 且不留任何状态，
      // 上层 fill() 被 loading 翻转重新唤醒 → 请求风暴。停手，等滚动或切会话再试。
      // 261021 Red 迟到失败不得污染已切换的会话（审计 RC21-03）；当前会话真失败时要给可重试反馈。
      if (!owned()) return
      stalled = true
      setState("shift", false)
      input.onLoadError?.()
      return
    }

    stalled = false

    if (progress) {
      restore?.()
      scheduleShiftReset()
      return
    }

    setState("shift", false)
  }

  const loadAndReveal = () => fetchOlderMessages()

  // 261009 Red 更新侧分页也保持视口；失败与空页停手，显式按钮才能重试。
  const fetchNewerMessages = async (force = false) => {
    const id = input.sessionID()
    if (!id || !input.loadNewer || !input.historyNewer?.()) return
    if (newerPending || input.historyLoading() || (newerStalled && !force)) return
    const token = {}
    newerPending = token
    const gen = generation
    const owned = () => input.sessionID() === id && generation === gen
    const boundary = input.newerBoundary?.()
    const restore = input.retainViewport?.()
    cancelShiftReset()
    setState("shift", true)
    try {
      await input.loadNewer(id)
      if (!owned()) return
      newerStalled = input.newerBoundary?.() === boundary && !!input.historyNewer?.()
      restore?.()
    } catch {
      if (!owned()) return
      newerStalled = true
      input.onLoadError?.()
    } finally {
      if (newerPending === token) newerPending = undefined
      if (owned()) scheduleShiftReset()
    }
  }

  /**
   * 把目标用户消息翻进已加载窗口 —— 轮次导航栏点一条用的就是它。
   *
   * 260901 cc 采自 DSH 的 `Session.loadThrough(seq)`（note: 2026-08-30-web-turn-rail-outline-jump）。
   * 上游按 seq 算页，本仓的分页游标是消息 id，判据换成「目标是否已在
   * visibleUserMessages 里」—— 目录的锚点就是 user 消息 id，两边天然对齐。
   *
   * 261021 Red 审计 RC21-02：双向。窗口（400 条）两端都会裁边，只向旧翻的话，往前翻过一段
   * 之后再点「较新的那一轮」永远够不到。方向由 `targetOrder`（整份目录顺序）里目标与窗口
   * 最旧一条的位置关系决定；拿不到顺序、或判定方向翻不到，再试另一侧。
   * 取舍与验收见 docs/notes/implemented/bug-fix/2026-10-21-audit-rc21-batch.md。
   *
   * 三个终止条件缺一不可：
   * ① 该方向没有更多页 —— 目标不在这一侧。
   * ② **无进展**：翻了一页但边界没变。这里**不当场放弃**，而是等一拍再试 ——
   *    260921（d41ca4c2）起 `directory-sync` 的 `loadMessages`/`loadMore` 对并发调用是
   *    runInflight join，「pager 被占着导致请求被静默丢弃」已不存在；现在无进展通常
   *    意味着 `loadMore` 因 complete 或空页直接短路返回。连续 MAX_STALLS 次无进展
   *    才算真的到底（保留为兜底，不再承担并发修复职责）。
   * ③ 页数上限，纯兜底：无进展保护才是真正的终止器，这条只防我没想到的循环。
   *
   * 返回是否真的把目标带进了窗口 —— 调用方据此决定滚过去还是提示够不到。
   */
  const MAX_JUMP_PAGES = 200
  const MAX_STALLS = 8
  const STALL_WAIT_MS = 60

  type Direction = "older" | "newer"

  const hasMore = (direction: Direction) =>
    direction === "older" ? input.historyMore() : !!(input.loadNewer && input.historyNewer?.())

  const pageBoundary = (direction: Direction) => (direction === "older" ? input.boundary() : input.newerBoundary?.())

  const loadPage = (id: string, direction: Direction) =>
    direction === "older" ? input.loadMore(id) : input.loadNewer!(id)

  /** 目标相对窗口最旧一条的位置；顺序缺失时返回 undefined，退回「只向旧翻」。 */
  const directionOf = (messageID: string) => {
    const order = input.targetOrder?.()
    if (!order?.length) return undefined
    const target = order.indexOf(messageID)
    const oldest = input.visibleUserMessages()[0]?.id
    const anchor = oldest === undefined ? -1 : order.indexOf(oldest)
    if (target < 0 || anchor < 0) return undefined
    return target < anchor ? ("older" as const) : ("newer" as const)
  }

  const walk = async (id: string, messageID: string, direction: Direction) => {
    const arrived = () => input.visibleUserMessages().some((message) => message.id === messageID)
    let boundary = pageBoundary(direction)
    let stalls = 0
    for (let page = 0; page < MAX_JUMP_PAGES; page++) {
      if (arrived()) return true
      if (!hasMore(direction)) return false

      await loadPage(id, direction)
      if (input.sessionID() !== id) return false

      const nextBoundary = pageBoundary(direction)
      if (nextBoundary !== boundary) {
        boundary = nextBoundary
        stalls = 0
        continue
      }
      if (++stalls > MAX_STALLS) return false
      await new Promise((resolve) => setTimeout(resolve, STALL_WAIT_MS))
    }
    return arrived()
  }

  const loadThrough = async (messageID: string) => {
    const id = input.sessionID()
    if (!id) return false
    if (input.visibleUserMessages().some((message) => message.id === messageID)) return true

    cancelShiftReset()
    setState("shift", true)
    // 260926 Red 多页远跳期间先冻结时间线投影，所有页面仍正常进入同步 store；目标进窗后
    //   一次发布完整列表，避免虚拟列表每页都重建行结构。普通上滚仍逐页呈现。
    //   取舍见 docs/notes/implemented/feature/2026-09-26-atomic-turn-history-projection.md。
    // 261009 Red 原始对象进 Solid store 后会被代理，Symbol 保持身份，finally 才能释放冻结投影。
    const token = Symbol()
    setState("stagedHistory", { sessionID: id, token, messages: input.visibleUserMessages() })
    try {
      const preferred = directionOf(messageID)
      if (preferred !== "newer" && (await walk(id, messageID, "older"))) return true
      if (preferred !== "older" && (await walk(id, messageID, "newer"))) return true
      return false
    } catch {
      // 260918 Red 跳转途中拉页失败：当作"够不到"返回 false，别把 rejection 冒给 void 调用方变 uncaught。
      return false
    } finally {
      if (state.stagedHistory?.token === token) setState("stagedHistory", undefined)
      if (input.sessionID() === id) scheduleShiftReset()
    }
  }

  const onScrollerScroll = () => {
    if (!input.userScrolled()) return
    const el = input.scroller()
    if (!el) return
    if (el.scrollTop >= historyScrollThreshold) return

    // 260918 Red 滚动是用户显式意图，允许越过 stalled 重试。
    void fetchOlderMessages(true)
  }

  createEffect(
    on(
      input.sessionID,
      () => {
        generation += 1
        cancelShiftReset()
        stalled = false
        newerStalled = false
        newerPending = undefined
        setState({ shift: false, stagedHistory: undefined })
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
    loadNewer: fetchNewerMessages,
    onNewerScroll: () => {
      if (input.userScrolled()) void fetchNewerMessages()
    },
    onScrollerScroll,
  }
}
