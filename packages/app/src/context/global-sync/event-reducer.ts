import { Binary } from "@redcode-ai/core/util/binary"
import { batch } from "solid-js"
import { produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type {
  Message,
  Part,
  PermissionRequest,
  Project,
  QuestionRequest,
  Session,
  SessionStatus,
  SnapshotFileDiff,
  Todo,
  Goal,
  ProviderQuota,
} from "@redcode-ai/sdk/v2/client"
import type { State, VcsCache } from "./types"
import { trimSessions } from "./session-trim"
import { dropSessionCaches } from "./session-cache"
import { diffs as list, message as clean } from "@/utils/diffs"
import { compareTime } from "@/utils/id"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])

// 260801 Red GUI 每会话消息上限（仿 TUI sync.tsx:272-280 的 100 条 shift）：
//   GUI store 无界增长，三千万 token 级长会话把全部消息+parts 常驻内存，
//   且 messageAgentColor/cleanupDroppedSessionCaches 每次事件全量扫描。
//   历史消息可经 directory-sync 的 cursor 分页（loadMore）随时回拉，截断只影响内存缓存。
const MAX_MESSAGES_PER_SESSION = 100

// 260706 Red server.instance.disposed 之前无冷却地直接 push(directory) 重新 bootstrap——
//   如果服务端因为某种原因反复 dispose 同一个目录的 instance（比如后台 npm 安装超时触发的
//   reload），这里会跟着无限重连，每次都把该目录整套 MCP server 重新拉起一遍，实测抓到
//   进程树每 1-5 秒完整重生一次。加冷却，同一目录短时间内只允许重新 bootstrap 一次。
const DISPOSED_REFRESH_COOLDOWN_MS = 15_000
const lastDisposedRefresh = new Map<string, number>()

// 260801 Red 0.7.12 懒化：记录自上次清理以来插入的孤儿缓存 session——
//   被 trim 出 session 列表的会话，服务端仍会推它的 message 事件（message.updated 不看
//   session 是否在列表直接插入 store），这些孤儿只能靠全扫缓存 key 兜底清理。
//   打点后 session.created/updated 时若无裁剪也无孤儿，可 O(1) 跳过全扫。
const pendingOrphanSessions = new Set<string>()

export function applyGlobalEvent(input: {
  event: { type: string; properties?: unknown }
  project: Project[]
  setGlobalProject: (next: Project[] | ((draft: Project[]) => Project[])) => void
  setProviderQuota?: (next: ProviderQuota[] | ((draft: ProviderQuota[]) => ProviderQuota[])) => void
  refresh: () => void
}) {
  if (input.event.type === "global.disposed" || input.event.type === "server.connected") {
    input.refresh()
    return
  }

  if (input.event.type === "provider.quota.updated") {
    // 260831 Red 额度是账号级事实（走 GlobalBus 广播），同一 providerID+accountID 就地替换否则追加
    const quota = input.event.properties as ProviderQuota
    if (!quota?.providerID) return
    input.setProviderQuota?.(
      produce((draft) => {
        const idx = draft.findIndex(
          (q) => q.providerID === quota.providerID && (q.accountID ?? "") === (quota.accountID ?? ""),
        )
        if (idx === -1) draft.push(quota)
        else draft[idx] = quota
      }),
    )
    return
  }

  if (input.event.type === "project.removed") {
    const id = input.event.properties as string
    const result = Binary.search(input.project, id, (s) => s.id)
    if (result.found) {
      input.setGlobalProject(
        produce((draft) => {
          draft.splice(result.index, 1)
        }),
      )
    }
    return
  }

  if (input.event.type !== "project.updated") return
  const properties = input.event.properties as Project
  const result = Binary.search(input.project, properties.id, (s) => s.id)
  if (result.found) {
    input.setGlobalProject(
      produce((draft) => {
        draft[result.index] = { ...draft[result.index], ...properties }
      }),
    )
    return
  }
  input.setGlobalProject(
    produce((draft) => {
      draft.splice(result.index, 0, properties)
    }),
  )
}

function cleanupSessionCaches(
  setStore: SetStoreFunction<State>,
  sessionID: string,
  setSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void,
) {
  if (!sessionID) return
  setSessionTodo?.(sessionID, undefined)
  setStore(
    produce((draft) => {
      dropSessionCaches(draft, [sessionID])
    }),
  )
}

