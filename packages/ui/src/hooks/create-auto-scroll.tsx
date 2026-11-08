import { createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { createEventListener } from "@solid-primitives/event-listener"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { imeComposing } from "./ime"
import {
  createAutoScrollState,
  END_EPSILON,
  SETTLE_MS,
  selectOverflowAnchor,
  selectPausesOnSelection,
  selectUserScrolled,
  transitionAutoScroll,
  type AutoScrollEffect,
  type AutoScrollEvent,
} from "./auto-scroll-machine"

export interface AutoScrollOptions {
  working: () => boolean
  onUserInteracted?: () => void
  overflowAnchor?: "none" | "auto" | "dynamic"
  bottomThreshold?: number
  /** 261108 Red false = 不观察 content 尺寸，由调用方在内容变化时调 contentChanged()。
   *  虚拟列表的 content 高度由行自身测量决定，外层再挂 RO 会和行尺寸提交挤在同一帧。 */
  observeContent?: boolean
}

const BOTTOM = { type: "scroll.bottom", force: false } as const

const FORCE_BOTTOM = { type: "scroll.bottom", force: true } as const

const DISPOSE = { type: "disposed" } as const

// 261108 Red 滚动决策收敛成状态机（移植上游 #61588）：所有入口只 dispatch，
// 是否写 scrollTop 由 reducer 产出的 effect 决定。RO/滚动/尺寸回调不再各自判断。
export function createAutoScroll(options: AutoScrollOptions) {
  const [state, setState] = createSignal(createAutoScrollState(untrack(options.working)))
  const [refs, setRefs] = createStore<{ scroll?: HTMLElement; content?: HTMLElement }>({})
  let attempts = 0
  let settleTimer: ReturnType<typeof setTimeout> | undefined

  // scroll/resize 在流式期间每帧都来；复用事件对象，热路径不分配。
  const resizeEvent = { type: "resize" as const, overflow: false }
  const scrollEvent = { type: "scroll" as const, overflow: false, scrollTop: 0, maxScroll: 0, threshold: 0 }
  const pauseEvent = { type: "pause" as const, overflow: false }
  const flightEvent = { type: "flight.started" as const, top: 0 }

  const dispatch = (event: AutoScrollEvent) => {
    const result = transitionAutoScroll(untrack(state), event)
    setState(result.state)
    result.effects.forEach(run)
  }

  const run = (effect: AutoScrollEffect) => {
    if (effect.type === "pin.bottom") return pin()
    if (effect.type === "notify.interacted") return options.onUserInteracted?.()
    clearTimeout(settleTimer)

    if (effect.type === "settle.stop") return

    const attempt = effect.attempt
    settleTimer = setTimeout(() => dispatch({ type: "settle.elapsed", attempt }), SETTLE_MS)
  }

  const pin = () => {
    const el = refs.scroll

    if (!el || !el.isConnected) return
    const before = el.scrollTop

    if (el.scrollHeight - el.clientHeight - before <= END_EPSILON) return
    // `scrollTop` assignment bypasses any CSS `scroll-behavior: smooth`.
    el.scrollTop = el.scrollHeight
    const after = el.scrollTop

    // The browser queues a `scroll` event only when the position actually moved.
    if (Math.abs(after - before) <= END_EPSILON) return
    flightEvent.top = after
    dispatch(flightEvent)
  }

  const pause = () => {
    const el = refs.scroll

    if (!el || !el.isConnected) return
    pauseEvent.overflow = canScroll(el)
    dispatch(pauseEvent)
  }

  const handleWheel = (e: WheelEvent) => {
    if (e.deltaY >= 0) return
    // If the user is scrolling within a nested scrollable region (tool output,
    // code block, etc), don't treat it as leaving the "follow bottom" mode.
    // Those regions opt in via `data-scrollable`.
    const target = e.target instanceof Element ? e.target : undefined
    const nested = target?.closest("[data-scrollable]")
    const el = refs.scroll

    if (el && nested && nested !== el) return
    pause()
  }

  const handleScroll = () => {
    const el = refs.scroll

    if (!el || !el.isConnected) return
    scrollEvent.maxScroll = el.scrollHeight - el.clientHeight
    scrollEvent.overflow = canScroll(el)
    scrollEvent.scrollTop = el.scrollTop
    scrollEvent.threshold = options.bottomThreshold ?? 10
    dispatch(scrollEvent)
  }

  const handleInteraction = () => {
    if (!selectPausesOnSelection(untrack(state))) return
    const selection = window.getSelection()

    if (!selection || selection.isCollapsed || selection.toString().length === 0) return
    pause()
  }

  // 261108 Red 内容高度变化入口：observeContent 为真时由 RO 触发，否则调用方上报。
  const contentChanged = () => {
    const el = refs.scroll

    if (!el || !el.isConnected) return
    // 组合期不追底：中文候选框展开会让它抢帧，与 message-timeline 的门禁同一语义。
    if (imeComposing()) return
    resizeEvent.overflow = canScroll(el)
    dispatch(resizeEvent)
  }

  createResizeObserver(
    () => (options.observeContent === false ? undefined : refs.content),
    contentChanged,
  )

  const userScrolled = createMemo(() => selectUserScrolled(state()))
  const overflowAnchor = createMemo(() => selectOverflowAnchor(state(), options.overflowAnchor))

  createEffect(() => {
    const el = refs.scroll

    if (!el) return
    el.style.overflowAnchor = overflowAnchor()
  })

  createEventListener(() => refs.scroll, "wheel", handleWheel, { passive: true })

  createEffect(
    on(options.working, (working) => {
      if (!working) attempts += 1
      dispatch({ type: "working.changed", working, attempt: attempts })
    }),
  )

  onCleanup(() => {
    clearTimeout(settleTimer)
    dispatch(DISPOSE)
  })

  return {
    scrollRef: (el: HTMLElement | undefined) => {
      if (el === untrack(() => refs.scroll)) return
      setRefs("scroll", el)
      dispatch({ type: "scroller.changed", overflow: !!el && el.isConnected && canScroll(el) })
    },
    contentRef: (el: HTMLElement | undefined) => setRefs("content", el),
    handleScroll,
    handleInteraction,
    pause,
    resume: () => dispatch(FORCE_BOTTOM),
    scrollToBottom: () => dispatch(BOTTOM),
    forceScrollToBottom: () => dispatch(FORCE_BOTTOM),
    // 261108 Red observeContent=false 时由调用方驱动的「内容高度变了」入口。
    contentChanged,
    userScrolled,
    // 260923 Red 会话切换：清交互状态与在途 settle，不主动滚动。
    reset: () => {
      clearTimeout(settleTimer)
      settleTimer = undefined
      setState(createAutoScrollState(untrack(options.working)))
    },
  }
}

function canScroll(el: HTMLElement) {
  return el.scrollHeight - el.clientHeight > 1
}
