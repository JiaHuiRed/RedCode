import { createRoot, createSignal, getOwner, onCleanup, runWithOwner, type Owner } from "solid-js"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import type { VcsInfo } from "@redcode-ai/sdk/v2/client"
import {
  DIR_IDLE_TTL_MS,
  MAX_DIR_STORES,
  type ChildOptions,
  type DirState,
  type IconCache,
  type MetaCache,
  type ProjectMeta,
  type State,
  type VcsCache,
} from "./types"
import { canDisposeDirectory, pickDirectoriesToEvict } from "./eviction"
import { useQuery } from "@tanstack/solid-query"
import { QueryOptionsApi } from "../server-sync"
import { directoryKey, type DirectoryKey } from "./utils"
import { NormalizedProviderListResponse } from "@redcode-ai/ui/context"

// 260608 Red 当前进入的项目目录；只有它的 mcp/path/lsp/provider query enabled→连接
//   （260706 扩到后三者，见下方 useQuery 注释）。首页列项目阶段一律不连
//   （避免 N 项目 × M server 并发 spawn 风暴/黑窗——含 InstanceStore.load() 拉起的 LSP 子进程），
//   进项目时由 session 页 setActiveMcpDirectory 触发这些 query 拉取（数据直接进各自 query.data，面板可见）。
const [activeMcpDirectory, setActiveMcpDirectory] = createSignal<string>("")
export { setActiveMcpDirectory, activeMcpDirectory }

