import { useDialog } from "@redcode-ai/ui/context/dialog"
import { Dialog } from "@redcode-ai/ui/dialog"
import { FileIcon } from "@redcode-ai/ui/file-icon"
import { Icon } from "@redcode-ai/ui/icon"
import { Keybind } from "@redcode-ai/ui/keybind"
import { List } from "@redcode-ai/ui/list"
import { base64Encode } from "@redcode-ai/core/util/encode"
import { getDirectory, getFilename } from "@redcode-ai/core/util/path"
import { useNavigate } from "@solidjs/router"
import { createMemo, createResource, createSignal, Match, onCleanup, Show, Switch } from "solid-js"
import { formatKeybind, useCommand, type CommandOption } from "@/context/command"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServerSync } from "@/context/server-sync"
import { useLayout } from "@/context/layout"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { useSessionLayout } from "@/context/session-layout"
import { createSessionTabs } from "@/context/session-layout"
import { decode64 } from "@/utils/base64"
import { getRelativeTime } from "@/utils/time"

type EntryType = "command" | "file" | "session"

type Entry = {
  id: string
  type: EntryType
  title: string
  description?: string
  keybind?: string
  category: string
  option?: CommandOption
  path?: string
  directory?: string
  sessionID?: string
  archived?: number
  updated?: number
}

type DialogSelectFileMode = "all" | "files"

const ENTRY_LIMIT = 5
const COMMON_COMMAND_IDS = [
  "session.new",
  "workspace.new",
  "session.previous",
  "session.next",
  "terminal.toggle",
  "review.toggle",
] as const

const uniqueEntries = (items: Entry[]) => {
  const seen = new Set<string>()
  const out: Entry[] = []
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

const createCommandEntry = (option: CommandOption, category: string): Entry => ({
  id: "command:" + option.id,
  type: "command",
  title: option.title,
  description: option.description,
  keybind: option.keybind,
  category,
  option,
})

const createFileEntry = (path: string, category: string): Entry => ({
  id: "file:" + path,
  type: "file",
  title: path,
  category,
  path,
})

const createSessionEntry = (
  input: {
    directory: string
    id: string
    title: string
    description: string
    archived?: number
    updated?: number
  },
  category: string,
): Entry => ({
  id: `session:${input.directory}:${input.id}`,
  type: "session",
  title: input.title,
  description: input.description,
  category,
  directory: input.directory,
  sessionID: input.id,
  archived: input.archived,
  updated: input.updated,
})

function createCommandEntries(props: {
  filesOnly: () => boolean
  command: ReturnType<typeof useCommand>
  language: ReturnType<typeof useLanguage>
}) {
  const allowed = createMemo(() => {
    if (props.filesOnly()) return []
    return props.command.options.filter(
      (option) =>
        !option.disabled && !option.hidden && !option.id.startsWith("suggested.") && option.id !== "file.open",
    )
  })

  const list = createMemo(() => {
    const category = props.language.t("palette.group.commands")
    return allowed().map((option) => createCommandEntry(option, category))
  })

  const picks = createMemo(() => {
    const all = allowed()
    const order = new Map<string, number>(COMMON_COMMAND_IDS.map((id, index) => [id, index]))
    const picked = all.filter((option) => order.has(option.id))
    const base = picked.length ? picked : all.slice(0, ENTRY_LIMIT)
    const sorted = picked.length ? [...base].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)) : base
    const category = props.language.t("palette.group.commands")
    return sorted.map((option) => createCommandEntry(option, category))
  })

  return { allowed, list, picks }
}

function createFileEntries(props: {
  file: ReturnType<typeof useFile>
  tabs: () => ReturnType<ReturnType<typeof useLayout>["tabs"]>
  language: ReturnType<typeof useLanguage>
}) {
  const tabState = createSessionTabs({
    tabs: props.tabs,
    pathFromTab: props.file.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? props.file.tab(tab) : tab),
  })
  const recent = createMemo(() => {
    const all = tabState.openedTabs()
    const active = tabState.activeFileTab()
    const order = active ? [active, ...all.filter((item) => item !== active)] : all
    const seen = new Set<string>()
    const category = props.language.t("palette.group.files")
    const items: Entry[] = []

    for (const item of order) {
      const path = props.file.pathFromTab(item)
      if (!path) continue
      if (seen.has(path)) continue
      seen.add(path)
      items.push(createFileEntry(path, category))
    }

    return items.slice(0, ENTRY_LIMIT)
  })

  const root = createMemo(() => {
    const category = props.language.t("palette.group.files")
    const nodes = props.file.tree.children("")
    const paths = nodes
      .filter((node) => node.type === "file")
      .map((node) => node.path)
      .sort((a, b) => a.localeCompare(b))
    return paths.slice(0, ENTRY_LIMIT).map((path) => createFileEntry(path, category))
  })

  return { recent, root }
}

