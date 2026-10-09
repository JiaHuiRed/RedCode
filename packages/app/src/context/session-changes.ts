import type { Message, Part } from "@redcode-ai/sdk/v2/client"
import { compareTime } from "@/utils/id"

// 261009 Red: See docs/notes/implemented/feature/2026-10-09-session-change-catchup.md.
export type SessionChange = {
  id: string
  seq: number
  kind: "session" | "message"
  messageID?: string
}

export type SessionChangesPage = {
  latest: number
  oldest: number | null
  cursor: number
  hasMore: boolean
  reset: boolean
  changes: SessionChange[]
}

export function reconcileChangedMessages(input: {
  current: Message[]
  ids: string[]
  staged: Map<string, { message: Message; parts: Part[] } | undefined>
  limit: number
  allowInsert?: boolean
}) {
  const limit = Math.max(1, input.limit)
  const messages = [...input.current]
  const parts = new Map<string, Part[] | undefined>()
  let userChanged = false
  for (const id of input.ids) {
    const index = messages.findIndex((message) => message.id === id)
    const fresh = input.staged.get(id)
    if (!fresh) {
      if (index !== -1) {
        userChanged ||= messages[index]!.role === "user"
        messages.splice(index, 1)
      }
      parts.set(id, undefined)
      continue
    }
    userChanged ||= fresh.message.role === "user"
    if (index === -1) {
      // 261009 Red 旧窗口有更新侧缺口时，在裁边之前跳过窗口外消息，不能先挤掉正在读的历史。
      if (input.allowInsert === false) continue
      let at = messages.findIndex((message) => compareTime(message, fresh.message) > 0)
      if (messages.length >= limit) {
        if (at === 0) continue
        while (messages.length >= limit) {
          const removed = messages.shift()
          if (removed) parts.set(removed.id, undefined)
        }
        at = messages.findIndex((message) => compareTime(message, fresh.message) > 0)
      }
      messages.splice(at === -1 ? messages.length : at, 0, fresh.message)
    } else {
      messages[index] = fresh.message
    }
    parts.set(id, fresh.parts)
  }
  return { messages, parts, userChanged }
}

export function removedMessageIDs(current: Message[], next: Message[]) {
  const fresh = new Set(next.map((message) => message.id))
  return current.filter((message) => !fresh.has(message.id)).map((message) => message.id)
}

// 261009 Red 快照回退只覆盖拉回的尾部窗口：老窗口里早于拉回窗口最旧消息的部分并回结果，
// 用户停在深层历史时不能把已加载的历史从脚下抽走；拉回窗口覆盖到的区域整体替换，已删
// 消息照常清出（removed 按「current 有、合并后没有」计；窗口外更老的消息在回退路径里
// 无从得知是否被删，留待下次整窗加载）。keepCursor = 合并后的窗口仍延伸到拉回窗口以下，
// 分页游标应留在原处（对齐 loadMessages refresh 的 260829 keepCursor 语义）。
export function mergeSnapshotWindow(input: { current: Message[]; fetched: Message[] }) {
  const oldest = input.fetched[0]
  if (!oldest) {
    return {
      messages: input.fetched,
      removed: removedMessageIDs(input.current, input.fetched),
      keepCursor: false,
    }
  }
  const older = input.current.filter((message) => compareTime(message, oldest) < 0)
  const messages = [...older, ...input.fetched]
  return {
    messages,
    removed: removedMessageIDs(input.current, messages),
    keepCursor: older.length > 0,
  }
}

const PAGE_SIZE = 256
const MAX_PAGES = 32
const MAX_CHANGES = PAGE_SIZE * MAX_PAGES
export const isSessionChangeNotFound = (error: unknown) => {
  if (typeof error !== "object" || error === null) return false
  if ("status" in error && error.status === 404) return true
  if (
    "response" in error &&
    typeof error.response === "object" &&
    error.response !== null &&
    "status" in error.response &&
    error.response.status === 404
  )
    return true
  return (
    "cause" in error &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "status" in error.cause &&
    error.cause.status === 404
  )
}

function validatePage(page: SessionChangesPage) {
  if (
    !Number.isSafeInteger(page.latest) ||
    page.latest < -1 ||
    !Number.isSafeInteger(page.cursor) ||
    page.cursor < -1 ||
    (page.oldest !== null && (!Number.isSafeInteger(page.oldest) || page.oldest < 0)) ||
    page.changes.length > PAGE_SIZE
  )
    throw new Error("invalid session changes page")
}

