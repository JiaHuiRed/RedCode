import type { PermissionRequest, Session } from "@redcode-ai/sdk/v2/client"
import { cmp } from "./utils"
import { SESSION_RECENT_LIMIT, SESSION_RECENT_WINDOW } from "./types"

export function sessionUpdatedAt(session: Session) {
  return session.time.updated ?? session.time.created
}

export function compareSessionRecent(a: Session, b: Session) {
  const aUpdated = sessionUpdatedAt(a)
  const bUpdated = sessionUpdatedAt(b)
  if (aUpdated !== bUpdated) return bUpdated - aUpdated
  return cmp(a.id, b.id)
}

export function takeRecentSessions(sessions: Session[], limit: number, cutoff: number) {
  if (limit <= 0) return [] as Session[]
  const selected: Session[] = []
  const seen = new Set<string>()
  for (const session of sessions) {
    if (!session?.id) continue
    if (seen.has(session.id)) continue
    seen.add(session.id)
    if (sessionUpdatedAt(session) <= cutoff) continue
    const index = selected.findIndex((x) => compareSessionRecent(session, x) < 0)
    if (index === -1) selected.push(session)
    if (index !== -1) selected.splice(index, 0, session)
    if (selected.length > limit) selected.pop()
  }
  return selected
}

export function trimSessions(
  input: Session[],
  options: {
    limit: number
    permission: Record<string, PermissionRequest[]>
    now?: number
    protect?: (sessionID: string) => boolean
  },
) {
  const limit = Math.max(0, options.limit)
  const cutoff = (options.now ?? Date.now()) - SESSION_RECENT_WINDOW
  const all = input
    .filter((s) => !!s?.id)
    .filter((s) => !s.time?.archived)
    .sort((a, b) => cmp(a.id, b.id))
  const roots = all.filter((s) => !s.parentID)
  roots.sort(compareSessionRecent)
  const children = all.filter((s) => !!s.parentID)
  const base = roots.slice(0, limit)
  const recent = takeRecentSessions(roots.slice(limit), SESSION_RECENT_LIMIT, cutoff)
  const keepRoots = [...base, ...recent]
  const keepRootIds = new Set(keepRoots.map((s) => s.id))
  const keepChildren = children.filter((s) => {
    if (s.parentID && keepRootIds.has(s.parentID)) return true
    const perms = options.permission[s.id] ?? []
    if (perms.length > 0) return true
    return sessionUpdatedAt(s) > cutoff
  })
  const kept = [...keepRoots, ...keepChildren]
  // 261107 Red 前台会话的列表项也要保，不只是缓存：getSession 只查 store.session，
  // 被裁出列表后页面取不到会话（child() 判假、子会话变成可输入且失去返回入口）。
  // 补回最多多 1-2 条，远超被误判成「已删除」的代价。
  const protect = options.protect
  if (!protect) return kept.sort((a, b) => cmp(a.id, b.id))
  const keptIDs = new Set(kept.map((s) => s.id))
  const rescued = all.filter((s) => !keptIDs.has(s.id) && protect(s.id))
  // 261107 Red RC-02 边界：救援的父链要跟着走——前台子会话被救回而父会话被裁，
  // child() 查不到父级判假，子会话变成可输入且失去返回父会话入口（父子导航丢失）。
  // 沿 parentID 向上补齐到已保留的祖先为止；归档父级不在 all 里，原地停住。
  const byID = new Map(all.map((s) => [s.id, s]))
  const rescuedIDs = new Set(rescued.map((s) => s.id))
  for (const item of rescued) {
    let cursor = item.parentID
    while (cursor && !keptIDs.has(cursor) && !rescuedIDs.has(cursor)) {
      const parent = byID.get(cursor)
      if (!parent) break
      rescuedIDs.add(cursor)
      rescued.push(parent)
      cursor = parent.parentID
    }
  }
  return [...kept, ...rescued].sort((a, b) => cmp(a.id, b.id))
}
