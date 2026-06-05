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
    onScrollerScroll,
  }
}
