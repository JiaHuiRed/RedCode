import type {
  Config,
  OpencodeClient,
  Path,
  PermissionRequest,
  Project,
  ProviderAuthResponse,
  ProviderQuota,
  QuestionRequest,
  Session,
  Todo,
} from "@redcode-ai/sdk/v2/client"
import { showToast } from "@redcode-ai/ui/toast"
import { getFilename } from "@redcode-ai/core/util/path"
import { retry } from "@redcode-ai/core/util/retry"
import { batch } from "solid-js"
import { reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type { State, VcsCache } from "./types"
import { cmp, normalizeAgentList, normalizeConfigProviderList, normalizeProviderList } from "./utils"
import { formatServerError } from "@/utils/server-errors"
import { compareTime } from "@/utils/id"
import { QueryClient, queryOptions } from "@tanstack/solid-query"
import { NormalizedProviderListResponse } from "@redcode-ai/ui/context"

type GlobalStore = {
  ready: boolean
  path: Path
  project: Project[]
  session_todo: {
    [sessionID: string]: Todo[]
  }
  provider: NormalizedProviderListResponse
  provider_catalog: NormalizedProviderListResponse
  provider_auth: ProviderAuthResponse
  provider_quota: ProviderQuota[]
  config: Config
  reload: undefined | "pending" | "complete"
}

function waitForPaint() {
  return new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    const timer = setTimeout(finish, 50)
    if (typeof requestAnimationFrame !== "function") return
    requestAnimationFrame(() => {
      setTimeout(() => {
        clearTimeout(timer)
        finish()
      }, 0)
    })
  })
}

function errors(list: PromiseSettledResult<unknown>[]) {
  return list.filter((item): item is PromiseRejectedResult => item.status === "rejected").map((item) => item.reason)
}

const providerRev = new Map<string, number>()

export function clearProviderRev(directory: string) {
  providerRev.delete(directory)
}

function runAll(list: Array<() => Promise<unknown>>) {
  return Promise.allSettled(list.map((item) => item()))
}

function showErrors(input: {
  errors: unknown[]
  title: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
}) {
  if (input.errors.length === 0) return
  const message = formatServerError(input.errors[0], input.translate)
  const more = input.errors.length > 1 ? input.formatMoreCount(input.errors.length - 1) : ""
  showToast({
    variant: "error",
    title: input.title,
    description: message + more,
  })
}

export const loadGlobalConfigQuery = (sdk: OpencodeClient) =>
  queryOptions({
    queryKey: ["config"],
    queryFn: () => retry(() => sdk.global.config.get().then((x) => x.data!)),
  })

export const loadProjectsQuery = (sdk: OpencodeClient) =>
  queryOptions({
    queryKey: ["project"],
    queryFn: () =>
      retry(() =>
        sdk.project.list().then((x) => {
          return (x.data ?? [])
            .filter((p) => !!p?.id)
            .filter((p) => !!p.worktree && !p.worktree.includes("redcode-test"))
            .slice()
            .sort((a, b) => cmp(a.id, b.id))
        }),
      ),
  })

export async function bootstrapGlobal(input: {
  globalSDK: OpencodeClient
  requestFailedTitle: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
  setGlobalStore: SetStoreFunction<GlobalStore>
  queryClient: QueryClient
}) {
  const slow = [
    () => input.queryClient.fetchQuery(loadGlobalConfigQuery(input.globalSDK)),
    () => input.queryClient.fetchQuery(loadProvidersQuery(null, input.globalSDK)),
    () =>
      input.queryClient
        .fetchQuery(loadProviderQuotaQuery(null, input.globalSDK))
        .then((data) => input.setGlobalStore("provider_quota", data)),
    () => input.queryClient.fetchQuery(loadPathQuery(null, input.globalSDK)),
    () =>
      input.queryClient
        .fetchQuery(loadProjectsQuery(input.globalSDK))
        .then((data) => input.setGlobalStore("project", data)),
  ]
  await runAll(slow)
  // showErrors({
  //   errors: errors(),
  //   title: input.requestFailedTitle,
  //   translate: input.translate,
  //   formatMoreCount: input.formatMoreCount,
  // })
}