function createSessionEntries(props: {
  workspaces: () => string[]
  label: (directory: string) => string
  globalSDK: ReturnType<typeof useGlobalSDK>
  language: ReturnType<typeof useLanguage>
}) {
  const state: {
    token: number
    // 261114 Red UX-09 评审修正：空查询（最近会话）与搜索各有在途槽，互不阻塞；
    // 槽位存「起跑令牌」——守卫判有效性（槽令牌 === 当前令牌）而非存在性：
    // 被对方作废的在途请求不再挡新一轮加载（二轮评审抓到的竞态）。
    inflight: { token: number } | undefined
    emptyInflight: { token: number } | undefined
    cached: Entry[] | undefined
  } = {
    token: 0,
    inflight: undefined,
    emptyInflight: undefined,
    cached: undefined,
  }

  // 261110 Red 会话列表改为「后台拉取、signal 同步可读」：首次非空查询的 fetch
  // 在途期间 entries() 返回 []（命令先出，会话落地后补进列表），不再让本地条目陪等。
  // setEntries 必须命中相同引用（prev / cached）时保持原引用，否则 items() 在
  // 响应式追踪内调用 sessions() 会因每次键击写新数组而无限重算。
  const [entries, setEntries] = createSignal<Entry[]>([])

  const sessions = (text: string) => {
    const query = text.trim()
    if (!query) {
      // 261114 Red UX-09 评审修正：空查询是「加载最近会话」，不是清空——此前只清
      // 缓存直接返回，选择器打开时最近会话永远不出现。空查询与搜索共用同一加载
      // 管线但不写查询缓存；token 先自增作废在途搜索结果，避免旧搜索落地抢位。
      if (state.emptyInflight?.token === state.token) return
      state.token += 1
      state.inflight = undefined
      state.cached = undefined
      const current = state.token
      const dirs = props.workspaces()
      if (dirs.length === 0) return
      state.emptyInflight = { token: current }
      void Promise.all(
        dirs.map((directory) => {
          const description = props.label(directory)
          return props.globalSDK.client.session
            .list({ directory, roots: true })
            .then((x) =>
              (x.data ?? [])
                .filter((s) => !!s?.id)
                .map((s) => ({
                  id: s.id,
                  title: s.title ?? props.language.t("command.session.new"),
                  description,
                  directory,
                  archived: s.time?.archived,
                  updated: s.time?.updated,
                })),
            )
            .catch(
              () =>
                [] as {
                  id: string
                  title: string
                  description: string
                  directory: string
                  archived?: number
                  updated?: number
                }[],
            )
        }),
      )
        .then((results) => {
          if (state.token !== current) return
          const seen = new Set<string>()
          const category = props.language.t("command.category.session")
          const next = results
            .flat()
            .filter((item) => {
              const key = `${item.directory}:${item.id}`
              if (seen.has(key)) return false
              seen.add(key)
              return true
            })
            .map((item) => createSessionEntry(item, category))
          setEntries(next)
        })
        .catch(() => {})
        .finally(() => {
          if (state.emptyInflight?.token === current) state.emptyInflight = undefined
        })
      return
    }

    if (state.cached) {
      setEntries(state.cached)
      return
    }
    if (state.inflight?.token === state.token) return

    // 261114 Red UX-09 评审修正：搜索起跑时令牌自增，作废在途的最近会话响应，
    // 避免它晚落地把搜索结果顶掉。
    state.token += 1
    const current = state.token
    const dirs = props.workspaces()
    if (dirs.length === 0) return

    state.inflight = { token: current }
    void Promise.all(
      dirs.map((directory) => {
        const description = props.label(directory)
        return props.globalSDK.client.session
          .list({ directory, roots: true })
          .then((x) =>
            (x.data ?? [])
              .filter((s) => !!s?.id)
              .map((s) => ({
                id: s.id,
                title: s.title ?? props.language.t("command.session.new"),
                description,
                directory,
                archived: s.time?.archived,
                updated: s.time?.updated,
              })),
          )
          .catch(
            () =>
              [] as {
                id: string
                title: string
                description: string
                directory: string
                archived?: number
                updated?: number
              }[],
          )
      }),
    )
      .then((results) => {
        if (state.token !== current) return
        const seen = new Set<string>()
        const category = props.language.t("command.category.session")
        const next = results
          .flat()
          .filter((item) => {
            const key = `${item.directory}:${item.id}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
          .map((item) => createSessionEntry(item, category))
        state.cached = next
        setEntries(next)
      })
      .catch(() => {})
      .finally(() => {
        if (state.inflight?.token === current) state.inflight = undefined
      })
  }

  return { sessions, entries }
}

export function DialogSelectFile(props: { mode?: DialogSelectFileMode; onOpenFile?: (path: string) => void }) {
  const command = useCommand()
  const language = useLanguage()
  const layout = useLayout()
  const file = useFile()
  const dialog = useDialog()
  const navigate = useNavigate()
  const globalSDK = useGlobalSDK()
  const globalSync = useServerSync()
  const { params, tabs, view } = useSessionLayout()
  const filesOnly = () => props.mode === "files"
  const state = { cleanup: undefined as (() => void) | void, committed: false }
  const [grouped, setGrouped] = createSignal(false)
  const commandEntries = createCommandEntries({ filesOnly, command, language })
  const fileEntries = createFileEntries({ file, tabs, language })

  const projectDirectory = createMemo(() => decode64(params.dir) ?? "")
  const project = createMemo(() => {
    const directory = projectDirectory()
    if (!directory) return
    return layout.projects.list().find((p) => p.worktree === directory || p.sandboxes?.includes(directory))
  })
  const workspaces = createMemo(() => {
    const directory = projectDirectory()
    const current = project()
    if (!current) return directory ? [directory] : []

    const dirs = [current.worktree, ...(current.sandboxes ?? [])]
    if (directory && !dirs.includes(directory)) return [...dirs, directory]
    return dirs
  })
  const homedir = createMemo(() => globalSync.data.path.home)
  const label = (directory: string) => {
    const current = project()
    const kind =
      current && directory === current.worktree
        ? language.t("workspace.type.local")
        : language.t("workspace.type.sandbox")
    const [store] = globalSync.child(directory, { bootstrap: false })
    const home = homedir()
    const path = home ? directory.replace(home, "~") : directory
    const name = store.vcs?.branch ?? getFilename(directory)
    return `${kind} : ${name || path}`
  }

  const { sessions, entries: sessionEntries } = createSessionEntries({ workspaces, label, globalSDK, language })

  // 261110 Red 本地结果不再陪远程等待：文件搜索放进后台 resource（latest 即上一
  // 次查询的结果，在途时照常显示，落地后经响应链触发 items 重算补进列表）。items
  // 变为同步函数——命令、最近文件立即可选，Enter 不再被远程请求挂住。
  const [query, setQuery] = createSignal("")
  const [searchedFiles] = createResource(query, async (value) => {
    const text = value.trim()
    if (!text) return []
    return file.searchFiles(text)
  })

  const items = (text: string) => {
    const query = text.trim()
    setQuery(text)
    setGrouped(query.length > 0)

    if (!query && filesOnly()) {
      // 树未加载时后台拉根目录：fileEntries.root() 读 tree store，落地后经响应链刷新列表
      if (!file.tree.state("")?.loaded) void file.tree.list("")
      return uniqueEntries([...fileEntries.recent(), ...fileEntries.root()])
    }

    if (!query) {
      // 261114 Red UX-09：空查询补最近会话（sessions("") 触发后台加载，落地后刷新）。
      sessions("")
      return [...commandEntries.picks(), ...sessionEntries(), ...fileEntries.recent()]
    }

    // 触发/续用会话列表后台加载；entries() 同步读，未落地时为 []（命令先出）
    sessions(query)
    const category = language.t("palette.group.files")
    const files = (searchedFiles.latest ?? []).map((path) => createFileEntry(path, category))
    if (filesOnly()) return uniqueEntries([...fileEntries.recent(), ...files])
    return [...commandEntries.list(), ...sessionEntries(), ...files]
  }

  const handleMove = (item: Entry | undefined) => {
    state.cleanup?.()
    if (!item) return
    if (item.type !== "command") return
    state.cleanup = item.option?.onHighlight?.()
  }

  const open = (path: string) => {
    const value = file.tab(path)
    void tabs().open(value)
    void file.load(path)
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
    layout.fileTree.setTab("all")
    props.onOpenFile?.(path)
    tabs().setActive(value)
  }

  const handleSelect = (item: Entry | undefined) => {
    if (!item) return
    state.committed = true
    state.cleanup = undefined
    dialog.close()

    if (item.type === "command") {
      item.option?.onSelect?.("palette")
      return
    }

    if (item.type === "session") {
      if (!item.directory || !item.sessionID) return
      navigate(`/${base64Encode(item.directory)}/session/${item.sessionID}`)
      return
    }

    if (!item.path) return
    open(item.path)
  }

  onCleanup(() => {
    if (state.committed) return
    state.cleanup?.()
  })

  return (
    <Dialog class="pt-3 pb-0 !max-h-[480px]" transition>
      <List
        search={{
          placeholder: filesOnly()
            ? language.t("session.header.searchFiles")
            : language.t("palette.search.placeholder"),
          autofocus: true,
          hideIcon: true,
        }}
        emptyMessage={language.t("palette.empty")}
        loadingMessage={language.t("common.loading")}
        items={items}
        key={(item) => item.id}
        filterKeys={["title", "description", "category"]}
        groupBy={grouped() ? (item) => item.category : () => ""}
        onMove={handleMove}
        onSelect={handleSelect}
      >
        {(item) => (
          <Switch
            fallback={
              <div class="w-full flex items-center justify-between rounded-md pl-1">
                <div class="flex items-center gap-x-3 grow min-w-0">
                  <FileIcon node={{ path: item.path ?? "", type: "file" }} class="shrink-0 size-4" />
                  <div class="flex items-center text-14-regular">
                    <span class="text-text-weak whitespace-nowrap overflow-hidden overflow-ellipsis truncate min-w-0">
                      {getDirectory(item.path ?? "")}
                    </span>
                    <span class="text-text-strong whitespace-nowrap">{getFilename(item.path ?? "")}</span>
                  </div>
                </div>
              </div>
            }
          >
            <Match when={item.type === "command"}>
              <div class="w-full flex items-center justify-between gap-4">
                <div class="flex items-center gap-2 min-w-0">
                  <span class="text-14-regular text-text-strong whitespace-nowrap">{item.title}</span>
                  <Show when={item.description}>
                    <span class="text-14-regular text-text-weak truncate">{item.description}</span>
                  </Show>
                </div>
                <Show when={item.keybind}>
                  <Keybind class="rounded-[4px]">{formatKeybind(item.keybind ?? "", language.t)}</Keybind>
                </Show>
              </div>
            </Match>
            <Match when={item.type === "session"}>
              <div class="w-full flex items-center justify-between rounded-md pl-1">
                <div class="flex items-center gap-x-3 grow min-w-0">
                  <Icon name="bubble-5" size="small" class="shrink-0 text-icon-weak" />
                  <div class="flex items-center gap-2 min-w-0">
                    <span
                      class="text-14-regular text-text-strong truncate"
                      classList={{ "opacity-70": !!item.archived }}
                    >
                      {item.title}
                    </span>
                    <Show when={item.description}>
                      <span
                        class="text-14-regular text-text-weak truncate"
                        classList={{ "opacity-70": !!item.archived }}
                      >
                        {item.description}
                      </span>
                    </Show>
                  </div>
                </div>
                <Show when={item.updated}>
                  <span class="text-12-regular text-text-weak whitespace-nowrap ml-2">
                    {getRelativeTime(new Date(item.updated!).toISOString(), language.t)}
                  </span>
                </Show>
              </div>
            </Match>
          </Switch>
        )}
      </List>
    </Dialog>
  )
}
