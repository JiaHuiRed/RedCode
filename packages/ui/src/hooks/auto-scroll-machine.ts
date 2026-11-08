// 261108 Red 自动追底状态机：移植自上游 opencode `packages/ui/src/hooks/auto-scroll-machine.ts`
// （对应上游 #61588 / #60481 的滚动收敛）。纯函数 reducer，不碰 DOM、不依赖 Solid。
//
// `idle`、`following`、`settling` 都保持在底部；`settling` 是工作结束后的尾巴，
// 此时选中文字仍会暂停。`detached` 表示滚动容器被 Suspense 摘出文档。
// `flight` 记录我们自己写入的 scrollTop，供下一个 scroll 事件消费——用来区分
// 「内容增长把 scrollTop 拉开」和「用户主动滚走」。
export const SETTLE_MS = 300

export const END_EPSILON = 0.5

export type OverflowAnchorMode = "none" | "auto" | "dynamic"

export type AutoScrollState =
  | {
      readonly status: "idle" | "following"
      readonly detached: boolean
      readonly flight: number | undefined
    }
  | {
      readonly status: "settling"
      readonly attempt: number
      readonly detached: boolean
      readonly flight: number | undefined
    }
  | { readonly status: "paused"; readonly working: boolean; readonly detached: boolean }
  | { readonly status: "disposed" }

export type AutoScrollEvent =
  | { readonly type: "working.changed"; readonly working: boolean; readonly attempt: number }
  | { readonly type: "settle.elapsed"; readonly attempt: number }
  | { readonly type: "scroller.changed"; readonly overflow: boolean }
  | { readonly type: "scroller.detached" }
  | { readonly type: "scroller.reattached"; readonly overflow: boolean }
  | { readonly type: "resize"; readonly overflow: boolean }
  | {
      readonly type: "scroll"
      readonly overflow: boolean
      readonly scrollTop: number
      readonly maxScroll: number
      readonly threshold: number
    }
  | { readonly type: "pause"; readonly overflow: boolean }
  | { readonly type: "scroll.bottom"; readonly force: boolean }
  | { readonly type: "flight.started"; readonly top: number }
  | { readonly type: "disposed" }

export type AutoScrollEffect =
  | { readonly type: "pin.bottom" }
  | { readonly type: "notify.interacted" }
  | { readonly type: "settle.start"; readonly attempt: number }
  | { readonly type: "settle.stop" }

export type AutoScrollTransition = {
  readonly state: AutoScrollState
  readonly effects: readonly AutoScrollEffect[]
}

type Unpaused = Extract<AutoScrollState, { readonly detached: boolean; readonly flight: number | undefined }>

type Paused = Extract<AutoScrollState, { readonly status: "paused" }>

export const IDLE: AutoScrollState = Object.freeze({ status: "idle", detached: false, flight: undefined })

export const FOLLOWING: AutoScrollState = Object.freeze({ status: "following", detached: false, flight: undefined })

export const PAUSED_IDLE: AutoScrollState = Object.freeze({ status: "paused", working: false, detached: false })

export const PAUSED_WORKING: AutoScrollState = Object.freeze({ status: "paused", working: true, detached: false })

export const DISPOSED: AutoScrollState = Object.freeze({ status: "disposed" })

const NONE: readonly AutoScrollEffect[] = Object.freeze([])

const PIN: readonly AutoScrollEffect[] = Object.freeze([Object.freeze({ type: "pin.bottom" })])

const NOTIFY = Object.freeze({ type: "notify.interacted" })

const SETTLE_STOP = Object.freeze({ type: "settle.stop" })

const PAUSE: readonly AutoScrollEffect[] = Object.freeze([NOTIFY])

const STOP: readonly AutoScrollEffect[] = Object.freeze([SETTLE_STOP])

const STOP_AND_PIN: readonly AutoScrollEffect[] = Object.freeze([SETTLE_STOP, ...PIN])

const STOP_AND_PAUSE: readonly AutoScrollEffect[] = Object.freeze([SETTLE_STOP, NOTIFY])

// scroll/resize 每帧都来；常见结果预构建，热路径不分配。
const SINGLETONS = [IDLE, FOLLOWING, PAUSED_IDLE, PAUSED_WORKING, DISPOSED]

const KEEP = new Map<AutoScrollState, AutoScrollTransition>(
  SINGLETONS.map((state) => [state, Object.freeze({ state, effects: NONE })]),
)

const PINNED = new Map<AutoScrollState, AutoScrollTransition>(
  SINGLETONS.map((state) => [state, Object.freeze({ state, effects: PIN })]),
)

export function createAutoScrollState(working: boolean) {
  return working ? FOLLOWING : IDLE
}

export function transitionAutoScroll(state: AutoScrollState, event: AutoScrollEvent): AutoScrollTransition {
  if (state.status === "disposed") return to(state, NONE)

  if (event.type === "disposed") return to(DISPOSED, state.status === "settling" ? STOP : NONE)

  if (state.status === "paused") return transitionPaused(state, event)

  return transitionUnpaused(state, event)
}

export function selectUserScrolled(state: AutoScrollState) {
  return state.status === "paused"
}

