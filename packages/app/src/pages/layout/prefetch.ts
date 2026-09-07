import { batch, createEffect, untrack } from "solid-js"
import { produce, reconcile } from "solid-js/store"
import type { Message, Session } from "@redcode-ai/sdk/v2/client"
import { retry } from "@redcode-ai/core/util/retry"
import {
  clearSessionPrefetch,
  clearSessionPrefetchInflight,
  getSessionPrefetch,
  isSessionPrefetchCurrent,
  runSessionPrefetch,
  setSessionPrefetch,
  shouldSkipSessionPrefetch,
} from "@/context/global-sync/session-prefetch"
import { dropSessionCaches, pickSessionCacheEvictions } from "@/context/global-sync/session-cache"
import { foregroundMessageLoads } from "@/context/foreground-loads"
import { pathKey } from "@/utils/path-key"

type PrefetchQueue = {
  inflight: Set<string>
  pending: string[]
  pendingSet: Set<string>
  running: number
}

export function createPrefetch(deps: {
  visibleSessionDirs: () => string[]
  currentDir: () => string
  sessionId: () => string | undefined
  sessions: () => Session[]
  globalSync: ReturnType<typeof import("@/context/server-sync").useServerSync>
  globalSDK: ReturnType<typeof import("@/context/global-sdk").useGlobalSDK>
  route: () => unknown
}) {
  const { visibleSessionDirs, currentDir, sessionId, sessions, globalSync, globalSDK, route } = deps

  // 260907 ZCode 预取降载（GUI 性能审计问题 6）：chunk 从 200 降到 40。
  // 预取的职责是「点开秒有内容」——40 条足够首屏 paint，且载荷与前台刷新页同量级；
  // 此前 200 条全量 parts（base64 图 + summary.diffs 内联）和前台首开一样重，
  // 会话列表点来点去时后台持续下载几百 MB 级 JSON 还挤占连接池。深历史由打开后的
  // loadMore/loadThrough 分页补，不靠预取。skip 判定（shouldSkipSessionPrefetch 的
  // info.limit > chunk）语义不变：前台已加载更全的窗口时照旧跳过。
  const prefetchChunk = 40
  const prefetchConcurrency = 2
  const prefetchPendingLimit = 10
  const span = 4
  const prefetchToken = { value: 0 }
  const prefetchQueues = new Map<string, PrefetchQueue>()
  const PUMP_YIELD_MS = 250
  let pumpYieldTimer: ReturnType<typeof setTimeout> | undefined

  const PREFETCH_MAX_SESSIONS_PER_DIR = 10
  const prefetchedByDir = new Map<string, Set<string>>()

  const lruFor = (directory: string) => {
    const existing = prefetchedByDir.get(directory)
    if (existing) return existing
    const created = new Set<string>()
    prefetchedByDir.set(directory, created)
    return created
  }

  const markPrefetched = (directory: string, sessionID: string) => {
    const lru = lruFor(directory)
    return pickSessionCacheEvictions({
      seen: lru,
      keep: sessionID,
      limit: PREFETCH_MAX_SESSIONS_PER_DIR,
      preserve: sessionId() && pathKey(directory) === pathKey(currentDir()) ? [sessionId()!] : undefined,
    })
  }

  createEffect(() => {
    const active = new Set(visibleSessionDirs())
    for (const directory of prefetchedByDir.keys()) {
      if (active.has(directory)) continue
      prefetchedByDir.delete(directory)
    }
  })

  createEffect(() => {
    route()
    const url = globalSDK.url
    void url
    prefetchToken.value += 1
    clearSessionPrefetchInflight()
    prefetchQueues.clear()
  })

  createEffect(() => {
    const visible = new Set(visibleSessionDirs())
    for (const [directory, q] of prefetchQueues) {
      if (visible.has(directory)) continue
      q.pending.length = 0
      q.pendingSet.clear()
      if (q.running === 0) prefetchQueues.delete(directory)
    }
  })

  const queueFor = (directory: string) => {
    const existing = prefetchQueues.get(directory)
    if (existing) return existing

    const created: PrefetchQueue = {
      inflight: new Set(),
      pending: [],
      pendingSet: new Set(),
      running: 0,
    }
    prefetchQueues.set(directory, created)
    return created
  }

  // 260814 Red 合并排序改 time.created（ID 48 位回绕后字典序失真，见 @/utils/id）。
  // Part 的 time 是推理计时（{start,end}）而非 created，无 created 时退化为 ID 字典序
  // （同消息内 parts 回绕概率趋零），故这里用本地比较而非 compareTime。
  const mergeByID = <T extends { id: string; time?: unknown }>(current: T[], incoming: T[]) => {
    const createdOf = (item: T) => (item.time as { created?: number } | undefined)?.created
    const cmp = (a: T, b: T) => {
      const ac = createdOf(a)
      const bc = createdOf(b)
      if (ac !== undefined && bc !== undefined && ac !== bc) return ac - bc
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    }
    if (current.length === 0) {
      return incoming.slice().sort(cmp)
    }

    const map = new Map<string, T>()
    for (const item of current) {
      map.set(item.id, item)
    }
    for (const item of incoming) {
      map.set(item.id, item)
    }
    return [...map.values()].sort(cmp)
  }

  async function prefetchMessages(directory: string, sessionID: string, token: number) {
    const [store, setStore] = globalSync.child(directory, { bootstrap: false })

    return runSessionPrefetch({
      directory,
      sessionID,
      task: (rev) =>
        retry(() => globalSDK.client.session.messages({ directory, sessionID, limit: prefetchChunk }))
          .then((messages) => {
            if (prefetchToken.value !== token) return
            if (!isSessionPrefetchCurrent(directory, sessionID, rev)) return

            const items = (messages.data ?? []).filter((x: any) => !!x?.info?.id)
            const next = items.map((x: any) => x.info).filter((m: any): m is Message => !!m?.id)
            const sorted = mergeByID([], next)
            const stale = markPrefetched(directory, sessionID)
            const cursor = messages.response.headers.get("x-next-cursor") ?? undefined
            const meta = {
              limit: sorted.length,
              cursor,
              complete: !cursor,
              at: Date.now(),
            }

            if (stale.length > 0) {
              clearSessionPrefetch(directory, stale)
              for (const id of stale) {
                globalSync.todo.set(id, undefined)
              }
            }

            const current = store.message[sessionID] ?? []
            const merged = mergeByID(
              current.filter((item: any): item is Message => !!item?.id),
              sorted,
            )

            if (!isSessionPrefetchCurrent(directory, sessionID, rev)) return

            batch(() => {
              if (stale.length > 0) {
                setStore(
                  produce((draft: any) => {
                    dropSessionCaches(draft, stale)
                  }),
                )
              }

              setStore("message", sessionID, reconcile(merged, { key: "id" }))

              for (const message of items) {
                const currentParts = store.part[message.info.id] ?? []
                const mergedParts = mergeByID(
                  currentParts.filter(
                    (item: any): item is (typeof currentParts)[number] & { id: string } => !!item?.id,
                  ),
                  message.parts.filter(
                    (item: any): item is (typeof message.parts)[number] & { id: string } => !!item?.id,
                  ),
                )

                setStore("part", message.info.id, reconcile(mergedParts, { key: "id" }))
              }
            })

            return meta
          })
          .catch(() => undefined),
    })
  }

  const pumpPrefetch = (directory: string) => {
    const q = queueFor(directory)
    if (q.running >= prefetchConcurrency) return

    // 260907 ZCode 前台正在拉消息（fetchMessages 在途）时让路：连接池优先供给用户
    // 正在看的会话，预取延迟 250ms 再试。预取不经 fetchMessages，不会被自己挡死；
    // 队列清空后重试是空转，无害。
    if (foregroundMessageLoads() > 0) {
      if (pumpYieldTimer) return
      pumpYieldTimer = setTimeout(() => {
        pumpYieldTimer = undefined
        for (const dir of prefetchQueues.keys()) pumpPrefetch(dir)
      }, PUMP_YIELD_MS)
      return
    }

    const sessionID = q.pending.shift()
    if (!sessionID) return

    q.pendingSet.delete(sessionID)
    q.inflight.add(sessionID)
    q.running += 1

    const token = prefetchToken.value

    void prefetchMessages(directory, sessionID, token).finally(() => {
      q.running -= 1
      q.inflight.delete(sessionID)
      pumpPrefetch(directory)
    })
  }

  const prefetchSession = (session: Session, priority: "high" | "low" = "low") => {
    const directory = session.directory
    if (!directory) return

    const [store] = globalSync.child(directory, { bootstrap: false })
    const cached = untrack(() => {
      const info = getSessionPrefetch(directory, session.id)
      return shouldSkipSessionPrefetch({
        message: store.message[session.id] !== undefined,
        info,
        chunk: prefetchChunk,
      })
    })
    if (cached) return

    const q = queueFor(directory)
    if (q.inflight.has(session.id)) return
    if (q.pendingSet.has(session.id)) {
      if (priority !== "high") return
      const index = q.pending.indexOf(session.id)
      if (index > 0) {
        q.pending.splice(index, 1)
        q.pending.unshift(session.id)
      }
      return
    }

    const lru = lruFor(directory)
    const known = lru.has(session.id)
    if (!known && lru.size >= PREFETCH_MAX_SESSIONS_PER_DIR && priority !== "high") return

    if (priority === "high") q.pending.unshift(session.id)
    if (priority !== "high") q.pending.push(session.id)
    q.pendingSet.add(session.id)

    while (q.pending.length > prefetchPendingLimit) {
      const dropped = q.pending.pop()
      if (!dropped) continue
      q.pendingSet.delete(dropped)
    }

    pumpPrefetch(directory)
  }

  const warm = (sessions: Session[], index: number) => {
    for (let offset = 1; offset <= span; offset++) {
      const next = sessions[index + offset]
      if (next) prefetchSession(next, offset === 1 ? "high" : "low")

      const prev = sessions[index - offset]
      if (prev) prefetchSession(prev, offset === 1 ? "high" : "low")
    }
  }

  createEffect(() => {
    const list = sessions()
    if (list.length === 0) return

    const index = sessionId() ? list.findIndex((s) => s.id === sessionId()) : 0
    if (index === -1) return

    if (!sessionId()) {
      const first = list[index]
      if (first) prefetchSession(first, "high")
    }

    warm(list, index)
  })

  return { prefetchSession, warm }
}