function groupBySession<T extends { id: string; sessionID: string }>(input: T[]) {
  return input.reduce<Record<string, T[]>>((acc, item) => {
    if (!item?.id || !item.sessionID) return acc
    const list = acc[item.sessionID]
    if (list) list.push(item)
    if (!list) acc[item.sessionID] = [item]
    return acc
  }, {})
}

function projectID(directory: string, projects: Project[]) {
  return projects.find((project) => project.worktree === directory || project.sandboxes?.includes(directory))?.id
}

function mergeSession(setStore: SetStoreFunction<State>, session: Session) {
  setStore("session", (list) => {
    const next = list.slice()
    // 260814 Red 插入位置改 compareTime（ID 回绕后字典序失真）
    const idx = next.findIndex((item) => compareTime(item, session) >= 0)
    if (idx === -1) return [...next, session]
    if (next[idx]?.id === session.id) {
      next[idx] = session
      return next
    }
    next.splice(idx, 0, session)
    return next
  })
}

function warmSessions(input: {
  ids: string[]
  store: Store<State>
  setStore: SetStoreFunction<State>
  sdk: OpencodeClient
}) {
  const known = new Set(input.store.session.map((item) => item.id))
  const ids = [...new Set(input.ids)].filter((id) => !!id && !known.has(id))
  if (ids.length === 0) return Promise.resolve()
  return Promise.all(
    ids.map((sessionID) =>
      retry(() => input.sdk.session.get({ sessionID })).then((x) => {
        const session = x.data
        if (!session?.id) return
        mergeSession(input.setStore, session)
      }),
    ),
  ).then(() => undefined)
}

export const loadProvidersQuery = (directory: string | null, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [directory, "providers"],
    queryFn: () =>
      retry(() =>
        sdk.config.providers().then((x) =>
          normalizeConfigProviderList({
            providers: x.data?.providers ?? [],
            default: x.data?.default ?? {},
          }),
        ),
      ),
  })

/**
 * models.dev 全量目录（未连接的厂商也在里面）。
 *
 * 260901 cc 从关键路径上摘下来的那 5.7MB。三条约束都写在这里，别再挪回去：
 *
 * ① **key 不带 directory。** 目录之间这份数据完全相同，之前 `[directory, "providers"]` 的
 *    key 让每进一个新目录就重新拉一次 5879KB —— 传输、解析、7378 个模型对象的 Map，
 *    以及在 query 缓存里各留一份常驻内存（16G 机器上这条比耗时更要命）。
 * ② **不进 bootstrap 的 slow 组。** 首屏没有任何一处需要未连接的厂商，进项目那条路径
 *    只用得上 [loadProvidersQuery] 的已连接列表。
 * ③ **空闲时拉一次就够。** 消费方只有连接厂商对话框、popular 列表，以及老会话里引用了
 *    已移除厂商时的模型报价兜底 —— 全是可以晚到的。
 */
export const loadProviderCatalogQuery = (sdk: OpencodeClient) =>
  queryOptions({
    queryKey: ["providerCatalog"],
    // 目录本身在服务端是 Effect.cachedInvalidateWithTTL(infinity) 缓存的，进程内不会变；
    // 客户端跟着钉死，避免 refetch 把 5.7MB 再走一遍。
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: () => retry(() => sdk.provider.list().then((x) => normalizeProviderList(x.data!))),
  })

/**
 * 项目用量聚合。260901 cc 首页看板的数据源，见服务端 session/usage.ts。
 *
 * 走服务端而不是前端 reduce，是因为前端只有已加载的那批会话（首页 limit=114），
 * 算不出真·累计。staleTime 给 60s：这是看板不是实时指标，会话结束后数字才有意义地变化，
 * 每次切标签页都重拉一遍没必要。
 */
