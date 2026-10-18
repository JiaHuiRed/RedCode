import { createMemo, mapArray } from "solid-js"
import type { Session, SessionStatus } from "@redcode-ai/sdk/v2/client"

export type TitlebarTab = { dir: string; sessionId: string; href: string }

export type TitlebarTabStore = {
  session: Session[]
  session_status: Record<string, SessionStatus | undefined>
}

export type EnrichedTitlebarTab = TitlebarTab & {
  info: Session
  status?: SessionStatus["type"]
}

export function createTitlebarTabs(tabs: () => TitlebarTab[], peek: (tab: TitlebarTab) => TitlebarTabStore) {
  const mapped = mapArray(tabs, (tab) => {
    // 261018 Red 每个标签独立跟踪会话与状态，不依赖标签列表重新映射。
    // 决策见 docs/notes/implemented/bug-fix/2026-10-18-live-session-title.md。
    const value = createMemo(() => {
      const store = peek(tab)
      const session = store.session.find((item) => item.id === tab.sessionId)
      if (!session) return null
      return {
        ...tab,
        info: session,
        status: store.session_status[tab.sessionId]?.type,
      }
    })
    return value
  })

  return createMemo(() =>
    mapped().flatMap((value) => {
      const tab = value()
      return tab ? [tab] : []
    }),
  )
}