export function createChildStoreManager(input: {
  owner: Owner
  isBooting: (directory: string) => boolean
  isLoadingSessions: (directory: string) => boolean
  onBootstrap: (directory: string) => void
  onDispose: (directory: string) => void
  translate: (key: string, vars?: Record<string, string | number>) => string
  queryOptions: QueryOptionsApi
  global: {
    provider: NormalizedProviderListResponse
  }
}) {
  const children: Record<string, [Store<State>, SetStoreFunction<State>]> = {}
  const vcsCache = new Map<string, VcsCache>()
  const metaCache = new Map<string, MetaCache>()
  const iconCache = new Map<string, IconCache>()
  const lifecycle = new Map<string, DirState>()
  const pins = new Map<string, number>()
  const ownerPins = new WeakMap<object, Set<string>>()
  const disposers = new Map<string, () => void>()
  // 260707 Red 记录已真正触发过 bootstrap 的目录。之前用 childStore.status === "loading"
  //   做二次触发判断，但 status 永远硬编码 "complete"，判断恒假——导致任何一次
  //   {bootstrap:false} 首触（如 enrich()/recentProjects 对全部历史项目遍历）都会
  //   永久锁死该目录，后续哪怕带 {bootstrap:true} 真正进入项目也不再触发。
  //   改用显式 Set 记录，仅在"从未真正 bootstrap 过"且调用方要 bootstrap 时触发。
  const bootstrapped = new Set<string>()

  const markKey = (key: DirectoryKey) => {
    if (!key) return
    lifecycle.set(key, { lastAccessAt: Date.now() })
    runEviction(key)
  }

  const mark = (directory: string) => {
    const key = directoryKey(directory)
    markKey(key)
  }

  const pin = (directory: string) => {
    const key = directoryKey(directory)
    if (!key) return
    pins.set(key, (pins.get(key) ?? 0) + 1)
    markKey(key)
  }

  const unpin = (directory: string) => {
    const key = directoryKey(directory)
    if (!key) return
    const next = (pins.get(key) ?? 0) - 1
    if (next > 0) {
      pins.set(key, next)
      return
    }
    pins.delete(key)
    runEviction()
  }

  const pinned = (directory: string) => (pins.get(directoryKey(directory)) ?? 0) > 0

  const pinForOwner = (directory: string) => {
    const current = getOwner()
    if (!current) return
    if (current === input.owner) return
    const key = current as object
    const set = ownerPins.get(key)
    if (set?.has(directory)) return
    if (set) set.add(directory)
    if (!set) ownerPins.set(key, new Set([directory]))
    pin(directory)
    onCleanup(() => {
      const set = ownerPins.get(key)
      if (set) {
        set.delete(directory)
        if (set.size === 0) ownerPins.delete(key)
      }
      unpin(directory)
    })
  }

  function disposeDirectory(directory: DirectoryKey) {
    const key = directory
    if (
      !canDisposeDirectory({
        directory: key,
        hasStore: !!children[key],
        pinned: pinned(key),
        booting: input.isBooting(key),
        loadingSessions: input.isLoadingSessions(key),
      })
    ) {
      return false
    }

    vcsCache.delete(key)
    metaCache.delete(key)
    iconCache.delete(key)
    lifecycle.delete(key)
    bootstrapped.delete(key)
    const dispose = disposers.get(key)
    if (dispose) {
      dispose()
      disposers.delete(key)
    }
    delete children[key]
    input.onDispose(key)
    return true
  }

  function runEviction(skip?: string) {
    const stores = Object.keys(children)
    if (stores.length === 0) return
    const list = pickDirectoriesToEvict({
      stores,
      state: lifecycle,
      pins: new Set(stores.filter(pinned)),
      max: MAX_DIR_STORES,
      ttl: DIR_IDLE_TTL_MS,
      now: Date.now(),
    }).filter((directory) => directory !== skip)
    if (list.length === 0) return
    for (const directory of list) {
      if (!disposeDirectory(directoryKey(directory))) continue
    }
  }

  function ensureChild(directory: string, options: ChildOptions = {}) {
    const key = directoryKey(directory)
    if (!key) console.error("No directory provided")
    if (!children[key]) {
      const vcs = runWithOwner(input.owner, () =>
        persisted(
          Persist.workspace(directory, "vcs", ["vcs.v1"]),
          createStore({ value: undefined as VcsInfo | undefined }),
        ),
      )
      if (!vcs) throw new Error(input.translate("error.childStore.persistedCacheCreateFailed"))
      const vcsStore = vcs[0]
      vcsCache.set(key, { store: vcsStore, setStore: vcs[1], ready: vcs[3] })

      const meta = runWithOwner(input.owner, () =>
        persisted(
          Persist.workspace(directory, "project", ["project.v1"]),
          createStore({ value: undefined as ProjectMeta | undefined }),
        ),
      )
      if (!meta) throw new Error(input.translate("error.childStore.persistedProjectMetadataCreateFailed"))
      metaCache.set(key, { store: meta[0], setStore: meta[1], ready: meta[3] })

      const icon = runWithOwner(input.owner, () =>
        persisted(
          Persist.workspace(directory, "icon", ["icon.v1"]),
          createStore({ value: undefined as string | undefined }),
        ),
      )
      if (!icon) throw new Error(input.translate("error.childStore.persistedProjectIconCreateFailed"))
      iconCache.set(key, { store: icon[0], setStore: icon[1], ready: icon[3] })

      const init = () =>
        createRoot((dispose) => {
          const initialMeta = meta[0].value
          const initialIcon = icon[0].value

          // 260706 Red path/lsp/provider 同 MCP 一样单列成独立 useQuery，不再混在 useQueries
          //   批量 observer 里，理由同下方 260609 那条注释。更关键的是：/path /lsp /provider
          //   三个端点都走 instance 路由，任何一个请求都会触发 InstanceStore.load() 拉起该目录
          //   整套 LSP/watcher/VCS 子进程（capacity: Infinity，永不自动回收）。首页 Kanban 对
          //   所有项目的所有 session 记录都建 child store，之前这三个 query 无条件发出，等于
          //   打开首页不开任何对话就把所有项目的 LSP 全点着——只 gate mcpQuery 是不够的。
          const pathQuery = useQuery(() => ({
            ...input.queryOptions.path(key),
            enabled: directoryKey(activeMcpDirectory()) === key,
          }))
          const lspQuery = useQuery(() => ({
            ...input.queryOptions.lsp(key),
            enabled: directoryKey(activeMcpDirectory()) === key,
          }))
          const providerQuery = useQuery(() => ({
            ...input.queryOptions.providers(key),
            enabled: directoryKey(activeMcpDirectory()) === key,
          }))

          // 260609 Red MCP 单列成独立 useQuery，不再混在 useQueries 批量 observer 里。
          //   useQueries 的批量 observer 对动态 enabled false→true 既不自动 fetch，
          //   也不把外部 fetchQuery 灌入的缓存暴露给 store getter（对话页恒"未配置 MCP"）。
          //   独立 useQuery 的 enabled 翻转能正确触发并反应缓存——仍只连当前进入的项目，
          //   首页其它项目 enabled:false 不连，避免 N 项目 × M server 并发 spawn 风暴/黑窗。
          const mcpQuery = useQuery(() => ({
            ...input.queryOptions.mcp(key),
            enabled: directoryKey(activeMcpDirectory()) === key,
          }))

          const child = createStore<State>({
            project: "",
            projectMeta: initialMeta,
            icon: initialIcon,
            get provider_ready() {
              return !providerQuery.isLoading
            },
            get provider() {
              const EMPTY = { all: new Map(), connected: [], default: {} }
              if (providerQuery.isLoading) return EMPTY
              // 260529 Red 项目级 provider 查询无数据或为空时回退到全局已连接 providers
              const projectData = providerQuery.data
              if (
                !projectData ||
                (projectData.all.size === 0 && input.global.provider.all.size > 0) ||
                (projectData.connected.length === 0 && input.global.provider.connected.length > 0)
              )
                return input.global.provider
              return projectData ?? EMPTY
            },
            config: {},
            get path() {
              if (pathQuery.isLoading || !pathQuery.data)
                return { state: "", config: "", worktree: key, directory: key, home: "" }
              return pathQuery.data
            },
            status: "complete" as const,
            agent: [],
            agent_ready: false,
            command: [],
            session: [],
            sessionTotal: 0,
            session_status: {},
            session_working(id: string) {
              const type = this.session_status[id]?.type
              return (type ?? "idle") !== "idle"
            },
            session_diff: {},
            todo: {},
            permission: {},
            question: {},
            get mcp_ready() {
              return !mcpQuery.isLoading
            },
            get mcp() {
              return mcpQuery.isLoading ? {} : (mcpQuery.data ?? {})
            },
            get lsp_ready() {
              return !lspQuery.isLoading
            },
            get lsp() {
              return lspQuery.isLoading ? [] : (lspQuery.data ?? [])
            },
            vcs: vcsStore.value,
            // 260710 Red 默认从 5 提到 64：首页 HOME_SESSION_LIMIT=64，旧值 5 导致
            // trimSessions 截断后首页最多只显示 5 条 session。session 是轻量元数据，64 不影响内存。
            limit: 64,
            message: {},
            part: {},
            part_text_accum_delta: {},
          })
          children[key] = child
          disposers.set(key, dispose)

          const onPersistedInit = (init: Promise<string> | string | null, run: () => void) => {
            if (!(init instanceof Promise)) return
            void init.then(() => {
              if (children[key] !== child) return
              run()
            })
          }

          onPersistedInit(vcs[2], () => {
            const cached = vcsStore.value
            if (!cached?.branch) return
            child[1]("vcs", (value) => value ?? cached)
          })

          onPersistedInit(meta[2], () => {
            if (child[0].projectMeta !== initialMeta) return
            child[1]("projectMeta", meta[0].value)
          })

          onPersistedInit(icon[2], () => {
            if (child[0].icon !== initialIcon) return
            child[1]("icon", icon[0].value)
          })
        })

      runWithOwner(input.owner, init)
    }
    markKey(key)
    const childStore = children[key]
    if (!childStore) throw new Error(input.translate("error.childStore.storeCreateFailed"))
    // 260707 Red bootstrap 触发与 store 创建解耦：只要调用方要 bootstrap(默认 true)
    // 且该目录从未真正 bootstrap 过，就触发，且仅触发一次——不管这是不是首次创建 store。
    // 这样 enrich()/recentProjects 等 {bootstrap:false} 的遍历不会抢占触发权，
    // 之后用户真正进入项目时(默认 true 或显式 true)依然能正常拉起。
    const shouldBootstrap = options.bootstrap ?? true
    if (shouldBootstrap && !bootstrapped.has(key)) {
      bootstrapped.add(key)
      input.onBootstrap(directory)
    }
    return childStore
  }

  function child(directory: string, options: ChildOptions = {}) {
    const key = directoryKey(directory)
    const childStore = ensureChild(directory, options)
    pinForOwner(key)
    return childStore
  }

  function peek(directory: string, options: ChildOptions = {}) {
    return ensureChild(directory, options)
  }

  function projectMeta(directory: string, patch: ProjectMeta) {
    const key = directoryKey(directory)
    // 260707 Red 元数据写入不需要拉起整套 MCP/LSP/watcher，用 bootstrap:false
    const [store, setStore] = ensureChild(directory, { bootstrap: false })
    const cached = metaCache.get(key)
    if (!cached) return
    const previous = store.projectMeta ?? {}
    const icon = patch.icon ? { ...previous.icon, ...patch.icon } : previous.icon
    const commands = patch.commands ? { ...previous.commands, ...patch.commands } : previous.commands
    const next = {
      ...previous,
      ...patch,
      icon,
      commands,
    }
    cached.setStore("value", next)
    setStore("projectMeta", next)
  }

  function projectIcon(directory: string, value: string | undefined) {
    const key = directoryKey(directory)
    // 260707 Red 图标写入不需要拉起整套 MCP/LSP/watcher，用 bootstrap:false
    const [store, setStore] = ensureChild(directory, { bootstrap: false })
    const cached = iconCache.get(key)
    if (!cached) return
    if (store.icon === value) return
    cached.setStore("value", value)
    setStore("icon", value)
  }

  return {
    children,
    ensureChild,
    child,
    peek,
    projectMeta,
    projectIcon,
    mark,
    pin,
    unpin,
    pinned,
    disposeDirectory,
    runEviction,
    vcsCache,
    metaCache,
    iconCache,
  }
}
