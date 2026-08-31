import { batch, createMemo } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { Binary } from "@redcode-ai/core/util/binary"
import { retry } from "@redcode-ai/core/util/retry"
import {
  clearSessionPrefetch,
  getSessionPrefetch,
  getSessionPrefetchPromise,
  setSessionPrefetch,
} from "./global-sync/session-prefetch"
import { useServerSync, type ServerSyncContext } from "./server-sync"
import type { Message, OpencodeClient, Part } from "@redcode-ai/sdk/v2/client"
import { SESSION_CACHE_LIMIT, dropSessionCaches, pickSessionCacheEvictions } from "./global-sync/session-cache"
import { diffs as list, message as clean } from "@/utils/diffs"
import { compareTime } from "@/utils/id"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])

// 260831 Red 语义序：reasoning（思考链）恒置最前，段内保持字典序（=落库时间序）。
//   GLM-5.3-Flash 首轮流式里 tool_calls 会先于 thinking 到达，服务端按到达序写时间戳，
//   字典序会把工具气泡甩到思考链前面（哥哥 260831 撞上）；思考链放最前是跨 vendor
//   的稳定语义（GUI 正常会话一直是思考链在最上）。
function sortParts(parts: Part[]) {
  const sorted = parts.filter((part) => !!part?.id).sort((a, b) => cmp(a.id, b.id))
  const reasoning = sorted.filter((part) => part.type === "reasoning")
  if (reasoning.length === 0 || reasoning.length === sorted.length) return sorted
  return [...reasoning, ...sorted.filter((part) => part.type !== "reasoning")]
}

function runInflight(map: Map<string, Promise<void>>, key: string, task: () => Promise<void>) {
  const pending = map.get(key)
  if (pending) return pending
  const promise = task().finally(() => {
    map.delete(key)
  })
  map.set(key, promise)
  return promise
}

const keyFor = (directory: string, id: string) => `${directory}\n${id}`

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// 260831 cc 消息的顺序一律按 compareTime（时间优先、ID 只做 tie-break），不用字典序。
//   ID 是时间编码且会回绕：实测同一会话里 8/31 的 `msg_001a…` 字典序**小于** 7/29 的
//   `msg_fac…`，按 ID 排会把新的一轮甩到会话最前面（哥哥 260830 撞上，以为消息丢了）。
//   260814 那批（#109）只把「比较型」消费者换成了 compareTime，没动数组自身的顺序，于是
//   位置型消费者仍然错——而直接读 store 的消费者有 8 处，逐个排序是打地鼠。这里把顺序
//   钉在 store 上，一处解决。
//   代价：定位不能再用 Binary.search（它假设字典序）。改成线性 findIndex——消息数组最多
//   几百条，而插入本来就要 O(n) 拷贝，这点开销可以忽略。
const byTime = <T extends { id: string; time?: { created?: number } }>(a: T, b: T) => compareTime(a, b)

/** 按时间序找插入位（第一个比 item 晚的位置；都不晚则追加到末尾）。 */
function insertIndex<T extends { id: string; time?: { created?: number } }>(list: readonly T[], item: T) {
  const at = list.findIndex((x) => compareTime(x, item) > 0)
  return at === -1 ? list.length : at
}

/** 按 id 定位（删除/更新用）。数组已不是字典序，不能二分。 */
const indexOfID = <T extends { id: string }>(list: readonly T[], id: string) => list.findIndex((x) => x.id === id)

function merge<T extends { id: string; time?: { created?: number } }>(a: readonly T[], b: readonly T[]) {
  const map = new Map(a.map((item) => [item.id, item] as const))
  for (const item of b) map.set(item.id, item)
  return [...map.values()].sort(byTime)
}

type OptimisticStore = {
  message: Record<string, Message[] | undefined>
  part: Record<string, Part[] | undefined>
}

type OptimisticAddInput = {
  sessionID: string
  message: Message
  parts: Part[]
}

type OptimisticRemoveInput = {
  sessionID: string
  messageID: string
}

type OptimisticItem = {
  message: Message
  parts: Part[]
}

type MessagePage = {
  session: Message[]
  part: { id: string; part: Part[] }[]
  cursor?: string
  complete: boolean
}

