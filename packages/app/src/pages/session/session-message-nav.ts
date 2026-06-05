import type { UserMessage } from "@redcode-ai/sdk/v2"

export type MessageNavInput = {
  visibleUserMessages: () => UserMessage[]
  scroller: () => HTMLDivElement | undefined
  autoScroll: {
    pause: () => void
    userScrolled: () => boolean
  }
  resumeScroll: () => void
  setStoreMessageId: (id: string | undefined) => void
}

export type MessageNav = ReturnType<typeof createMessageNav>

export function createMessageNav(input: MessageNavInput) {
  let scrollMark = 0
  let messageMark = 0
  let scrollToMessage = (_msg: UserMessage, _behavior: "auto" | "smooth") => {}

  const markScroll = () => {
    scrollMark += 1
  }

  const setActiveMessage = (message: UserMessage | undefined) => {
    messageMark = scrollMark
    input.setStoreMessageId(message?.id)
  }

  const anchor = (id: string) => `message-${id}`

  const cursor = (storeMessageId: string | undefined) => {
    const root = input.scroller()
    if (!root) return storeMessageId

    const box = root.getBoundingClientRect()
    const line = box.top + 100
    const list = [...root.querySelectorAll<HTMLElement>("[data-message-id]")]
      .map((el) => {
        const id = el.dataset.messageId
        if (!id) return

        const rect = el.getBoundingClientRect()
        return { id, top: rect.top, bottom: rect.bottom }
      })
      .filter((item): item is { id: string; top: number; bottom: number } => !!item)

    const shown = list.filter((item) => item.bottom > box.top && item.top < box.bottom)
    const hit = shown.find((item) => item.top <= line && item.bottom >= line)
    if (hit) return hit.id

    const near = [...shown].sort((a, b) => {
      const da = Math.abs(a.top - line)
      const db = Math.abs(b.top - line)
      if (da !== db) return da - db
      return a.top - b.top
    })[0]
    if (near) return near.id

    return list.filter((item) => item.top <= line).at(-1)?.id ?? list[0]?.id ?? storeMessageId
  }

  function navigateMessageByOffset(offset: number, storeMessageId: string | undefined) {
    const msgs = input.visibleUserMessages()
    if (msgs.length === 0) return

    const current = storeMessageId && messageMark === scrollMark ? storeMessageId : cursor(storeMessageId)
    const base = current ? msgs.findIndex((m) => m.id === current) : msgs.length
    const currentIndex = base === -1 ? msgs.length : base
    const targetIndex = currentIndex + offset
    if (targetIndex < 0 || targetIndex > msgs.length) return

    if (targetIndex === msgs.length) {
      input.resumeScroll()
      return
    }

    input.autoScroll.pause()
    scrollToMessage(msgs[targetIndex], "auto")
  }

  return {
    markScroll,
    setActiveMessage,
    anchor,
    cursor,
    navigateMessageByOffset,
    setScrollToMessage: (fn: typeof scrollToMessage) => {
      scrollToMessage = fn
    },
  }
}