export async function catchUpSessionChanges(input: {
  after: number
  active: () => boolean
  changes: (query: { after: number; until?: number; limit: number }) => Promise<SessionChangesPage>
  messageIDs: (id: string, active: () => boolean) => Promise<void>
  snapshot: (active: () => boolean) => Promise<void>
  apply: (ids: string[], active: () => boolean) => Promise<void>
}) {
  if (!Number.isSafeInteger(input.after) || input.after < -1) throw new Error("invalid session changes cursor")
  if (input.after === -1) {
    let first: SessionChangesPage
    try {
      first = await input.changes({ after: -1, limit: PAGE_SIZE })
    } catch (error) {
      if (!isSessionChangeNotFound(error)) throw error
      if (!input.active()) return { status: "cancelled" } as const
      await input.snapshot(input.active)
      return { status: "unsupported" } as const
    }
    if (!input.active()) return { status: "cancelled" } as const
    validatePage(first)
    await input.snapshot(input.active)
    if (!input.active()) return { status: "cancelled" } as const
    return { status: "applied", cursor: first.latest, messages: [] } as const
  }

  let after = input.after
  let until: number | undefined
  let pages = 0
  let count = 0
  const ids = new Set<string>()

  while (true) {
    if (!input.active()) return { status: "cancelled" } as const
    if (++pages > MAX_PAGES) {
      await input.snapshot(input.active)
      if (!input.active()) return { status: "cancelled" } as const
      return { status: "fallback", cursor: until! } as const
    }
    let page: SessionChangesPage
    try {
      page = await input.changes({ after, ...(until === undefined ? {} : { until }), limit: PAGE_SIZE })
    } catch (error) {
      if (!isSessionChangeNotFound(error)) throw error
      if (!input.active()) return { status: "cancelled" } as const
      await input.snapshot(input.active)
      return { status: "unsupported" } as const
    }
    if (!input.active()) return { status: "cancelled" } as const
    validatePage(page)
    if (page.reset) {
      await input.snapshot(input.active)
      if (!input.active()) return { status: "cancelled" } as const
      return { status: "fallback", cursor: page.cursor } as const
    }
    if (until === undefined) until = page.latest
    if (page.latest < after || page.cursor < after || page.cursor > until) {
      throw new Error("invalid session changes cursor")
    }
    let seq = after
    for (const change of page.changes) {
      if (change.seq !== seq + 1 || change.seq > until) throw new Error("non-contiguous session changes")
      if (change.kind === "message" && !change.messageID) throw new Error("message change is missing messageID")
      seq = change.seq
      if (change.kind === "message" && change.messageID) ids.add(change.messageID)
    }
    if (page.cursor !== seq) throw new Error("session changes cursor skipped markers")
    count += page.changes.length
    if (count > MAX_CHANGES) throw new Error("session changes exceeded 8192 markers")
    if (page.hasMore && (page.cursor <= after || page.changes.length === 0)) {
      throw new Error("session changes page did not advance")
    }
    after = page.cursor
    if (!page.hasMore) {
      if (after !== until) throw new Error("session changes ended before target")
      break
    }
  }

  const changed = [...ids]
  for (const id of changed) {
    if (!input.active()) return { status: "cancelled" } as const
    await input.messageIDs(id, input.active)
  }
  if (!input.active()) return { status: "cancelled" } as const
  await input.apply(changed, input.active)
  if (!input.active()) return { status: "cancelled" } as const
  return { status: "applied", cursor: until!, messages: changed } as const
}

export function createSessionChangeJournal(input: {
  fetch: (query: { after: number; until?: number; limit: number }) => Promise<SessionChangesPage>
  refreshSnapshot: (active: () => boolean) => Promise<void>
  fetchMessage: (messageID: string, active: () => boolean) => Promise<void>
  apply: (messageIDs: string[], active: () => boolean) => Promise<void>
}) {
  let acknowledged: number | undefined
  let generation = 0
  const cursor = () => acknowledged
  const invalidate = () => generation++
  const catchup = async (active: () => boolean) => {
    const started = ++generation
    const current = () => active() && started === generation
    const result = await catchUpSessionChanges({
      after: acknowledged ?? -1,
      active: current,
      changes: input.fetch,
      snapshot: (isCurrent) => input.refreshSnapshot(isCurrent),
      messageIDs: input.fetchMessage,
      apply: (ids, isCurrent) => input.apply(ids, isCurrent),
    })
    if (!current() || result.status === "cancelled" || result.status === "unsupported") return result
    acknowledged = result.cursor
    return result
  }
  return { cursor, invalidate, catchup }
}

export function listenForGlobalReconnect<T extends { name: string; details: { type: string } }>(
  listen: (listener: (event: T) => void) => () => void,
  request: () => void,
) {
  return listen((event) => {
    if (event.name !== "global" || event.details.type !== "server.connected") return
    request()
  })
}