const hasParts = (parts: Part[] | undefined, want: Part[]) => {
  if (!parts) return want.length === 0
  return want.every((part) => parts.some((item) => item.id === part.id))
}

const mergeParts = (parts: Part[] | undefined, want: Part[]) => {
  if (!parts) return sortParts(want)
  const next = [...parts]
  let changed = false
  for (const part of want) {
    if (next.some((item) => item.id === part.id)) continue
    // 数组已是语义序（reasoning 恒最前），不能用词典序二分：按语义段线性插位——
    // reasoning 插到第一个非 reasoning 之前；其他插到同段内第一个字典序更大的之前。
    const at = next.findIndex((item) => {
      if (part.type === "reasoning") return item.type !== "reasoning"
      if (item.type === "reasoning") return false
      return cmp(item.id, part.id) > 0
    })
    next.splice(at === -1 ? next.length : at, 0, part)
    changed = true
  }
  if (!changed) return parts
  return next
}

export function mergeOptimisticPage(page: MessagePage, items: OptimisticItem[]) {
  if (items.length === 0) return { ...page, confirmed: [] as string[] }

  const session = [...page.session]
  const part = new Map(page.part.map((item) => [item.id, sortParts(item.part)]))
  const confirmed: string[] = []

  for (const item of items) {
    // session 已是时间序（见上方 byTime 注释），不能二分：回绕后乐观消息的 ID 偏小，
    // 会被插到时间线最前面，且 found 误判为 false —— 重复插入且 confirmed 永远不填，
    // 乐观气泡不消。
    const at = indexOfID(session, item.message.id)
    const found = at !== -1
    if (!found) session.splice(insertIndex(session, item.message), 0, item.message)

    const current = part.get(item.message.id)
    if (found && hasParts(current, item.parts)) {
      confirmed.push(item.message.id)
      continue
    }

    part.set(item.message.id, mergeParts(current, item.parts))
  }

  return {
    cursor: page.cursor,
    complete: page.complete,
    session,
    part: [...part.entries()].sort((a, b) => cmp(a[0], b[0])).map(([id, part]) => ({ id, part })),
    confirmed,
  }
}

export function applyOptimisticAdd(draft: OptimisticStore, input: OptimisticAddInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    messages.splice(insertIndex(messages, input.message), 0, input.message)
  } else {
    draft.message[input.sessionID] = [input.message]
  }
  draft.part[input.message.id] = sortParts(input.parts)
}

export function applyOptimisticRemove(draft: OptimisticStore, input: OptimisticRemoveInput) {
  const messages = draft.message[input.sessionID]
  if (messages) {
    const at = indexOfID(messages, input.messageID)
    if (at !== -1) messages.splice(at, 1)
  }
  delete draft.part[input.messageID]
}

function setOptimisticAdd(setStore: (...args: unknown[]) => void, input: OptimisticAddInput) {
  setStore("message", input.sessionID, (messages: Message[] | undefined) => {
    if (!messages) return [input.message]
    const next = [...messages]
    next.splice(insertIndex(messages, input.message), 0, input.message)
    return next
  })
  setStore("part", input.message.id, sortParts(input.parts))
}

function setOptimisticRemove(setStore: (...args: unknown[]) => void, input: OptimisticRemoveInput) {
  setStore("message", input.sessionID, (messages: Message[] | undefined) => {
    if (!messages) return messages
    const at = indexOfID(messages, input.messageID)
    if (at === -1) return messages
    const next = [...messages]
    next.splice(at, 1)
    return next
  })
  setStore("part", (part: Record<string, Part[] | undefined>) => {
    if (!(input.messageID in part)) return part
    const next = { ...part }
    delete next[input.messageID]
    return next
  })
}