export const loadUsageQuery = (directory: string, range: "all" | "30d" | "7d", sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [directory, "usage", range] as const,
    staleTime: 60_000,
    queryFn: () => retry(() => sdk.session.usage({ range }).then((x) => x.data!)),
  })

/**
 * 会话轮次目录。**故意不带 staleTime** —— 目录随每一轮增长，而新一轮的落地由事件流驱动，
 * 界面上的失效点在 message.updated（见 server-sync.tsx 的 invalidate）。给个 staleTime 只会
 * 让刚发的那条在导航栏里迟到。整份日志一次查完，长会话实测也只有几十 KB（预览在 SQL 里
 * 就截断了，见 session/outline.ts）。
 */
export const loadSessionOutlineQuery = (directory: string, sessionID: string, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [directory, "sessionOutline", sessionID] as const,
    queryFn: () => retry(() => sdk.session.outline({ sessionID }).then((x) => x.data?.entries ?? [])),
  })

export const loadProviderQuotaQuery = (directory: string | null, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [directory, "providerQuota"],
    queryFn: () => retry(() => sdk.provider.quota().then((x) => x.data ?? [])),
  })

export const loadAgentsQuery = (directory: string | null, sdk: OpencodeClient) =>
  queryOptions({
    queryKey: [directory, "agents"],
    queryFn: () => retry(() => sdk.app.agents().then((x) => normalizeAgentList(x.data))),
  })

export const loadPathQuery = (directory: string | null, sdk: OpencodeClient) =>
  queryOptions<Path>({
    queryKey: [directory, "path"],
    queryFn: () => retry(() => sdk.path.get().then((x) => x.data!)),
  })