export function cleanupDroppedSessionCaches(
  store: Store<State>,
  setStore: SetStoreFunction<State>,
  next: Session[],
  setSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void,
) {
  const keep = new Set(next.map((item) => item.id))
  const stale = [
    ...Object.keys(store.message),
    ...Object.keys(store.session_diff),
    ...Object.keys(store.todo),
    ...Object.keys(store.permission),
    ...Object.keys(store.question),
    ...Object.keys(store.session_status),
    ...Object.values(store.part)
      .map((parts) => parts?.find((part) => !!part?.sessionID)?.sessionID)
      .filter((sessionID): sessionID is string => !!sessionID),
  ].filter((sessionID, index, list) => !keep.has(sessionID) && list.indexOf(sessionID) === index)
  if (stale.length === 0) return
  for (const sessionID of stale) {
    setSessionTodo?.(sessionID, undefined)
  }
  setStore(
    produce((draft) => {
      dropSessionCaches(draft, stale)
    }),
  )
}

export function applyDirectoryEvent(input: {
  event: { type: string; properties?: unknown }
  store: Store<State>
  setStore: SetStoreFunction<State>
  push: (directory: string) => void
  directory: string
  loadLsp: () => void
  vcsCache?: VcsCache
  setSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void
  isPinned?: boolean
}) {
  const event = input.event
  switch (event.type) {
    case "server.instance.disposed": {
      // 260706 Red 只对当前打开（pinned）的目录重新 bootstrap——
      //   之前不管目录是否 pinned 都 push，只要 children.children 里还有记录（历史碰过的
      //   目录都在），服务端一波 disposed 事件打过来，每个历史目录各自过一次冷却检查
      //   （首次调用 last=0 必过）就各自拉起一整套 MCP server，实测就是内存分批跳涨
      //   （600MB→2G→4G→6G，一个历史目录一跳）的真正原因。
      if (!input.isPinned) return
      const now = Date.now()
      const last = lastDisposedRefresh.get(input.directory) ?? 0
      if (now - last < DISPOSED_REFRESH_COOLDOWN_MS) return
      lastDisposedRefresh.set(input.directory, now)
      input.push(input.directory)
      return
    }
    case "session.created": {
      const info = (event.properties as { info: Session }).info
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (result.found) {
        input.setStore("session", result.index, reconcile(info))
        break
      }
      const next = input.store.session.slice()
      next.splice(result.index, 0, info)
      const trimmed = trimSessions(next, { limit: input.store.limit, permission: input.store.permission })
      input.setStore("session", reconcile(trimmed, { key: "id" }))
      // 260801 Red 0.7.12 懒化：trim 未删 session（next.length === trimmed.length）且无孤儿消息打点时，
      //   cleanupDroppedSessionCaches 必然无事可做，跳过其全 parts 扫描（40-session × 千条消息 = 数万条目/事件）
      if (next.length !== trimmed.length || pendingOrphanSessions.size > 0) {
        cleanupDroppedSessionCaches(input.store, input.setStore, trimmed, input.setSessionTodo)
        pendingOrphanSessions.clear()
      }
      if (!info.parentID) input.setStore("sessionTotal", (value) => value + 1)
      break
    }
    case "session.updated": {
      const info = (event.properties as { info: Session }).info
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (info.time.archived) {
        // Binary.search 未命中时 index 是插入位（可能越界），必须先判 found 再解引用
        if (!result.found) break
        if (input.store.session[result.index]!.time.archived === info.time.archived) break
        input.setStore(
          "session",
          produce((draft) => {
            draft.splice(result.index, 1)
          }),
        )
        cleanupSessionCaches(input.setStore, info.id, input.setSessionTodo)
        if (info.parentID) break
        input.setStore("sessionTotal", (value) => Math.max(0, value - 1))
        break
      }
      if (result.found) {
        input.setStore("session", result.index, reconcile(info))
        break
      }
      const next = input.store.session.slice()
      next.splice(result.index, 0, info)
      const trimmed = trimSessions(next, { limit: input.store.limit, permission: input.store.permission })
      input.setStore("session", reconcile(trimmed, { key: "id" }))
      // 260801 Red 0.7.12 懒化（同 session.created，见上）
      if (next.length !== trimmed.length || pendingOrphanSessions.size > 0) {
        cleanupDroppedSessionCaches(input.store, input.setStore, trimmed, input.setSessionTodo)
        pendingOrphanSessions.clear()
      }
      break
    }
    case "session.deleted": {
      const info = (event.properties as { info: Session }).info
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (result.found) {
        input.setStore(
          "session",
          produce((draft) => {
            draft.splice(result.index, 1)
          }),
        )
      }
      cleanupSessionCaches(input.setStore, info.id, input.setSessionTodo)
      if (info.parentID) break
      input.setStore("sessionTotal", (value) => Math.max(0, value - 1))
      break
    }
    case "session.diff": {
      const props = event.properties as { sessionID: string; diff: SnapshotFileDiff[] }
      input.setStore("session_diff", props.sessionID, reconcile(list(props.diff), { key: "file" }))
      break
    }
    case "todo.updated": {
      const props = event.properties as { sessionID: string; todos: Todo[] }
      input.setStore("todo", props.sessionID, reconcile(props.todos, { key: "id" }))
      input.setSessionTodo?.(props.sessionID, props.todos)
      break
    }
    // 260820 cc goal 被清掉时 properties.goal 是 undefined —— 直接写进去，面板随之收起。
    // 不走 reconcile：整条对象要么在要么不在，没有需要保 key 的列表。
    case "goal.updated": {
      const props = event.properties as { sessionID: string; goal?: Goal }
      input.setStore("goal", props.sessionID, props.goal)
      break
    }
    case "session.status": {
      const props = event.properties as { sessionID: string; status: SessionStatus }
      input.setStore("session_status", props.sessionID, reconcile(props.status))
      break
    }
    case "message.updated": {
      const info = clean((event.properties as { info: Message }).info)
      const messages = input.store.message[info.sessionID]
      if (!messages) {
        input.setStore("message", info.sessionID, [info])
        break
      }
      // 260831 cc 消息数组已改为时间序（见 directory-sync 的 byTime 注释），不能再二分：
      //   Binary.search 假设字典序，而 ID 是时间编码且会回绕。定位用线性 find，插入位按
      //   compareTime 取「第一个比它晚的位置」。
      const at = messages.findIndex((m) => m.id === info.id)
      if (at !== -1) {
        input.setStore("message", info.sessionID, at, reconcile(info))
        break
      }
      const insertAt = (() => {
        const i = messages.findIndex((m) => compareTime(m, info) > 0)
        return i === -1 ? messages.length : i
      })()
      input.setStore(
        "message",
        info.sessionID,
        produce((draft) => {
          draft.splice(insertAt, 0, info)
        }),
      )
      // 260801 Red 0.7.12 懒化打点：session 已不在列表时插入消息 = 孤儿缓存产生，
      //   标记后下次 session.created/updated 全扫清理（否则依赖无界增长的孤儿兜底）
      if (!Binary.search(input.store.session, info.sessionID, (s) => s.id).found) {
        pendingOrphanSessions.add(info.sessionID)
      }
      // 260801 Red 每会话消息上限：插入后超出即丢最旧消息 + 其 parts（仿 TUI sync.tsx:271-289）
      // 260904 cc 顺带标记 message_trimmed。上面那条注释说「历史可经 loadMore 随时回拉」——
      //   在这一步之前它不成立：分页层的 complete/cursor 记的是服务端给过什么，对内存里
      //   被 shift 掉的这一条一无所知。一个已经拉全的会话（complete=true）流式跑过 100 条后，
      //   history.more() 直接 return false，"加载更多"根本不出现，历史静默消失。
      //   标了这一笔，directory-sync 的 more()/loadMore() 才知道要绕过 complete 再往回拉。
      //   ⚠️ 已知局限：拉回来之后若会话仍在流式推进，下一条 message.updated 会再砍一次。
      //   彻底解法是让上限跟着「用户显式加载过的长度」走，不在本次范围内。
      const updated = input.store.message[info.sessionID]
      if (updated.length > MAX_MESSAGES_PER_SESSION) {
        const oldest = updated[0]
        batch(() => {
          input.setStore(
            "message",
            info.sessionID,
            produce((draft) => {
              draft.shift()
            }),
          )
          input.setStore(
            "part",
            produce((draft) => {
              delete draft[oldest.id]
            }),
          )
          input.setStore("message_trimmed", info.sessionID, true)
        })
      }
      break
    }
    case "message.removed": {
      const props = event.properties as { sessionID: string; messageID: string }
      input.setStore(
        produce((draft) => {
          const messages = draft.message[props.sessionID]
          if (messages) {
            const result = Binary.search(messages, props.messageID, (m) => m.id)
            if (result.found) messages.splice(result.index, 1)
          }
          const parts = draft.part[props.messageID]
          if (parts) {
            for (const part of parts) {
              delete draft.part_text_accum_delta[part.id]
            }
          }
          delete draft.part[props.messageID]
        }),
      )
      break
    }
    case "message.part.updated": {
      const part = (event.properties as { part: Part }).part
      if (SKIP_PARTS.has(part.type)) break
      input.setStore(
        produce((draft) => {
          delete draft.part_text_accum_delta[part.id]
        }),
      )
      const parts = input.store.part[part.messageID]
      if (!parts) {
        input.setStore("part", part.messageID, [part])
        break
      }
      const result = Binary.search(parts, part.id, (p) => p.id)
      if (result.found) {
        input.setStore("part", part.messageID, result.index, reconcile(part))
        break
      }
      input.setStore(
        "part",
        part.messageID,
        produce((draft) => {
          draft.splice(result.index, 0, part)
        }),
      )
      break
    }
    case "message.part.removed": {
      const props = event.properties as { messageID: string; partID: string }
      input.setStore(
        produce((draft) => {
          delete draft.part_text_accum_delta[props.partID]
        }),
      )
      const parts = input.store.part[props.messageID]
      if (!parts) break
      const result = Binary.search(parts, props.partID, (p) => p.id)
      if (result.found) {
        input.setStore(
          produce((draft) => {
            const list = draft.part[props.messageID]
            if (!list) return
            const next = Binary.search(list, props.partID, (p) => p.id)
            if (!next.found) return
            list.splice(next.index, 1)
            if (list.length === 0) delete draft.part[props.messageID]
          }),
        )
      }
      break
    }
    case "message.part.delta": {
      const props = event.properties as { messageID: string; partID: string; field: string; delta: string }
      const parts = input.store.part[props.messageID]
      if (!parts) break
      const result = Binary.search(parts, props.partID, (p) => p.id)
      if (!result.found) break
      // 260801 Red 每 delta 单次写入：TUI 对照（sync.tsx:327-343）只更新 part[field]，
      //   readPartText(accum, part) 在 accum 缺失时 fallback part.text，双写冗余且 O(n²)
      input.setStore(
        "part",
        props.messageID,
        produce((draft) => {
          const part = draft[result.index]
          const field = props.field as keyof typeof part
          const existing = part[field] as string | undefined
          ;(part[field] as string) = (existing ?? "") + props.delta
        }),
      )
      break
    }
    case "vcs.branch.updated": {
      const props = event.properties as { branch?: string }
      if (input.store.vcs?.branch === props.branch) break
      const next = { ...input.store.vcs, branch: props.branch }
      input.setStore("vcs", next)
      if (input.vcsCache) input.vcsCache.setStore("value", next)
      break
    }
    case "permission.asked": {
      const permission = event.properties as PermissionRequest
      const permissions = input.store.permission[permission.sessionID]
      if (!permissions) {
        input.setStore("permission", permission.sessionID, [permission])
        break
      }
      const result = Binary.search(permissions, permission.id, (p) => p.id)
      if (result.found) {
        input.setStore("permission", permission.sessionID, result.index, reconcile(permission))
        break
      }
      input.setStore(
        "permission",
        permission.sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, permission)
        }),
      )
      break
    }
    case "permission.replied": {
      const props = event.properties as { sessionID: string; requestID: string }
      const permissions = input.store.permission[props.sessionID]
      if (!permissions) break
      const result = Binary.search(permissions, props.requestID, (p) => p.id)
      if (!result.found) break
      input.setStore(
        "permission",
        props.sessionID,
        produce((draft) => {
          draft.splice(result.index, 1)
        }),
      )
      break
    }
    case "question.asked": {
      const question = event.properties as QuestionRequest
      const questions = input.store.question[question.sessionID]
      if (!questions) {
        input.setStore("question", question.sessionID, [question])
        break
      }
      const result = Binary.search(questions, question.id, (q) => q.id)
      if (result.found) {
        input.setStore("question", question.sessionID, result.index, reconcile(question))
        break
      }
      input.setStore(
        "question",
        question.sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, question)
        }),
      )
      break
    }
    case "question.replied":
    case "question.rejected": {
      const props = event.properties as { sessionID: string; requestID: string }
      const questions = input.store.question[props.sessionID]
      if (!questions) break
      const result = Binary.search(questions, props.requestID, (q) => q.id)
      if (!result.found) break
      input.setStore(
        "question",
        props.sessionID,
        produce((draft) => {
          draft.splice(result.index, 1)
        }),
      )
      break
    }
    case "lsp.updated": {
      input.loadLsp()
      break
    }
  }
}