export function selectOverflowAnchor(state: AutoScrollState, mode: OverflowAnchorMode = "dynamic") {
  if (mode !== "dynamic") return mode

  return state.status === "paused" ? "auto" : "none"
}

/** 选中文字只在内容还会在选区下面移动时暂停。 */
export function selectPausesOnSelection(state: AutoScrollState) {
  return state.status === "following" || state.status === "settling"
}

function transitionPaused(state: Paused, event: Exclude<AutoScrollEvent, { type: "disposed" }>) {
  switch (event.type) {
    case "working.changed":
      return to(event.working === state.working ? state : paused(event.working, state.detached), NONE)
    // 新 viewport 渲染后才会被测量；它渲染出来后的第一个 resize 若不可滚动就结束暂停。
    case "scroller.changed":
      return to(paused(state.working, false), NONE)
    case "scroller.detached":
      return to(state.detached ? state : paused(state.working, true), NONE)
    case "scroller.reattached":
      if (!state.detached) return to(state, NONE)

      return to(event.overflow ? paused(state.working, false) : resumed(state, false), NONE)
    case "resize":
    case "pause":
      if (state.detached || event.overflow) return to(state, NONE)

      return to(resumed(state, false), NONE)
    case "scroll":
      if (state.detached || !atBottom(event)) return to(state, NONE)

      return to(resumed(state, false), NONE)
    case "scroll.bottom":
      if (!event.force) return to(state, NONE)

      return to(resumed(state, state.detached), state.detached ? NONE : PIN)
    case "settle.elapsed":
    case "flight.started":
      return to(state, NONE)
  }
}

function transitionUnpaused(
  state: Unpaused,
  event: Exclude<AutoScrollEvent, { type: "disposed" }>,
): AutoScrollTransition {
  switch (event.type) {
    case "working.changed":
      if (event.working && state.status === "following") return to(state, NONE)

      if (event.working) return to(unpaused("following", 0, state.detached, state.flight), follow(state))

      if (state.status !== "following") return to(state, NONE)

      return {
        state: unpaused("settling", event.attempt, state.detached, state.flight),
        effects: [{ type: "settle.start", attempt: event.attempt }],
      }
    case "settle.elapsed":
      if (state.status !== "settling" || state.attempt !== event.attempt) return to(state, NONE)

      return to(unpaused("idle", 0, state.detached, state.flight), NONE)
    case "scroller.changed":
      return to(patch(state, false, undefined), event.overflow ? PIN : NONE)
    case "scroller.detached":
      return to(patch(state, true, undefined), NONE)
    case "scroller.reattached":
      if (!state.detached) return to(state, NONE)

      return to(patch(state, false, state.flight), event.overflow ? PIN : NONE)
    case "resize":
      if (state.detached || !event.overflow) return to(state, NONE)

      return to(state, PIN)
    case "scroll":
      if (state.detached) return to(state, NONE)

      if (atBottom(event)) return to(patch(state, false, undefined), NONE)

      // 内容在我们写入与它的 scroll 事件之间长大了：补一次到底，而不是当成用户滚走。
      if (state.flight !== undefined && Math.abs(event.scrollTop - state.flight) <= END_EPSILON)
        return to(patch(state, false, undefined), PIN)

      return pause(state)
    case "pause":
      if (state.detached || !event.overflow) return to(state, NONE)

      return pause(state)
    case "scroll.bottom":
      return to(state, state.detached ? NONE : PIN)
    case "flight.started":
      if (state.detached) return to(state, NONE)

      return to(patch(state, false, event.top), NONE)
  }
}

function atBottom(event: Extract<AutoScrollEvent, { type: "scroll" }>) {
  return !event.overflow || event.maxScroll - event.scrollTop < event.threshold
}

function pause(state: Unpaused) {
  return to(paused(state.status === "following", false), state.status === "settling" ? STOP_AND_PAUSE : PAUSE)
}

function follow(state: Unpaused) {
  if (state.status === "settling") return state.detached ? STOP : STOP_AND_PIN

  return state.detached ? NONE : PIN
}

function to(state: AutoScrollState, effects: readonly AutoScrollEffect[]): AutoScrollTransition {
  const cached = effects === NONE ? KEEP.get(state) : effects === PIN ? PINNED.get(state) : undefined

  return cached ?? { state, effects }
}

function patch(state: Unpaused, detached: boolean, flight: number | undefined) {
  if (state.detached === detached && state.flight === flight) return state

  return unpaused(state.status, state.status === "settling" ? state.attempt : 0, detached, flight)
}

function unpaused(
  status: Unpaused["status"],
  attempt: number,
  detached: boolean,
  flight: number | undefined,
): AutoScrollState {
  if (status === "settling") return { status, attempt, detached, flight }

  if (!detached && flight === undefined) return status === "idle" ? IDLE : FOLLOWING

  return { status, detached, flight }
}

function paused(working: boolean, detached: boolean): AutoScrollState {
  if (!detached) return working ? PAUSED_WORKING : PAUSED_IDLE

  return { status: "paused", working, detached }
}

function resumed(state: Paused, detached: boolean) {
  return unpaused(state.working ? "following" : "idle", 0, detached, undefined)
}