export async function bootstrapDirectory(input: {
  directory: string
  sdk: OpencodeClient
  store: Store<State>
  setStore: SetStoreFunction<State>
  vcsCache: VcsCache
  loadSessions: (directory: string) => Promise<void> | void
  translate: (key: string, vars?: Record<string, string | number>) => string
  global: {
    config: Config
    path: Path
    project: Project[]
    provider: NormalizedProviderListResponse
  }
  queryClient: QueryClient
}) {
  const seededProject = projectID(input.directory, input.global.project)
  const seededPath = input.global.path.directory === input.directory ? input.global.path : undefined
  if (seededProject) input.setStore("project", seededProject)
  if (seededPath) input.setStore("path", seededPath)
  if (Object.keys(input.store.config).length === 0 && Object.keys(input.global.config).length > 0) {
    input.setStore("config", reconcile(input.global.config, { merge: false }))
  }

  const rev = (providerRev.get(input.directory) ?? 0) + 1
  providerRev.set(input.directory, rev)
  ;(async () => {
    const slow = [
      () => Promise.resolve(input.loadSessions(input.directory)),
      () => {
        // 260605 Red agent 到位后置 ready。加安全超时：如果 SDK 请求 hang 住（如代理不通），
        // 5s 后强制置 true，避免 submit gate 永假导致输入框完全无法发送。
        let settled = false
        const done = (data: any[]) => {
          if (settled) return
          settled = true
          input.setStore("agent", data)
          input.setStore("agent_ready", true)
        }
        // 260606 Red 安全超时只置 ready 标志，不清空列表、不设 settled。
        // 后续 SDK 成功响应仍可调用 done(data) 填充列表，避免 toast 误弹。
        setTimeout(() => {
          if (settled) return
          input.setStore("agent_ready", true)
        }, 5_000)
        return input.queryClient
          .ensureQueryData(loadAgentsQuery(input.directory, input.sdk))
          .then((data) => done(data))
          .catch(() => done([]))
      },
      () =>
        retry(() => input.sdk.config.get().then((x) => input.setStore("config", reconcile(x.data!, { merge: false })))),
      () => retry(() => input.sdk.session.status().then((x) => input.setStore("session_status", x.data!))),
      !seededProject &&
        (() => retry(() => input.sdk.project.current()).then((x) => input.setStore("project", x.data!.id))),
      !seededPath &&
        (() =>
          input.queryClient.ensureQueryData(loadPathQuery(input.directory, input.sdk)).then((data) => {
            const next = projectID(data.directory ?? input.directory, input.global.project)
            if (next) input.setStore("project", next)
          })),
      () =>
        retry(() =>
          input.sdk.vcs.get().then((x) => {
            const next = x.data ?? input.store.vcs
            input.setStore("vcs", next)
            if (next) input.vcsCache.setStore("value", next)
          }),
        ),
      () => retry(() => input.sdk.command.list().then((x) => input.setStore("command", x.data ?? []))),
      () =>
        retry(() =>
          input.sdk.permission.list().then((x) => {
            const ids = (x.data ?? []).map((perm) => perm?.sessionID).filter((id): id is string => !!id)
            const grouped = groupBySession(
              (x.data ?? []).filter((perm): perm is PermissionRequest => !!perm?.id && !!perm.sessionID),
            )
            return warmSessions({ ids, store: input.store, setStore: input.setStore, sdk: input.sdk }).then(() =>
              batch(() => {
                for (const sessionID of Object.keys(input.store.permission)) {
                  if (grouped[sessionID]) continue
                  input.setStore("permission", sessionID, [])
                }
                for (const [sessionID, permissions] of Object.entries(grouped)) {
                  input.setStore(
                    "permission",
                    sessionID,
                    reconcile(
                      permissions.filter((p) => !!p?.id).sort((a, b) => cmp(a.id, b.id)),
                      { key: "id" },
                    ),
                  )
                }
              }),
            )
          }),
        ),
      () =>
        retry(() =>
          input.sdk.question.list().then((x) => {
            const ids = (x.data ?? []).map((question) => question?.sessionID).filter((id): id is string => !!id)
            const grouped = groupBySession((x.data ?? []).filter((q): q is QuestionRequest => !!q?.id && !!q.sessionID))
            return warmSessions({ ids, store: input.store, setStore: input.setStore, sdk: input.sdk }).then(() =>
              batch(() => {
                for (const sessionID of Object.keys(input.store.question)) {
                  if (grouped[sessionID]) continue
                  input.setStore("question", sessionID, [])
                }
                for (const [sessionID, questions] of Object.entries(grouped)) {
                  input.setStore(
                    "question",
                    sessionID,
                    reconcile(
                      questions.filter((q) => !!q?.id).sort((a, b) => cmp(a.id, b.id)),
                      { key: "id" },
                    ),
                  )
                }
              }),
            )
          }),
        ),
      () => Promise.resolve(input.loadSessions(input.directory)),
      // 260608 Red 进入项目时由 session 页 loadMcp 触发连接，bootstrap 不再预取 MCP，
      //   避免首页 N 项目 × M server 并发 spawn 风暴/黑窗
      () =>
        input.queryClient.fetchQuery(loadProvidersQuery(input.directory, input.sdk)).catch((err) => {
          const project = getFilename(input.directory)
          showToast({
            variant: "error",
            title: input.translate("toast.project.reloadFailed.title", { project }),
            description: formatServerError(err, input.translate),
          })
        }),
    ].filter(Boolean) as (() => Promise<any>)[]

    await waitForPaint()
    const slowErrs = errors(await runAll(slow))
    if (slowErrs.length > 0) {
      console.error("Failed to finish bootstrap instance", slowErrs[0])
      const project = getFilename(input.directory)
      showToast({
        variant: "error",
        title: input.translate("toast.project.reloadFailed.title", { project }),
        description: formatServerError(slowErrs[0], input.translate),
      })
    }
  })()
}
