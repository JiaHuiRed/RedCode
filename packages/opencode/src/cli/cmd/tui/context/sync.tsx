import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Goal,
  Command,
  PermissionRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  ProviderQuota,
  VcsInfo,
} from "@redcode-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { useProject } from "@tui/context/project"
import { useEvent } from "@tui/context/event"
import { useSDK } from "@tui/context/sdk"
import { Binary } from "@redcode-ai/core/util/binary"
import { createSimpleContext } from "./helper"

// 260814 Red 消息数组按 (time.created, id) 升序维护。MessageID 48 位编码 795 天回绕
// （2026-08-14 19:19:55.136 已第 26 次发生），回绕后 ID 字典序不再单调，
// 二分定位必须走 comparator（Binary.searchBy）。created 缺失时退化为 ID 字典序。
export function cmpTime(
  a: { id: string; time?: { created?: number } },
  b: { id: string; time?: { created?: number } },
) {
  const ac = a.time?.created
  const bc = b.time?.created
  if (ac !== undefined && bc !== undefined && ac !== bc) return ac - bc
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
const MAX_SESSION_DIFF_FILES = 100

function sidebarDiff(input: Snapshot.FileDiff[]) {
  return input
    .slice(0, MAX_SESSION_DIFF_FILES)
    .map((item) => ({ file: item.file, additions: item.additions, deletions: item.deletions, status: item.status }))
}
// 261113 Red bootstrap 后台请求的显式等待阈值（ms）。SDK 传输层对每个请求已有 60s
// deadline（packages/sdk/js/src/v2/client.ts），但那是全局兜底、超时前只表现为「一直
// pending」；可选状态请求在这里各自给一条可观测的等待上限（只记日志，不 abort）。
const OPTIONAL_REQUEST_TIMEOUT_MS = 10_000

import type { Snapshot } from "@/snapshot"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, onCleanup, onMount } from "solid-js"
import * as Log from "@redcode-ai/core/util/log"
import { emptyConsoleState, type ConsoleState } from "@/config/console-state"
import path from "path"
import { useKV } from "./kv"
import { aggregateFailures } from "./aggregate-failures"
import { createQuestionRecovery } from "./question-recovery"
import { useProjectNavigation } from "./project-navigation"

