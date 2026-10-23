import type {
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  SessionStatus,
  SnapshotFileDiff,
  Todo,
  Goal,
} from "@redcode-ai/sdk/v2/client"

export const SESSION_CACHE_LIMIT = 40
export const SESSION_PREFETCH_CACHE_LIMIT = 10

export function createSessionCacheLedger(normalizeDirectory: (directory: string) => string = (directory) => directory) {
  const foreground = new Map<string, Set<string>>()
  const prefetch = new Map<string, Set<string>>()

  const touch = (map: Map<string, Set<string>>, directory: string, sessionID: string, limit: number) => {
    const ids = map.get(directory) ?? new Set<string>()
    ids.delete(sessionID)
    ids.add(sessionID)
    map.set(directory, ids)
    const stale: string[] = []
    while (ids.size > limit) {
      const oldest = ids.values().next().value
      if (!oldest) break
      ids.delete(oldest)
      stale.push(oldest)
    }
    return stale
  }

  return {
    foreground(directory: string, sessionID: string) {
      const key = normalizeDirectory(directory)
      prefetch.get(key)?.delete(sessionID)
      return touch(foreground, key, sessionID, SESSION_CACHE_LIMIT)
    },
    prefetch(directory: string, sessionID: string) {
      const key = normalizeDirectory(directory)
      if (foreground.get(key)?.has(sessionID)) return []
      return touch(prefetch, key, sessionID, SESSION_PREFETCH_CACHE_LIMIT)
    },
    canPrefetch(directory: string, sessionID: string) {
      const key = normalizeDirectory(directory)
      const ids = prefetch.get(key)
      return foreground.get(key)?.has(sessionID) === true || ids?.has(sessionID) === true || (ids?.size ?? 0) < SESSION_PREFETCH_CACHE_LIMIT
    },
    hasForeground(directory: string, sessionID: string) {
      return foreground.get(normalizeDirectory(directory))?.has(sessionID) ?? false
    },
    forget(directory: string, sessionID: string) {
      const key = normalizeDirectory(directory)
      foreground.get(key)?.delete(sessionID)
      prefetch.get(key)?.delete(sessionID)
    },
    forgetDirectory(directory: string) {
      const key = normalizeDirectory(directory)
      foreground.delete(key)
      prefetch.delete(key)
    },
  }
}

type SessionCache = {
  session_status: Record<string, SessionStatus | undefined>
  session_diff: Record<string, SnapshotFileDiff[] | undefined>
  todo: Record<string, Todo[] | undefined>
  goal: Record<string, Goal | undefined>
  message: Record<string, Message[] | undefined>
  message_trimmed: Record<string, boolean | undefined>
  part: Record<string, Part[] | undefined>
  permission: Record<string, PermissionRequest[] | undefined>
  question: Record<string, QuestionRequest[] | undefined>
  part_text_accum_delta: Record<string, string | undefined>
}

export function dropSessionCaches(store: SessionCache, sessionIDs: Iterable<string>) {
  const stale = new Set(Array.from(sessionIDs).filter(Boolean))
  if (stale.size === 0) return

  for (const key of Object.keys(store.part)) {
    const parts = store.part[key]
    if (!parts?.some((part) => stale.has(part?.sessionID ?? ""))) continue
    for (const part of parts) {
      delete store.part_text_accum_delta[part.id]
    }
    delete store.part[key]
  }

  for (const sessionID of stale) {
    delete store.message[sessionID]
    // 260904 cc 整个会话的消息都清了，"被截断过"这个标记也必须跟着走——
    // 留着会让重新拉全的会话被 history.more() 误判成还有更老的可拉。
    delete store.message_trimmed[sessionID]
    delete store.todo[sessionID]
    delete store.goal[sessionID]
    delete store.session_diff[sessionID]
    delete store.session_status[sessionID]
    delete store.permission[sessionID]
    delete store.question[sessionID]
  }
}