export const createDirSyncContext = (client: OpencodeClient, directory: string) => {
  const globalSync: ServerSyncContext = useServerSync()

  type Child = ReturnType<(typeof globalSync)["child"]>
  type Setter = Child[1]

  const current = createMemo(() => globalSync.child(directory))
  const target = (directory?: string) => {
    if (!directory || directory === directory) return current()
    return globalSync.child(directory)
  }
  const absolute = (path: string) => (current()[0].path.directory + "/" + path).replace("//", "/")
  const initialMessagePageSize = 40
  const historyMessagePageSize = 80
  const inflight = new Map<string, Promise<void>>()
  const inflightDiff = new Map<string, Promise<void>>()
  const inflightTodo = new Map<string, Promise<void>>()
  const inflightGoal = new Map<string, Promise<void>>()
  const optimistic = new Map<string, Map<string, OptimisticItem>>()
  const maxDirs = 30
  const seen = new Map<string, Set<string>>()
  const [meta, setMeta] = createStore({
    limit: {} as Record<string, number>,
    cursor: {} as Record<string, string | undefined>,
    complete: {} as Record<string, boolean>,
    loading: {} as Record<string, boolean>,
  })

  const getSession = (sessionID: string) => {
    const store = current()[0]
    const match = Binary.search(store.session, sessionID, (s) => s.id)
    if (match.found) return store.session[match.index]
    return undefined
  }

  const setOptimistic = (directory: string, sessionID: string, item: OptimisticItem) => {
    const key = keyFor(directory, sessionID)
    const list = optimistic.get(key)
    if (list) {
      list.set(item.message.id, { message: item.message, parts: sortParts(item.parts) })
      return
    }
    optimistic.set(key, new Map([[item.message.id, { message: item.message, parts: sortParts(item.parts) }]]))
  }

  const clearOptimistic = (directory: string, sessionID: string, messageID?: string) => {
    const key = keyFor(directory, sessionID)
    if (!messageID) {
      optimistic.delete(key)
      return
    }

    const list = optimistic.get(key)
    if (!list) return
    list.delete(messageID)
    if (list.size === 0) optimistic.delete(key)
  }

  const getOptimistic = (directory: string, sessionID: string) => [
    ...(optimistic.get(keyFor(directory, sessionID))?.values() ?? []),
  ]

  const seenFor = (directory: string) => {
    const existing = seen.get(directory)
    if (existing) {
      seen.delete(directory)
      seen.set(directory, existing)
      return existing
    }
    const created = new Set<string>()
    seen.set(directory, created)
    while (seen.size > maxDirs) {
      const first = seen.keys().next().value
      if (!first) break
      const stale = [...(seen.get(first) ?? [])]
      seen.delete(first)
      const [, setStore] = globalSync.child(first, { bootstrap: false })
      evict(first, setStore, stale)
    }
    return created
  }

  const clearMeta = (directory: string, sessionIDs: string[]) => {
    if (sessionIDs.length === 0) return
    for (const sessionID of sessionIDs) {
      clearOptimistic(directory, sessionID)
    }
    setMeta(
      produce((draft) => {
        for (const sessionID of sessionIDs) {
          const key = keyFor(directory, sessionID)
          delete draft.limit[key]
          delete draft.cursor[key]
          delete draft.complete[key]
          delete draft.loading[key]
        }
      }),
    )
  }

  const evict = (directory: string, setStore: Setter, sessionIDs: string[]) => {
    if (sessionIDs.length === 0) return
    clearSessionPrefetch(directory, sessionIDs)
    for (const sessionID of sessionIDs) {
      globalSync.todo.set(sessionID, undefined)
    }
    setStore(
      produce((draft) => {
        dropSessionCaches(draft, sessionIDs)
      }),
    )
    clearMeta(directory, sessionIDs)
  }

  const touch = (directory: string, setStore: Setter, sessionID: string) => {
    const stale = pickSessionCacheEvictions({
      seen: seenFor(directory),
      keep: sessionID,
      limit: SESSION_CACHE_LIMIT,
    })
    evict(directory, setStore, stale)
  }

  const fetchMessages = async (input: { client: typeof client; sessionID: string; limit: number; before?: string }) => {
    const messages = await retry(() =>
      input.client.session.messages({ sessionID: input.sessionID, limit: input.limit, before: input.before }),
    )
    const items = (messages.data ?? []).filter((x) => !!x?.info?.id)
    const session = items.map((x) => clean(x.info)).sort(byTime)
    const part = items.map((message) => ({ id: message.info.id, part: sortParts(message.parts) }))
    const cursor = messages.response.headers.get("x-next-cursor") ?? undefined
    return {
      session,
      part,
      cursor,
      complete: !cursor,
    }
  }

  const tracked = (directory: string, sessionID: string) => seen.get(directory)?.has(sessionID) ?? false

  const loadMessages = async (input: {
    directory: string
    client: typeof client
    setStore: Setter
    sessionID: string
    limit: number
    before?: string
    mode?: "replace" | "prepend" | "refresh"
  }) => {
    const key = keyFor(input.directory, input.sessionID)
    if (meta.loading[key]) return

    setMeta("loading", key, true)
    await fetchMessages(input)
      .then((page) => {
        if (!tracked(input.directory, input.sessionID)) return
        const next = mergeOptimisticPage(page, getOptimistic(input.directory, input.sessionID))
        for (const messageID of next.confirmed) {
          clearOptimistic(input.directory, input.sessionID, messageID)
        }
        const [store] = globalSync.child(input.directory, { bootstrap: false })
        // 260829 cc refresh 与 prepend 一样并集合并，区别只在游标：prepend 拉的是更老的一页，
        // 游标要往前推；refresh 拉的是最新一页，若手上已有更深的历史，推游标等于把历史窗口
        // 的回溯位置重置到很近的地方，下次往回翻会重复拉已有的消息。
        const isMerge = input.mode === "prepend" || input.mode === "refresh"
        const cached = isMerge ? (store.message[input.sessionID] ?? []) : []
        const message = isMerge ? merge(cached, next.session) : next.session
        const keepCursor = input.mode === "refresh" && cached.length > next.session.length
        const cursor = keepCursor ? (meta.cursor[key] ?? next.cursor) : next.cursor
        const complete = keepCursor ? (meta.complete[key] ?? next.complete) : next.complete
        batch(() => {
          input.setStore("message", input.sessionID, reconcile(message, { key: "id" }))
          for (const p of next.part) {
            const filtered = p.part.filter((x) => !SKIP_PARTS.has(x.type))
            if (filtered.length) input.setStore("part", p.id, filtered)
          }
          setMeta("limit", key, message.length)
          setMeta("cursor", key, cursor)
          setMeta("complete", key, complete)
          setSessionPrefetch({
            directory: input.directory,
            sessionID: input.sessionID,
            limit: message.length,
            cursor,
            complete,
          })
        })
      })
      .finally(() => {
        setMeta(
          produce((draft) => {
            if (!tracked(input.directory, input.sessionID)) {
              delete draft.loading[key]
              return
            }
            draft.loading[key] = false
          }),
        )
      })
  }

  return {
    get data() {
      return current()[0]
    },
    get set(): Setter {
      return current()[1]
    },
    get status() {
      return current()[0].status
    },
    get ready() {
      return current()[0].status !== "loading"
    },
    get project() {
      const store = current()[0]
      const match = Binary.search(globalSync.data.project, store.project, (p) => p.id)
      if (match.found) return globalSync.data.project[match.index]
      return undefined
    },
    session: {
      get: getSession,
      optimistic: {
        add(input: { directory?: string; sessionID: string; message: Message; parts: Part[] }) {
          const _directory = input.directory ?? directory
          const [, setStore] = target(input.directory)
          setOptimistic(_directory, input.sessionID, { message: input.message, parts: input.parts })
          setOptimisticAdd(setStore as (...args: unknown[]) => void, input)
        },
        remove(input: { directory?: string; sessionID: string; messageID: string }) {
          const _directory = input.directory ?? directory
          const [, setStore] = target(input.directory)
          clearOptimistic(_directory, input.sessionID, input.messageID)
          setOptimisticRemove(setStore as (...args: unknown[]) => void, input)
        },
      },
      addOptimisticMessage(input: {
        sessionID: string
        messageID: string
        parts: Part[]
        agent: string
        model: { providerID: string; modelID: string }
        variant?: string
      }) {
        const message: Message = {
          id: input.messageID,
          sessionID: input.sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: input.agent,
          model: { ...input.model, variant: input.variant },
        }
        const [, setStore] = target()
        setOptimistic(directory, input.sessionID, { message, parts: input.parts })
        setOptimisticAdd(setStore as (...args: unknown[]) => void, {
          sessionID: input.sessionID,
          message,
          parts: input.parts,
        })
      },
      async sync(sessionID: string, opts?: { force?: boolean }) {
        const [store, setStore] = globalSync.child(directory)
        const key = keyFor(directory, sessionID)

        touch(directory, setStore, sessionID)

        const seeded = getSessionPrefetch(directory, sessionID)
        // 260829 cc 回填条件从「meta.limit 缺失」放宽成「meta.limit 比 prefetch 记的浅」。
        // meta 是 directory-sync 实例级的，离开 /:dir 会随 DirectoryLayout 一起重建；重建后
        // 首屏装载会先把它写成 initialMessagePageSize(40)，而 prefetch（模块级 Map）记着真实
        // 窗口深度。只认「缺失」就轮不到回填，40 盖住 1435，接着下面的 stale 强制刷新拿这个
        // 40 去 replace 掉内存里整段历史 —— 时间线从 1671 行塌成 12 行，就是「切回会话掉在
        // 历史中间、要手动滚到底」的来源。
        if (seeded && store.message[sessionID] !== undefined && (meta.limit[key] ?? 0) < seeded.limit) {
          batch(() => {
            setMeta("limit", key, seeded.limit)
            setMeta("cursor", key, seeded.cursor)
            setMeta("complete", key, seeded.complete)
            setMeta("loading", key, false)
          })
        }

        return runInflight(inflight, key, async () => {
          const pending = getSessionPrefetchPromise(directory, sessionID)
          if (pending) {
            await pending
            const seeded = getSessionPrefetch(directory, sessionID)
            if (seeded && store.message[sessionID] !== undefined && meta.limit[key] === undefined) {
              batch(() => {
                setMeta("limit", key, seeded.limit)
                setMeta("cursor", key, seeded.cursor)
                setMeta("complete", key, seeded.complete)
                setMeta("loading", key, false)
              })
            }
          }

          const hasSession = Binary.search(store.session, sessionID, (s) => s.id).found
          const cached = store.message[sessionID] !== undefined && meta.limit[key] !== undefined
          if (cached && hasSession && !opts?.force) return

          // 260830 Red 首次加载直接拉 200 条（对齐 layout/prefetch.ts 的 prefetchChunk）：
          // 原首屏只拉 40 条，随后 prefetch 异步合并全量会让行数 40→148 跳变，
          // 虚拟列表重锚失败时视口被甩进旧历史（点进老会话先见新消息几秒后跳旧）。
          const limit = meta.limit[key] ?? 200
          const sessionReq =
            hasSession && !opts?.force
              ? Promise.resolve()
              : retry(() => client.session.get({ sessionID })).then((session) => {
                  if (!tracked(directory, sessionID)) return
                  const data = session.data
                  if (!data) return
                  setStore(
                    "session",
                    produce((draft) => {
                      const match = Binary.search(draft, sessionID, (s) => s.id)
                      if (match.found) {
                        draft[match.index] = data
                        return
                      }
                      draft.splice(match.index, 0, data)
                    }),
                  )
                })

          // 260829 cc 手上已经有消息时的刷新一律走 refresh：只拉最新一页并并集合并，
          // 绝不 replace。此前是 replace，一次刷新就把已加载的历史窗口砍回首屏那一页。
          const refreshing = (store.message[sessionID]?.length ?? 0) > 0
          const messagesReq =
            cached && !opts?.force
              ? Promise.resolve()
              : loadMessages({
                  directory,
                  client,
                  setStore,
                  sessionID,
                  limit: refreshing ? initialMessagePageSize : limit,
                  ...(refreshing ? { mode: "refresh" as const } : {}),
                })

          await Promise.all([sessionReq, messagesReq])
        })
      },
      async diff(sessionID: string, opts?: { force?: boolean }) {
        const [store, setStore] = globalSync.child(directory)
        touch(directory, setStore, sessionID)
        if (store.session_diff[sessionID] !== undefined && !opts?.force) return

        const key = keyFor(directory, sessionID)
        return runInflight(inflightDiff, key, () =>
          retry(() => client.session.diff({ sessionID })).then((diff) => {
            if (!tracked(directory, sessionID)) return
            setStore("session_diff", sessionID, reconcile(list(diff.data), { key: "file" }))
          }),
        )
      },
      async todo(sessionID: string, opts?: { force?: boolean }) {
        const [store, setStore] = globalSync.child(directory)
        touch(directory, setStore, sessionID)
        const existing = store.todo[sessionID]
        const cached = globalSync.data.session_todo[sessionID]
        if (existing !== undefined) {
          if (cached === undefined) {
            globalSync.todo.set(sessionID, existing)
          }
          if (!opts?.force) return
        }

        if (cached !== undefined) {
          setStore("todo", sessionID, reconcile(cached, { key: "id" }))
        }

        const key = keyFor(directory, sessionID)
        return runInflight(inflightTodo, key, () =>
          retry(() => client.session.todo({ sessionID })).then((todo) => {
            if (!tracked(directory, sessionID)) return
            const list = todo.data ?? []
            setStore("todo", sessionID, reconcile(list, { key: "id" }))
            globalSync.todo.set(sessionID, list)
          }),
        )
      },
      // 260820 cc 钉住的目标。跟 todo 同一个触发点（会话切换），但不进 globalSync 的
      // 跨目录缓存——它是单个小对象，缓存省不下什么，而缓存层每多一个键就多一处要
      // 跟着 evict/trim 走的东西。没钉目标时服务端 404，按「没有」写回，不是错误。
      async goal(sessionID: string) {
        const [, setStore] = globalSync.child(directory)
        touch(directory, setStore, sessionID)
        const key = keyFor(directory, sessionID)
        return runInflight(inflightGoal, key, () =>
          client.session
            .goal({ sessionID })
            .then((goal) => {
              if (!tracked(directory, sessionID)) return
              setStore("goal", sessionID, goal.data ?? undefined)
            })
            .catch(() => {
              if (!tracked(directory, sessionID)) return
              setStore("goal", sessionID, undefined)
            }),
        )
      },
      history: {
        more(sessionID: string) {
          const store = current()[0]
          const key = keyFor(directory, sessionID)
          if (store.message[sessionID] === undefined) return false
          if (meta.limit[key] === undefined) return false
          if (meta.complete[key]) return false
          return !!meta.cursor[key]
        },
        loading(sessionID: string) {
          const key = keyFor(directory, sessionID)
          return meta.loading[key] ?? false
        },
        async loadMore(sessionID: string, count?: number) {
          const [, setStore] = globalSync.child(directory)
          touch(directory, setStore, sessionID)
          const key = keyFor(directory, sessionID)
          const step = count ?? historyMessagePageSize
          if (meta.loading[key]) return
          if (meta.complete[key]) return
          const before = meta.cursor[key]
          if (!before) return

          await loadMessages({
            directory,
            client,
            setStore,
            sessionID,
            limit: step,
            before,
            mode: "prepend",
          })
        },
      },
      evict(sessionID: string, _directory = directory) {
        const [, setStore] = globalSync.child(_directory)
        seenFor(_directory).delete(sessionID)
        evict(_directory, setStore, [sessionID])
      },
      fetch: async (count = 10) => {
        const [store, setStore] = globalSync.child(directory)
        setStore("limit", (x) => x + count)
        await client.session.list().then((x) => {
          const sessions = (x.data ?? [])
            .filter((s) => !!s?.id)
            .sort((a, b) => cmp(a.id, b.id))
            .slice(0, store.limit)
          setStore("session", reconcile(sessions, { key: "id" }))
        })
      },
      more: createMemo(() => current()[0].session.length >= current()[0].limit),
      archive: async (sessionID: string) => {
        const [, setStore] = globalSync.child(directory)
        await client.session.update({ sessionID, time: { archived: Date.now() } })
        setStore(
          produce((draft) => {
            const match = Binary.search(draft.session, sessionID, (s) => s.id)
            if (match.found) draft.session.splice(match.index, 1)
          }),
        )
      },
    },
    absolute,
    get directory() {
      return current()[0].path.directory
    },
  }
}
