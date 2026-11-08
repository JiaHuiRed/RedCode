import { createEffect, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { imeComposing } from "./ime"

export interface AutoScrollOptions {
  working: () => boolean
  onUserInteracted?: () => void
  overflowAnchor?: "none" | "auto" | "dynamic"
  bottomThreshold?: number
  /** 261108 Red false = 不观察 content 尺寸，由调用方在内容变化时调 contentChanged()。
   *  虚拟列表的 content 高度由行自身测量决定，外层再挂 RO 会和行尺寸提交挤在同一帧。 */
  observeContent?: boolean
}

export function createAutoScroll(options: AutoScrollOptions) {
  let settling = false
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let autoTimer: ReturnType<typeof setTimeout> | undefined
  let auto: { top: number; time: number } | undefined
  let followFrame: number | undefined

  const threshold = () => options.bottomThreshold ?? 10

  const [store, setStore] = createStore({
    contentRef: undefined as HTMLElement | undefined,
    scrollRef: undefined as HTMLElement | undefined,
    userScrolled: false,
  })

  const active = () => options.working() || settling

  const distanceFromBottom = (el: HTMLElement) => {
    return el.scrollHeight - el.clientHeight - el.scrollTop
  }

  const canScroll = (el: HTMLElement) => {
    return el.scrollHeight - el.clientHeight > 1
  }

  // Browsers can dispatch scroll events asynchronously. If new content arrives
  // between us calling `scrollTo()` and the subsequent `scroll` event firing,
  // the handler can see a non-zero `distanceFromBottom` and incorrectly assume
  // the user scrolled.
  const markAuto = (el: HTMLElement) => {
    auto = {
      top: Math.max(0, el.scrollHeight - el.clientHeight),
      time: Date.now(),
    }

    if (autoTimer) clearTimeout(autoTimer)
    autoTimer = setTimeout(() => {
      auto = undefined
      autoTimer = undefined
    }, 1500)
  }

  const isAuto = (el: HTMLElement) => {
    const a = auto
    if (!a) return false

    if (Date.now() - a.time > 1500) {
      auto = undefined
      return false
    }

    return Math.abs(el.scrollTop - a.top) < 2
  }

  const scrollToBottomNow = (behavior: ScrollBehavior) => {
    const el = store.scrollRef
    if (!el) return
    markAuto(el)
    if (behavior === "smooth") {
      el.scrollTo({ top: el.scrollHeight, behavior })
      return
    }

    // `scrollTop` assignment bypasses any CSS `scroll-behavior: smooth`.
    el.scrollTop = el.scrollHeight
  }

  const scrollToBottom = (force: boolean) => {
    if (!force && !active()) return

    if (force && store.userScrolled) setStore("userScrolled", false)

    const el = store.scrollRef
    if (!el) return

    if (!force && store.userScrolled) return

    const distance = distanceFromBottom(el)
    if (distance < 2) {
      markAuto(el)
      return
    }

    // For auto-following content we prefer immediate updates to avoid
    // visible "catch up" animations while content is still settling.
    scrollToBottomNow("auto")
  }

  const stop = () => {
    const el = store.scrollRef
    if (!el) return
    if (!canScroll(el)) {
      if (store.userScrolled) setStore("userScrolled", false)
      return
    }
    if (store.userScrolled) return

    setStore("userScrolled", true)
    options.onUserInteracted?.()
  }

  const handleWheel = (e: WheelEvent) => {
    if (e.deltaY >= 0) return
    // If the user is scrolling within a nested scrollable region (tool output,
    // code block, etc), don't treat it as leaving the "follow bottom" mode.
    // Those regions opt in via `data-scrollable`.
    const el = store.scrollRef
    const target = e.target instanceof Element ? e.target : undefined
    const nested = target?.closest("[data-scrollable]")
    if (el && nested && nested !== el) return
    stop()
  }

  const handleScroll = () => {
    const el = store.scrollRef
    if (!el) return

    if (!canScroll(el)) {
      if (store.userScrolled) setStore("userScrolled", false)
      return
    }

    if (distanceFromBottom(el) < threshold()) {
      if (store.userScrolled) setStore("userScrolled", false)
      return
    }

    // Ignore scroll events triggered by our own scrollToBottom calls.
    if (!store.userScrolled && isAuto(el)) {
      scrollToBottom(false)
      return
    }

    stop()
  }

  const handleInteraction = () => {
    if (!active()) return
    const selection = window.getSelection()
    if (selection && selection.toString().length > 0) {
      stop()
    }
  }

  const updateOverflowAnchor = (el: HTMLElement) => {
    const mode = options.overflowAnchor ?? "dynamic"

    if (mode === "none") {
      el.style.overflowAnchor = "none"
      return
    }

    if (mode === "auto") {
      el.style.overflowAnchor = "auto"
      return
    }

    el.style.overflowAnchor = store.userScrolled ? "auto" : "none"
  }

  const contentChanged = () => {
    const el = store.scrollRef
    if (el && !canScroll(el)) {
      if (store.userScrolled) setStore("userScrolled", false)
      return
    }
    if (!active()) return
    if (store.userScrolled) return
    // 261108 Red 组合期不追底：ResizeObserver 由输入区/内容区高度变化触发，
    // 中文候选框展开会让它抢帧，与 message-timeline 的 imeComposing 门禁保持同一语义。
    if (imeComposing()) return
    // 261108 Red 滚动延到下一帧：RO 回调里同步写 scrollTop 会让 virtua 重测量，
    // 同一帧再次改变内容高度 → 观察-布局循环（Electron renderer.log 里 911 条
    // ResizeObserver loop 警告的主要来源）。代价是最多多等一帧，流式下一帧仍会追。
    if (followFrame !== undefined) cancelAnimationFrame(followFrame)
    followFrame = requestAnimationFrame(() => {
      followFrame = undefined
      if (!active()) return
      if (store.userScrolled) return
      scrollToBottom(false)
    })
  }

  createResizeObserver(
    () => (options.observeContent === false ? undefined : store.contentRef),
    contentChanged,
  )

  createEffect(
    on(options.working, (working: boolean) => {
      settling = false
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = undefined

      if (working) {
        if (!store.userScrolled) scrollToBottom(true)
        return
      }

      settling = true
      settleTimer = setTimeout(() => {
        settling = false
      }, 300)
    }),
  )

  createEffect(() => {
    // Track `userScrolled` even before `scrollRef` is attached, so we can
    // update overflow anchoring once the element exists.
    store.userScrolled
    const el = store.scrollRef
    if (!el) return
    updateOverflowAnchor(el)
  })

  createEventListener(() => store.scrollRef, "wheel", handleWheel, { passive: true })

  onCleanup(() => {
    if (settleTimer) clearTimeout(settleTimer)
    if (autoTimer) clearTimeout(autoTimer)
    if (followFrame !== undefined) cancelAnimationFrame(followFrame)
    followFrame = undefined
  })

  return {
    scrollRef: (el: HTMLElement | undefined) => setStore("scrollRef", el),
    contentRef: (el: HTMLElement | undefined) => setStore("contentRef", el),
    handleScroll,
    handleInteraction,
    pause: stop,
    resume: () => {
      if (store.userScrolled) setStore("userScrolled", false)
      scrollToBottom(true)
    },
    // 260923 Red session 切换时只清交互状态、不主动滚动：userScrolled 是「用户正在看
    //   历史」的单会话状态，Page() 级别的 autoScroll 实例跨会话复用会把它带给下一个会话，
    //   shouldAnchorBottom() 随之恒假、入场不锚底。auto 记录一并清掉，避免旧元素的
    //   scrollTop 被拿去和新会话比对。是否重新到底交给调用方的 hash / pendingMessage 链路。
    reset: () => {
      if (autoTimer) clearTimeout(autoTimer)
      autoTimer = undefined
      auto = undefined
      if (followFrame !== undefined) cancelAnimationFrame(followFrame)
      followFrame = undefined
      if (store.userScrolled) setStore("userScrolled", false)
    },
    scrollToBottom: () => scrollToBottom(false),
    forceScrollToBottom: () => scrollToBottom(true),
    // 261108 Red observeContent=false 时由调用方驱动的「内容高度变了」入口。
    contentChanged,
    userScrolled: () => store.userScrolled,
  }
}