export const {
  use: useSync,
  provider: SyncProvider,
  // 260828 cc 原始 context 供快照测试直接喂假值，见 test/cli/tui/lib/transcript.tsx
  context,
} = createSimpleContext({
  name: "Sync",
  init: (props: { disabled?: boolean }) => {
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      // 261022 Red 目录是懒加载的：idle 未请求 / loading / ready / error 可重试。
      provider_next_status: "idle" | "loading" | "ready" | "error"
      console_state: ConsoleState
      provider_auth: Record<string, ProviderAuthMethod[]>
      provider_quota: ProviderQuota[]
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      question: {
        [sessionID: string]: QuestionRequest[]
      }
      // 260903 cc 权限/提问事件按 project 过滤、不按 workspace，所以别的 workspace
      // （worktree 隔离的子代理就是一个）问出来的弹窗照样会显示在这里；而回复走的是
      // WorkspaceRoutingMiddleware，发去当前 workspace 就在错误的实例里查 requestID，
      // 一律 PermissionNotFoundError —— 表现是弹窗点了、按了都没反应。按 requestID
      // 记下当初 ask 的 workspace，回复时原路发回去。
      request_workspace: {
        [requestID: string]: string | undefined
      }
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      session_diff: {
        [sessionID: string]: Snapshot.FileDiff[]
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      // 260820 cc 钉住的目标。一个会话至多一个，没钉时整条不存在（服务端 404）
      goal: {
        [sessionID: string]: Goal | undefined
      }
      message: {
        [sessionID: string]: Message[]
      }
      part: {
        [messageID: string]: Part[]
      }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      mcp_resource: {
        [key: string]: McpResource
      }
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      provider_next_status: "idle",
      console_state: emptyConsoleState,
      provider_auth: {},
      provider_quota: [],
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      question: {},
      request_workspace: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      session_diff: {},
      todo: {},
      goal: {},
      message: {},
      part: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
    })

    const event = useEvent()
    const project = useProject()
    const sdk = useSDK()
    const kv = useKV()
    // 261114 Red bootstrap 完成时把恢复合并后的活动状态播种给 Navigation；测试夹具
    // 不挂 NavigationProvider，这里允许 undefined。
    const navigation = useProjectNavigation()
    // 261110 Red 项目切换会卸载旧 SyncProvider，但已发出的请求不会被取消；
    // 迟到的失败不能再触发应用退出（exit 会销毁整个 TUI）。
    let live = true
    onCleanup(() => {
      live = false
    })

    const fullSyncedSessions = new Set<string>()
    // 260923 Red 当前会话 = 最后一次 sync/reconcile 的目标（进会话与子会话导航都走
    // sync）；server.connected 计数用于区分首连（bootstrap 已全量加载）与重连补拉。
    let currentSessionID: string | undefined
    let serverConnections = 0

    function sessionListQuery(): { scope?: "project" | "global"; path?: string } {
      if (!kv.get("session_directory_filter_enabled", true)) return { scope: "global" }
      if (!project.data.instance.path.worktree || !project.data.instance.path.directory) return { scope: "project" }
      return {
        path: path
          .relative(path.resolve(project.data.instance.path.worktree), project.data.instance.path.directory)
          .replaceAll("\\", "/"),
      }
    }

    function sessionListParams() {
      return { start: Date.now() - 30 * 24 * 60 * 60 * 1000, ...sessionListQuery() }
    }

    function sortedSessions(sessions: Session[]) {
      return sessions.toSorted((a, b) => a.id.localeCompare(b.id))
    }

    function listSessions() {
      return sdk.client.session.list(sessionListParams()).then((x) => sortedSessions(x.data ?? []))
    }

    // 261113 Red bootstrap 的 session 列表是 complete 的判据：未设 throwOnError 时 HTTP 500
    // 会返回 { error }，被 `?? []` 当成空列表写进 store（把已有会话抹掉、还把失败伪装成成功）。
    // 这里改成会 reject 的版本，由 current 按 endpoint 记失败并保留既有数据。
    function fetchSessions() {
      return sdk.client.session
        .list(sessionListParams(), { throwOnError: true })
        .then((x) => sortedSessions(x.data ?? []))
    }

    const forgetRequestWorkspace = (requestID: string) =>
      setStore(
        "request_workspace",
        produce((draft) => {
          delete draft[requestID]
        }),
      )

    // 261009 Red question.asked 事件与 bootstrap 恢复拉取共用一份插入形状，别抄两份。
    const upsertQuestion = (request: QuestionRequest, workspace: string | undefined) => {
      setStore("request_workspace", request.id, workspace)
      const requests = store.question[request.sessionID]
      if (!requests) {
        setStore("question", request.sessionID, [request])
        return
      }
      const match = Binary.search(requests, request.id, (r) => r.id)
      if (match.found) {
        setStore("question", request.sessionID, match.index, reconcile(request))
        return
      }
      setStore(
        "question",
        request.sessionID,
        produce((draft) => {
          draft.splice(match.index, 0, request)
        }),
      )
    }

    const questionRecovery = createQuestionRecovery<QuestionRequest>({
      workspace: () => project.workspace.current(),
      fetch: (workspace) => sdk.client.question.list({ workspace }, { throwOnError: true }).then((x) => x.data),
      read: () => Object.values(store.question).flat(),
      apply: (requests, workspace) => {
        const retained = new Set(requests.map((request) => request.id))
        const previous = Object.values(store.question).flat()
        const grouped: Record<string, QuestionRequest[]> = {}
        for (const request of requests) (grouped[request.sessionID] ??= []).push(request)
        for (const items of Object.values(grouped)) items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        batch(() => {
          for (const request of previous) {
            if (!retained.has(request.id)) forgetRequestWorkspace(request.id)
          }
          for (const request of requests) {
            if (!Object.hasOwn(store.request_workspace, request.id)) {
              setStore("request_workspace", request.id, workspace)
            }
          }
          setStore("question", reconcile(grouped))
        })
      },
    })
    onCleanup(() => questionRecovery.dispose())

    // 261110 Red 切回目录时权限也从服务端恢复，复用提问的快照/实时事件合并门禁。
    const permissionRecovery = createQuestionRecovery<PermissionRequest>({
      workspace: () => project.workspace.current(),
      fetch: (workspace) => sdk.client.permission.list({ workspace }, { throwOnError: true }).then((x) => x.data),
      read: () => Object.values(store.permission).flat(),
      apply: (requests, workspace) => {
        const retained = new Set(requests.map((request) => request.id))
        const grouped: Record<string, PermissionRequest[]> = {}
        for (const request of Object.values(store.permission).flat()) {
          if (!retained.has(request.id)) forgetRequestWorkspace(request.id)
        }
        for (const request of requests) {
          ;(grouped[request.sessionID] ??= []).push(request)
          if (!Object.hasOwn(store.request_workspace, request.id)) {
            setStore("request_workspace", request.id, workspace)
          }
        }
        for (const items of Object.values(grouped)) items.sort((a, b) => a.id.localeCompare(b.id))
        setStore("permission", reconcile(grouped))
      },
    })
    onCleanup(() => permissionRecovery.dispose())

    // 261114 Red session.status 快照同样走恢复合并：服务端 idle 会从状态表删除（快照
    // 只含非 idle），store 里的 idle 条目是事件写的，裸 reconcile 会把拉取期间已变
    // idle 的会话按旧快照复活成 busy——这份 store 是启动快照喂 Navigation 活动摘要
    // 的数据源，不能带病播种。
    const sessionStatusRecovery = createQuestionRecovery<{ id: string; status: SessionStatus }>({
      workspace: () => project.workspace.current(),
      fetch: (workspace) =>
        sdk.client.session
          .status({ workspace }, { throwOnError: true })
          .then((x) => Object.entries(x.data ?? {}).map(([sessionID, status]) => ({ id: sessionID, status }))),
      read: () => Object.entries(store.session_status).map(([sessionID, status]) => ({ id: sessionID, status })),
      apply: (items) => {
        setStore(
          "session_status",
          reconcile(Object.fromEntries(items.map((item) => [item.id, item.status]))),
        )
      },
    })
    onCleanup(() => sessionStatusRecovery.dispose())

    event.subscribe((event, { workspace }) => {
      switch (event.type) {
        case "server.instance.disposed":
          void bootstrap()
          break

        case "server.connected": {
          // 260923 Red 服务端 SSE id: undefined，没有 Last-Event-ID replay，断线期间的
          // 事件不会补发；fullSyncedSessions 又会让 sync() 直接 return——恢复后当前
          // session 会永久缺一截。首连数据由 bootstrap 全量加载；第二次起每次重连只对
          // 当前 session 做窄范围补拉，不做整个项目的全量 bootstrap。
          serverConnections += 1
          if (serverConnections > 1) {
            reconcileCurrentSession()
            void questionRecovery.recover().catch((error) => {
              Log.Default.warn("tui question recovery failed", {
                error: error instanceof Error ? error.message : String(error),
              })
            })
          }
          break
        }
        case "permission.replied": {
          permissionRecovery.changed(event.properties.requestID)
          forgetRequestWorkspace(event.properties.requestID)
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "permission.asked": {
          const request = event.properties
          permissionRecovery.changed(request.id)
          setStore("request_workspace", request.id, workspace)
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("permission", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "permission",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "question.replied":
        case "question.rejected": {
          questionRecovery.changed(event.properties.requestID)
          forgetRequestWorkspace(event.properties.requestID)
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "question.asked": {
          questionRecovery.changed(event.properties.id)
          upsertQuestion(event.properties, workspace)
          break
        }

        case "todo.updated":
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        // 260820 cc goal 被清掉时 properties.goal 是 undefined —— 直接写进去即可，
        // 侧边栏的 Show 会随之收起。
        case "goal.updated":
          setStore("goal", event.properties.sessionID, event.properties.goal)
          break

        case "session.diff":
          setStore("session_diff", event.properties.sessionID, sidebarDiff(event.properties.diff))
          break

        case "session.deleted": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "session.updated": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.status": {
          sessionStatusRecovery.changed(event.properties.sessionID)
          setStore("session_status", event.properties.sessionID, event.properties.status)
          break
        }

        // 260831 Red 额度是账号级事实，走 GlobalBus 全局事件（同 GUI 合并策略：
        // 同 providerID+accountID 替换，否则追加）
        case "provider.quota.updated": {
          const quota = event.properties
          setStore(
            "provider_quota",
            produce((draft) => {
              const idx = draft.findIndex(
                (q) => q.providerID === quota.providerID && (q.accountID ?? "") === (quota.accountID ?? ""),
              )
              if (idx === -1) draft.push(quota)
              else draft[idx] = quota
            }),
          )
          break
        }

        case "message.updated": {
          const messages = store.message[event.properties.info.sessionID]
          if (!messages) {
            setStore("message", event.properties.info.sessionID, [event.properties.info])
            break
          }
          const result = Binary.searchBy(messages, event.properties.info, cmpTime)
          if (result.found) {
            setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "message",
            event.properties.info.sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          const updated = store.message[event.properties.info.sessionID]
          if (updated.length > 100) {
            const oldest = updated[0]
            batch(() => {
              setStore(
                "message",
                event.properties.info.sessionID,
                produce((draft) => {
                  draft.shift()
                }),
              )
              setStore(
                "part",
                produce((draft) => {
                  delete draft[oldest.id]
                }),
              )
            })
          }
          break
        }
        case "message.removed": {
          const messages = store.message[event.properties.sessionID]
          // 261108 Red 审计 RC-P2-02：其他客户端同步过来的删除可能命中未加载会话，
          // store 里没有这个 key 时直接 findIndex 会 TypeError。没有缓存就是已经没了，
          // 幂等跳过；不要顺手建空数组，那会把「未加载」伪装成「空会话」。
          if (!messages) break
          // 260814 Red 线性定位（数组 ≤100）：二分只对排序键成立，而数组按 created 排
          const index = messages.findIndex((m) => m.id === event.properties.messageID)
          if (index >= 0) {
            setStore(
              "message",
              event.properties.sessionID,
              produce((draft) => {
                draft.splice(index, 1)
              }),
            )
          }
          break
        }
        case "message.part.updated": {
          const parts = store.part[event.properties.part.messageID]
          if (!parts) {
            setStore("part", event.properties.part.messageID, [event.properties.part])
            break
          }
          const result = Binary.search(parts, event.properties.part.id, (p) => p.id)
          if (result.found) {
            setStore("part", event.properties.part.messageID, result.index, reconcile(event.properties.part))
            break
          }
          setStore(
            "part",
            event.properties.part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.part)
            }),
          )
          break
        }

        case "message.part.delta": {
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (!result.found) break
          // 261101 Red tool part 的 raw 流式增量（写长文档渐进预览）要路由进 state.raw——
          // raw 挂在 state 上，走下面的顶层字段追只会造出无主属性
          if (event.properties.field === "raw") {
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                const part = draft[result.index]
                if (part.type !== "tool" || part.state.status !== "pending") return
                part.state.raw += event.properties.delta
              }),
            )
            break
          }
          setStore(
            "part",
            event.properties.messageID,
            produce((draft) => {
              const part = draft[result.index]
              const field = event.properties.field as keyof typeof part
              const existing = part[field] as string | undefined
              ;(part[field] as string) = (existing ?? "") + event.properties.delta
            }),
          )
          break
        }

        case "message.part.removed": {
          const parts = store.part[event.properties.messageID]
          // 261108 Red 审计 RC-P2-02：同 message.removed，未缓存消息的 part 删除同样要幂等跳过。
          if (!parts) break
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (result.found) {
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }

        case "lsp.updated": {
          const workspace = project.workspace.current()
          void sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", x.data ?? []))
          break
        }

        case "mcp.tools.changed": {
          // 261101 Red 后台连接完成/重连后刷新 MCP 状态：启动宽限外的慢启动 server
          // 连上时界面自动翻成 connected，不再停在场「connecting」等用户手动重试
          const workspace = project.workspace.current()
          void sdk.client.mcp.status({ workspace }).then((x) => setStore("mcp", reconcile(x.data ?? {})))
          break
        }

        case "vcs.branch.updated": {
          if (workspace === project.workspace.current()) {
            setStore("vcs", { branch: event.properties.branch })
          }
          break
        }
      }
    })

    const exit = useExit()
    const args = useArgs()

    // 261022 Red 全量供应商目录（provider.list）只服务「连接 Provider / 选择模型」弹窗，
    //   普通聊天要的已连接模型来自 config.providers。原实现把它放进阻塞组，等于每次启动
    //   都要等整个目录下载完才能进首屏，且它一失败就 throw 掉整条 bootstrap。
    //   改为幂等懒加载：启动后台预取一次，弹窗打开时再兜一次；失败只把目录标成 error，
    //   不影响聊天（弹窗里可重试）。
    let providerListInFlight: Promise<void> | undefined
    function ensureProviderList(force = false) {
      if (force) providerListInFlight = undefined
      if (providerListInFlight) return providerListInFlight
      setStore("provider_next_status", "loading")
      providerListInFlight = sdk.client.provider
        .list({ workspace: project.workspace.current() }, { throwOnError: true })
        .then((x) => {
          batch(() => {
            setStore("provider_next", reconcile(x.data!))
            setStore("provider_next_status", "ready")
          })
        })
        .catch((e) => {
          // 只降级目录类弹窗；清掉 in-flight 让下次打开弹窗能重试。
          providerListInFlight = undefined
          setStore("provider_next_status", "error")
          Log.Default.warn("tui provider.list failed", { error: e instanceof Error ? e.message : String(e) })
        })
      return providerListInFlight
    }

    let bootstrapGeneration = 0

    // 261113 Red 活动摘要播种：恢复快照落地多少就播多少，不等别的可选请求——
    // MCP/lsp 等无关请求悬挂不能拖住 busy/waiting 摘要的恢复。整表覆盖是安全的：
    // store 是同一批事件 + 恢复合并后的权威投影（事件先写 store，恢复 apply 会把
    // 在途事件按 ID 并进快照），播种最多「暂时落后于尚未落地的恢复」，不会丢掉已知的
    // waiting/busy——那份恢复落地后会再播一次。目录已切走时由 seedActivity 自身的
    // 目录门禁作废，旧一轮 bootstrap 由 generation 守卫作废。
    function seedNavigation() {
      if (!live || !navigation || !sdk.directory) return
      const busy = Object.entries(store.session_status)
        .filter(([, status]) => status.type !== "idle")
        .map(([sessionID]) => sessionID)
      const requests = [...Object.values(store.permission).flat(), ...Object.values(store.question).flat()].map(
        (request) => ({
          id: request.id,
          sessionID: request.sessionID,
          workspace: store.request_workspace[request.id],
        }),
      )
      navigation.seedActivity(sdk.directory, { busy, requests })
    }

    // 261113 Red 请求创建时就绑定失败处理：即使 phase1 悬挂/失败、startBackground 没
    // 跑到，也不能留下未处理的 rejection（Bun 会当进程级错误）；失败立刻带端点落日志，
    // 同时把成败作为结果保留给调用方——complete / fork 语义必须能分辨失败，不能当成功。
    type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }

    // 261113 Red 超时只做「可观测标识」：到点记一条带端点的 timed out 日志，不 abort、
    // 不改写数据路径——迟到结果照旧由 current/seedAfter 的 generation 守卫落盘。
    // 超时不替代状态合并与生命周期守卫。
    function watchTimeout(name: string, promise: Promise<unknown>, ms = OPTIONAL_REQUEST_TIMEOUT_MS) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), ms)
        timer.unref()
      })
      const settled = promise.then(
        () => "settled" as const,
        // 失败由 observe 记录；这里只负责结束计时，别制造第二个未处理拒绝。
        () => "settled" as const,
      )
      void Promise.race([settled, deadline]).then((outcome) => {
        if (timer !== undefined) clearTimeout(timer)
        if (outcome === "timeout") Log.Default.warn("tui bootstrap request timed out", { endpoint: name, timeoutMs: ms })
      })
    }

    function observe<T>(name: string, promise: Promise<T>): Promise<Outcome<T>> {
      watchTimeout(name, promise)
      return promise.then(
        (value) => ({ ok: true as const, value }),
        (error) => {
          Log.Default.warn("tui bootstrap request failed", {
            endpoint: name,
            error: error instanceof Error ? error.message : String(error),
          })
          return { ok: false as const, error }
        },
      )
    }

    // 261113 Red 迟到的后台结果只在仍属当前一轮 bootstrap 时落盘：新一轮已开始或
    // provider 已卸载时旧结果直接丢弃，不能盖掉新结果。失败已由 observe 记录。
    function current<T>(attempt: number, name: string, promise: Promise<T>, apply: (value: T) => void) {
      return observe(name, promise).then((outcome) => {
        if (!live || attempt !== bootstrapGeneration || !outcome.ok) return
        apply(outcome.value)
      })
    }

    // 261113 Red 未设 throwOnError 的请求在 HTTP 500 时不 reject，而是返回 { error }：
    // 不能当成功回填空值（重启/重连后会把 store 里已有的数据抹掉），也不能静默。失败按
    // endpoint 记一条日志并保留既有数据；data 缺失同样按失败处理（200 空体不当空结果）。
    function settle<R extends { data?: unknown; error?: unknown }>(
      attempt: number,
      name: string,
      run: () => Promise<R>,
      apply: (value: NonNullable<R["data"]>) => void,
    ) {
      return observe(name, run()).then((outcome) => {
        if (!live || attempt !== bootstrapGeneration || !outcome.ok) return
        const response = outcome.value
        const data = response.data
        if (response.error !== undefined || data === undefined) {
          Log.Default.warn("tui bootstrap request failed", {
            endpoint: name,
            error: response.error === undefined ? "empty response" : response.error,
          })
          return
        }
        apply(data as NonNullable<R["data"]>)
      })
    }

    // 261113 Red 恢复快照落地就播种活动摘要，不等别的可选请求；旧一轮的迟到结果
    // 由 generation 守卫丢弃，不播种。
    function seedAfter(name: string, attempt: number, promise: Promise<unknown>) {
      return observe(name, promise).then((outcome) => {
        if (outcome.ok && live && attempt === bootstrapGeneration) seedNavigation()
      })
    }

    async function bootstrap(input: { fatal?: boolean } = {}) {
      if (props.disabled) {
        setStore("status", "complete")
        return
      }
      const fatal = input.fatal ?? true
      // 261113 Red 每一轮 bootstrap 一个编号：instance.disposed 触发重启时，旧一轮的
      // 阻塞结果、后台写入与活动播种都必须作废（见 current 与 seedNavigation 调用点）。
      const attempt = ++bootstrapGeneration
      // 261113 Red 恢复类请求在本轮第一个 await 之前就发起：recover() 会同步把旧一轮的
      // pending 顶掉（内部按 request 身份门禁），旧快照因此不会在本轮 phase1 的 await
      // 窗口里写进 store——不是缩小窗口，是取消这段窗口。
      void seedAfter("session.status", attempt, sessionStatusRecovery.recover())
      void seedAfter("question.list", attempt, questionRecovery.recover())
      void seedAfter("permission.list", attempt, permissionRecovery.recover())
      const workspace = project.workspace.current()
      const projectPromise = project.sync()
      const rawSessionList = projectPromise.then(() => fetchSessions())
      // 261113 Red 创建即观察：blocking 悬挂/失败时 startBackground 可能永不执行，
      // 裸 promise 的 rejection 会变成进程级未处理错误；失败必须立刻按 endpoint 落日志。
      // --continue 的阻塞组仍用 rawSessionList，列表失败在那里照旧是 fatal。
      const sessionListPromise = observe("session.list", rawSessionList)

      // blocking - include session.list when continuing a session
      const providersPromise = sdk.client.config.providers({ workspace }, { throwOnError: true })
      // 261022 Red 全量目录退出阻塞组（见 ensureProviderList）：后台预取，不 await。
      void ensureProviderList(true)
      // 261113 Red console.state 只服务「Provider 弹窗」的 console 托管标记，不参与首屏：
      // 留在阻塞组里，一次悬挂就把整个第一/第二阶段拦在 loading/partial。改为落地即写
      // （见 startBackground）；失败不写 store（保留既有值），由 current 按 endpoint 记录。
      const consoleStatePromise = observe(
        "console.state",
        sdk.client.experimental.console.get({ workspace }, { throwOnError: true }).then((x) => x.data),
      )
      const agentsPromise = sdk.client.app.agents({ workspace }, { throwOnError: true })
      const configPromise = sdk.client.config.get({ workspace }, { throwOnError: true })
      const blockingRequests: { name: string; promise: Promise<unknown> }[] = [
        { name: "config.providers", promise: providersPromise },
        { name: "app.agents", promise: agentsPromise },
        { name: "config.get", promise: configPromise },
        { name: "project.sync", promise: projectPromise },
        ...(args.continue ? [{ name: "session.list", promise: rawSessionList }] : []),
      ]

      await Promise.allSettled(blockingRequests.map((r) => r.promise))
        .then((settled) => {
          // Surface every failed endpoint in one labeled message instead of
          // letting the first rejection drown its siblings as unhandled
          // rejections.
          const failure = aggregateFailures(blockingRequests.map((r, i) => ({ name: r.name, result: settled[i] })))
          if (failure) throw failure
        })
        .then(async () => {
          // 261113 Red 新一轮已开始/provider 已卸载：这一轮的阻塞结果作废，不写 store，
          // 也不启动后台请求——新的一轮会自己起。
          if (!live || attempt !== bootstrapGeneration) return
          const [providers, agents, config] = await Promise.all([
            providersPromise.then((x) => x.data!),
            agentsPromise.then((x) => x.data ?? []),
            configPromise.then((x) => x.data!),
          ])
          const sessions = args.continue ? await rawSessionList : undefined
          if (!live || attempt !== bootstrapGeneration) return
          batch(() => {
            setStore("provider", reconcile(providers.providers))
            setStore("provider_default", reconcile(providers.default))
            setStore("agent", reconcile(agents))
            setStore("config", reconcile(config))
            if (sessions !== undefined) setStore("session", reconcile(sessions))
          })
        })
        .then(() => {
          if (!live || attempt !== bootstrapGeneration) return
          if (store.status !== "complete") setStore("status", "partial")
          startBackground(attempt, workspace, consoleStatePromise, sessionListPromise)
        })
        .catch(async (e) => {
          Log.Default.error("tui bootstrap failed", {
            error: e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          // 261110 Red 已卸载的 provider 只记日志：旧目录的迟到失败不能连坐整个 TUI。
          if (!live) return
          // 261113 Red 旧一轮的失败不再触发退出：新一轮（或已完成的当前轮）才是权威，
          // 旧轮迟到的错误只留在日志里。非 fatal 调用方仍拿到自己的异常。
          if (!fatal) throw e
          if (attempt === bootstrapGeneration) await exit(e)
        })
    }

    // 261113 Red 第二阶段互不阻塞：
    // ① 恢复类（会话状态/提问/权限）由 bootstrap 开头发起，各自落地即播种活动摘要，
    //    谁也不等谁——MCP 等无关请求悬挂不拖累权限/提问/busy 的恢复；权限请求照常
    //    拉取，不因别的请求悬挂而跳过。
    // ② 其余可选请求各写各的，失败逐项带端点记日志；到 OPTIONAL_REQUEST_TIMEOUT_MS
    //    仍未落地再记一条 timed out（数据路径不变，迟到结果仍按 generation 守卫落盘）。
    // ③ complete 只等 session 列表写入：--session --fork 与 --continue 都要求列表先
    //    到（否则迟到的列表 reconcile 会覆盖刚分叉出来的会话），其余请求悬挂不再把
    //    TUI 永远拦在 partial。
    function startBackground(
      attempt: number,
      workspace: string | undefined,
      consoleStatePromise: Promise<Outcome<ConsoleState>>,
      sessionListPromise: Promise<Outcome<Session[]>>,
    ) {
      void consoleStatePromise.then((outcome) => {
        if (!live || attempt !== bootstrapGeneration || !outcome.ok) return
        setStore("console_state", reconcile(outcome.value))
      })
      void settle(attempt, "command.list", () => sdk.client.command.list({ workspace }), (data) =>
        setStore("command", reconcile(data)),
      )
      void settle(attempt, "lsp.status", () => sdk.client.lsp.status({ workspace }), (data) =>
        setStore("lsp", reconcile(data)),
      )
      void settle(attempt, "mcp.status", () => sdk.client.mcp.status({ workspace }), (data) =>
        setStore("mcp", reconcile(data)),
      )
      void settle(attempt, "resource.list", () => sdk.client.experimental.resource.list({ workspace }), (data) =>
        setStore("mcp_resource", reconcile(data)),
      )
      void settle(attempt, "formatter.status", () => sdk.client.formatter.status({ workspace }), (data) =>
        setStore("formatter", reconcile(data)),
      )
      void settle(attempt, "provider.auth", () => sdk.client.provider.auth({ workspace }), (data) =>
        setStore("provider_auth", reconcile(data)),
      )
      void settle(attempt, "provider.quota", () => sdk.client.provider.quota({ workspace }), (data) =>
        setStore("provider_quota", reconcile(data)),
      )
      void settle(attempt, "vcs.get", () => sdk.client.vcs.get({ workspace }), (data) => setStore("vcs", reconcile(data)))
      void current(attempt, "project.workspace.sync", project.workspace.sync(), () => {})

      const finish = () => {
        if (!live || attempt !== bootstrapGeneration) return
        // 261113 Red 启动快照：恢复合并后的 store 就是当前目录活动摘要的权威初始值
        // （busy 集合 + 等待请求），同步推给 Navigation，之后继续由实时事件维护。
        // 只覆盖本次实际进入的目录，不预热历史工作区。
        seedNavigation()
        setStore("status", "complete")
      }
      // --continue 的 session.list 已在阻塞阶段写入 store，partial 即完整数据；
      // 其余情况 complete 必须等列表「成功」落地（见函数头注释③）。
      if (args.continue) {
        finish()
        return
      }
      void sessionListPromise.then((outcome) => {
        if (!live || attempt !== bootstrapGeneration) return
        if (!outcome.ok) {
          // 261113 Red 列表没落地就不标 complete：--session --fork 依赖它（fork 后迟到的
          // 列表 reconcile 会覆盖分叉会话）。首页不受影响——ready 只要求 status !== "loading"，
          // partial 已可交互；失败本身已由 observe 按 endpoint 记录，这里只补一条「为何没
          // complete」的说明。
          Log.Default.warn("tui bootstrap complete withheld", { endpoint: "session.list" })
          return
        }
        setStore("session", reconcile(outcome.value))
        finish()
      })
    }

    onMount(() => {
      void bootstrap()
    })

    // 260923 Red sync 与 reconcile 共用：拉当前 session 快照并整体写入 store。
    // 服务端快照权威，message 数组整体替换——重复调用天然幂等，不叠消息/part。
    async function loadSessionSnapshot(sessionID: string) {
      const [session, messages, todo, diff, goal] = await Promise.all([
        sdk.client.session.get({ sessionID }, { throwOnError: true }),
        // 261108 Red 审计 RC-P1-03：此前没传 throwOnError，请求失败时 data 是 undefined，
        // 被下面的 `?? []` 当成合法空历史整体替换，已有消息在界面里凭空消失；而 sync()
        // 只在 await 不抛时才推进 fullSyncedSessions，所以「失败也标已加载」是假象 ——
        // 真正的原因是失败被这里吞成了空数组。抛出后调用方不标记、下次仍会重试。
        sdk.client.session.messages({ sessionID, limit: 100 }, { throwOnError: true }),
        sdk.client.session.todo({ sessionID }),
        // 260904 cc 只拉元数据（patch=false），Files 侧栏只要文件名与增删数。260903 因为带正文的那份
        // 能到 33MB、卡 23s 把这条 fetch 删了；此后侧栏只靠 session.diff 事件填充，服务端为此
        // 在指纹命中时也照发大 payload。现在 fetch 回来了、事件只在 diff 真变时才发。
        sdk.client.session.diff({ sessionID, patch: false }).catch(() => undefined),
        // 没钉目标时服务端 404，这是常态不是错误
        sdk.client.session.goal({ sessionID }).catch(() => undefined),
      ])
      setStore(
        produce((draft) => {
          const match = Binary.search(draft.session, sessionID, (s) => s.id)
          if (match.found) draft.session[match.index] = session.data!
          if (!match.found) draft.session.splice(match.index, 0, session.data!)
          draft.todo[sessionID] = todo.data ?? []
          draft.goal[sessionID] = goal?.data ?? undefined
          const infos: (typeof draft.message)[string] = []
          for (const message of messages.data ?? []) {
            infos.push(message.info)
            draft.part[message.info.id] = message.parts
          }
          draft.message[sessionID] = infos
          if (diff?.data) draft.session_diff[sessionID] = sidebarDiff(diff.data)
        }),
      )
    }

    // 260923 Red 重连补拉入口：只补当前 session，失败只记日志——补拉是恢复手段，
    // 不是新一轮加载，不该把 TUI 再拖进错误路径。
    function reconcileCurrentSession() {
      const sessionID = currentSessionID
      if (!sessionID) return
      void result.session.reconcile(sessionID).catch((e) => {
        Log.Default.warn("tui session reconcile failed", { error: e instanceof Error ? e.message : String(e) })
      })
    }

    // 261110 Red 阅读锚点被离开期间的新消息挤出默认 100 条窗口时向前翻页。服务端
    // before 接受消息 id，返回整页升序；遇到压缩摘要说明已到可见历史起点，再往前
    // 是被摘要覆盖的旧消息，不能重新放进界面。
    async function loadEarlierMessages(sessionID: string) {
      const loaded = store.message[sessionID] ?? []
      const oldest = loaded[0]
      if (!oldest) return false
      if (oldest.role === "assistant" && oldest.summary) return false
      const page = await sdk.client.session.messages(
        { sessionID, limit: 100, before: oldest.id },
        { throwOnError: true },
      )
      const items = page.data ?? []
      if (!items.length) return false
      const boundary = items.findIndex((item) => item.info.role === "assistant" && item.info.summary)
      const known = new Set(loaded.map((message) => message.id))
      const older = (boundary >= 0 ? items.slice(boundary + 1) : items).filter((item) => !known.has(item.info.id))
      if (older.length) {
        setStore(
          produce((draft) => {
            for (const item of older) draft.part[item.info.id] = item.parts
            draft.message[sessionID] = [...older.map((item) => item.info), ...(draft.message[sessionID] ?? [])]
          }),
        )
      }
      return boundary < 0 && older.length > 0
    }

    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        if (process.env.REDCODE_FAST_BOOT) return true
        return store.status !== "loading"
      },
      get path() {
        return project.instance.path()
      },
      session: {
        get(sessionID: string) {
          const match = Binary.search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        query() {
          return sessionListQuery()
        },
        async refresh() {
          const list = await listSessions()
          setStore("session", reconcile(list))
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async sync(sessionID: string) {
          currentSessionID = sessionID
          if (fullSyncedSessions.has(sessionID)) return
          await loadSessionSnapshot(sessionID)
          fullSyncedSessions.add(sessionID)
        },
        // 260923 Red 断线恢复补拉：绕过 fullSyncedSessions 短路（sync 对已加载会话直接
        // return），服务端快照整体替换本地。与 sync 的「首次完整加载」语义分开，不共用
        // 一个开关。
        async reconcile(sessionID: string) {
          currentSessionID = sessionID
          await loadSessionSnapshot(sessionID)
          fullSyncedSessions.add(sessionID)
        },
        // 261110 Red 阅读位置恢复用：向前补取一页并前置，不推进 fullSyncedSessions。
        loadEarlier(sessionID: string) {
          return loadEarlierMessages(sessionID)
        },
      },
      bootstrap,
      // 261022 Red 供应商目录懒加载入口：弹窗打开时兜底触发（幂等）。
      ensureProviderList,
    }
    return result
  },
})
