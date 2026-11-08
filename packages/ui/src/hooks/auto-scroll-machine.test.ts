import { describe, expect, test } from "bun:test"
import {
  createAutoScrollState,
  DISPOSED,
  FOLLOWING,
  IDLE,
  PAUSED_IDLE,
  PAUSED_WORKING,
  selectOverflowAnchor,
  selectPausesOnSelection,
  selectUserScrolled,
  transitionAutoScroll,
} from "./auto-scroll-machine"

const scroll = (scrollTop: number, maxScroll: number, threshold = 10) =>
  ({ type: "scroll", overflow: maxScroll > 0, scrollTop, maxScroll, threshold }) as const

describe("auto scroll machine", () => {
  test("work start follows and pins, work end settles", () => {
    const started = transitionAutoScroll(IDLE, { type: "working.changed", working: true, attempt: 0 })
    expect(started.state).toEqual(FOLLOWING)
    expect(started.effects).toEqual([{ type: "pin.bottom" }])

    const ended = transitionAutoScroll(FOLLOWING, { type: "working.changed", working: false, attempt: 1 })
    expect(ended.state).toEqual({ status: "settling", attempt: 1, detached: false, flight: undefined })
    expect(ended.effects).toEqual([{ type: "settle.start", attempt: 1 }])
  })

  test("settle only ends for the attempt that started it", () => {
    const start = transitionAutoScroll(FOLLOWING, { type: "working.changed", working: false, attempt: 1 })
    const stale = transitionAutoScroll(start.state, { type: "settle.elapsed", attempt: 0 })
    expect(stale.state).toEqual(start.state)

    const done = transitionAutoScroll(start.state, { type: "settle.elapsed", attempt: 1 })
    expect(done.state).toEqual(IDLE)
  })

  test("scrolling away from the bottom pauses and notifies", () => {
    const moved = transitionAutoScroll(FOLLOWING, scroll(100, 1000))
    expect(moved.state).toEqual(PAUSED_WORKING)
    expect(moved.effects).toEqual([{ type: "notify.interacted" }])
  })

  test("scroll back to the bottom resumes", () => {
    const resumed = transitionAutoScroll(PAUSED_WORKING, scroll(995, 1000))
    expect(resumed.state).toEqual(FOLLOWING)
  })

  test("a scroll event at our own flight position catches up instead of pausing", () => {
    const flight = transitionAutoScroll(FOLLOWING, { type: "flight.started", top: 900 })
    expect(flight.state).toEqual({ status: "following", detached: false, flight: 900 })

    const caught = transitionAutoScroll(flight.state, scroll(900, 1000))
    expect(caught.state).toEqual(FOLLOWING)
    expect(caught.effects).toEqual([{ type: "pin.bottom" }])
  })

  test("a scroll event at the bottom clears the flight marker", () => {
    const flight = transitionAutoScroll(FOLLOWING, { type: "flight.started", top: 900 })
    const bottom = transitionAutoScroll(flight.state, scroll(995, 1000))
    expect(bottom.state).toEqual(FOLLOWING)
    expect(bottom.effects).toEqual([])
  })

  test("resize pins while following and is a no-op while paused", () => {
    const pinned = transitionAutoScroll(FOLLOWING, { type: "resize", overflow: true })
    expect(pinned.effects).toEqual([{ type: "pin.bottom" }])

    const paused = transitionAutoScroll(PAUSED_WORKING, { type: "resize", overflow: true })
    expect(paused.state).toEqual(PAUSED_WORKING)
    expect(paused.effects).toEqual([])
  })

  test("an overflowing paused view stays paused on resize", () => {
    const result = transitionAutoScroll(PAUSED_IDLE, { type: "resize", overflow: true })
    expect(result.state).toEqual(PAUSED_IDLE)
  })

  test("a non-overflowing paused view resumes", () => {
    const result = transitionAutoScroll(PAUSED_IDLE, { type: "resize", overflow: false })
    expect(result.state).toEqual(IDLE)
  })

  test("forced scroll to bottom resumes a paused view and pins", () => {
    const forced = transitionAutoScroll(PAUSED_WORKING, { type: "scroll.bottom", force: true })
    expect(forced.state).toEqual(FOLLOWING)
    expect(forced.effects).toEqual([{ type: "pin.bottom" }])

    const plain = transitionAutoScroll(PAUSED_WORKING, { type: "scroll.bottom", force: false })
    expect(plain.state).toEqual(PAUSED_WORKING)
    expect(plain.effects).toEqual([])
  })

  test("wheel pause is ignored when the viewport cannot scroll", () => {
    const result = transitionAutoScroll(FOLLOWING, { type: "pause", overflow: false })
    expect(result.state).toEqual(FOLLOWING)
  })

  test("selectors describe the state for consumers", () => {
    expect(selectUserScrolled(PAUSED_IDLE)).toBe(true)
    expect(selectUserScrolled(FOLLOWING)).toBe(false)
    expect(selectOverflowAnchor(PAUSED_IDLE)).toBe("auto")
    expect(selectOverflowAnchor(FOLLOWING)).toBe("none")
    expect(selectPausesOnSelection(FOLLOWING)).toBe(true)
    expect(selectPausesOnSelection(IDLE)).toBe(false)
  })

  test("dispose stops any pending settle", () => {
    const start = transitionAutoScroll(FOLLOWING, { type: "working.changed", working: false, attempt: 1 })
    const disposed = transitionAutoScroll(start.state, { type: "disposed" })
    expect(disposed.state).toEqual(DISPOSED)
    expect(disposed.effects).toEqual([{ type: "settle.stop" }])
  })

  test("a fresh instance follows when work is already running", () => {
    expect(createAutoScrollState(true)).toEqual(FOLLOWING)
    expect(createAutoScrollState(false)).toEqual(IDLE)
  })
})
