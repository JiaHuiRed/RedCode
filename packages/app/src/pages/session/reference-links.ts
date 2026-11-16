// 261116 Red A04：会话内最近引用（有界）——引用块落到草稿后，用户还能从聊天区旁边的轻
// chip 回到来源。只存已成功的引用，不做第二套历史加载器；跳转复用 message-timeline 的
// revealPart / session 的 jumpToTarget 链。模块级 signal：草稿面板重建、切标签后列表仍在。

import { createSignal } from "solid-js"
import { referenceLabel, type ReferenceAnchor } from "@/utils/reference"

export type RecentReference = {
  /** 来源身份（同一片段重复引用只保留最近一条）。 */
  id: string
  sessionID: string
  anchor: ReferenceAnchor
  label: string
  preview: string
  at: number
  /** 来源消息的 time.created（有则用于窗口外定位选方向）。 */
  createdAt?: number
}

/** 每个会话保留的最近引用条数。 */
export const RECENT_REFERENCE_LIMIT = 8
/** 跨会话总数量也要有界：最多保留最近 4 个会话的条目。 */
const SESSION_LIMIT = 4

const [store, setStore] = createSignal<RecentReference[]>([])

const identity = (anchor: ReferenceAnchor) => {
  if (anchor.kind === "message" || anchor.kind === "tool") {
    return `${anchor.messageID ?? ""}:${anchor.partID ?? ""}`
  }
  if (anchor.kind === "terminal") return `terminal:${anchor.terminalID ?? anchor.title ?? ""}`
  if (anchor.kind === "file") return `file:${anchor.path ?? ""}:${anchor.startLine ?? ""}`
  return `unknown:${anchor.label ?? ""}`
}

/** 可定位回来源的锚点；终端/未知来源由各自入口说明，不能在这里假装能跳。 */
export const referenceLocatable = (anchor: ReferenceAnchor) =>
  (anchor.kind === "message" || anchor.kind === "tool") && !!anchor.messageID

export const recentReferences = (sessionID: string) => store().filter((item) => item.sessionID === sessionID)

export function pushRecentReference(input: {
  sessionID: string
  anchor: ReferenceAnchor
  preview: string
  at?: number
  createdAt?: number
}) {
  if (!input.sessionID) return
  const entry: RecentReference = {
    id: identity(input.anchor),
    sessionID: input.sessionID,
    anchor: input.anchor,
    label: referenceLabel(input.anchor),
    preview: input.preview.replace(/\s+/g, " ").slice(0, 60),
    at: input.at ?? Date.now(),
    createdAt: input.createdAt,
  }
  setStore((prev) => {
    const merged = [entry, ...prev.filter((item) => !(item.sessionID === entry.sessionID && item.id === entry.id))]
    const perSession = new Map<string, number>()
    const kept: RecentReference[] = []
    for (const item of merged) {
      const count = perSession.get(item.sessionID) ?? 0
      if (count >= RECENT_REFERENCE_LIMIT) continue
      perSession.set(item.sessionID, count + 1)
      kept.push(item)
    }
    const sessions = new Set<string>()
    for (const item of kept) {
      if (sessions.size >= SESSION_LIMIT && !sessions.has(item.sessionID)) continue
      sessions.add(item.sessionID)
    }
    return kept.filter((item) => sessions.has(item.sessionID))
  })
}

export function clearRecentReferences(sessionID: string) {
  setStore((prev) => prev.filter((item) => item.sessionID !== sessionID))
}
