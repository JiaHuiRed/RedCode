import { batch, createEffect, createMemo, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { createSimpleContext } from "@redcode-ai/ui/context"
import { showToast } from "@redcode-ai/ui/toast"
import { useParams } from "@solidjs/router"
import { getFilename } from "@redcode-ai/core/util/path"
import { useSDK } from "./sdk"
import { useSync } from "./sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { canonicalizeTreePath, createPathHelpers, isWindowsRoot } from "./file/path"
import {
  approxBytes,
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  hasFileContent,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
} from "./file/content-cache"
import { createFileViewCache } from "./file/view-cache"
import { createFileTreeStore } from "./file/tree-store"
import { invalidateFromWatcher } from "./file/watcher"
import { putWorkspaceSnapshot, takeWorkspaceSnapshot } from "./file/workspace-cache"
import {
  selectionFromLines,
  type FileState,
  type FileSelection,
  type FileViewState,
  type SelectedLineRange,
} from "./file/types"

export type { FileSelection, SelectedLineRange, FileViewState, FileState }
export { selectionFromLines }
export {
  evictContentLru,
  getFileContentBytesTotal,
  getFileContentEntryCount,
  removeFileContentBytes,
  resetFileContentLru,
  setFileContentBytes,
  touchFileContent,
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return fallback
}

export const { use: useFile, provider: FileProvider } = createSimpleContext({
  name: "File",
  gate: false,
  init: () => {
    const sdk = useSDK()
    useSync()
    const params = useParams()
    const language = useLanguage()
    const layout = useLayout()

    const scope = createMemo(() => sdk.directory)
    const path = createPathHelpers(scope)
    // 261106 Red 自审计 P2-02：归一与否跟工作区根形态走（POSIX 文件名允许字面反斜杠）
    const windows = createMemo(() => isWindowsRoot(scope()))
    // 261110 Red provider 存活期内 params 恒定（dir 变化触发 keyed 重建），固化
    // tabs key 供 onCleanup 取「本 provider 的」打开文件列表——cleanup 时 params
    // 已被路由更新为新值，不能响应式地读
    const frozenTabsKey = `${params.dir}${params.id ? "/" + params.id : ""}`
    const tabs = layout.tabs(() => frozenTabsKey)

    const inflight = new Map<string, Promise<void>>()
    const [store, setStore] = createStore<{
      file: Record<string, FileState>
    }>({
      file: {},
    })

    const tree = createFileTreeStore({
      scope,
      // 261106 Red 审计：树键族统一规范形（见 canonicalizeTreePath），否则 Windows
      // 原生反斜杠节点与 git 侧 / 形的 filter/kinds/active 整族比对失配
      normalizeDir: (input) => canonicalizeTreePath(path.normalizeDir(input), windows()),
      list: (dir) =>
        sdk.client.file.list({ path: dir }).then((x) =>
          (x.data ?? []).map((node) => ({
            ...node,
            path: canonicalizeTreePath(node.path, windows()),
          })),
        ),
      onError: (message) => {
        showToast({
          variant: "error",
          title: language.t("toast.file.listFailed.title"),
          description: message,
        })
      },
    })

    const evictContent = (keep?: Set<string>) => {
      evictContentLru(keep, (target) => {
        if (!store.file[target]) return
        setStore(
          "file",
          target,
          produce((draft) => {
            draft.content = undefined
            draft.loaded = false
          }),
        )
      })
    }

    // 261110 Red 外部审计第 2 项：scope 切换由 keyed Show 销毁重建整个 provider
    // （directory-layout.tsx），旧的全量清理 effect 实为死代码——provider 生命周期
    // 等于 scope 生命周期，现场保留改由 workspace-cache 在 onCleanup/onInit 完成，
    // 内容记账则由全局 LRU 总预算接管（不再每切一次工作区就整账清零）。

    // 恢复现场：上一个 FileProvider 离开本工作区时存档了打开文件的内容与文件树
    // 状态。恢复即校验——切换期间 watcher 收不到事件，打开的文件与展开目录强制
    // 重读，旧内容只作为阅读现场先行渲染。在 load 定义之后调用（见下方 init 尾部）。
    let restored: ReturnType<typeof takeWorkspaceSnapshot> | undefined
    const restoreWorkspace = (snapshot: NonNullable<ReturnType<typeof takeWorkspaceSnapshot>>) => {
      batch(() => {
        setStore("file", reconcile(snapshot.files))
        tree.restore(snapshot.tree)
      })
      for (const [file, state] of Object.entries(snapshot.files)) {
        if (state.content) touchFileContent(file, approxBytes(state.content))
      }
      for (const file of Object.keys(snapshot.files)) void load(file, { force: true })
      for (const [dir, state] of Object.entries(snapshot.tree.dir)) {
        if (state.loaded && state.expanded) void tree.listDir(dir, { force: true })
      }
      if (!snapshot.tree.dir[""]?.loaded) void tree.listDir("", { force: true })
    }
    restored = takeWorkspaceSnapshot(scope())

    // 收档：只保留「打开中的文件」的内容条目与文件树状态；未打开文件的缓存随
    // provider 销毁——恢复后它们的 loaded 不成立，不能被当作最新内容直读。
    const archive = () => {
      const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024
      const openPaths = new Set<string>(
        tabs.all().flatMap((tab) => {
          const file = path.pathFromTab(tab)
          return file ? [file] : []
        }),
      )
      const files: Record<string, FileState> = {}
      let bytes = 0
      for (const file of openPaths) {
        const state = store.file[file]
        if (!state) continue
        if (!state.content) continue
        const size = approxBytes(state.content)
        if (bytes + size > MAX_SNAPSHOT_BYTES) {
          files[file] = { ...state, content: undefined, loaded: false }
          continue
        }
        bytes += size
        files[file] = state
      }
      putWorkspaceSnapshot(scope(), { files, tree: tree.snapshot() })
    }

    const viewCache = createFileViewCache()
    const view = createMemo(() => viewCache.load(scope(), params.id))

    const ensure = (file: string) => {
      if (!file) return
      if (store.file[file]) return
      setStore("file", file, { path: file, name: getFilename(file) })
    }

    const setLoading = (file: string) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loading = true
          draft.error = undefined
        }),
      )
    }

    const setLoaded = (file: string, content: FileState["content"]) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loaded = true
          draft.loading = false
          draft.content = content
        }),
      )
    }

    const setLoadError = (file: string, message: string) => {
      setStore(
        "file",
        file,
        produce((draft) => {
          draft.loading = false
          draft.error = message
        }),
      )
      showToast({
        variant: "error",
        title: language.t("toast.file.loadFailed.title"),
        description: message,
      })
    }

    const load = (input: string, options?: { force?: boolean }) => {
      const file = path.normalize(input)
      if (!file) return Promise.resolve()

      const directory = scope()
      const key = `${directory}\n${file}`
      ensure(file)

      const current = store.file[file]
      if (!options?.force && current?.loaded) return Promise.resolve()

      const pending = inflight.get(key)
      if (pending) return pending

      setLoading(file)

      const promise = sdk.client.file
        .read({ path: file })
        .then((x) => {
          if (scope() !== directory) return
          const content = x.data
          setLoaded(file, content)

          if (!content) return
          touchFileContent(file, approxBytes(content))
          evictContent(new Set([file]))
        })
        .catch((e) => {
          if (scope() !== directory) return
          setLoadError(file, errorMessage(e, language.t("error.chain.unknown")))
        })
        .finally(() => {
          inflight.delete(key)
        })

      inflight.set(key, promise)
      return promise
    }

    const search = (query: string, dirs: "true" | "false") =>
      sdk.client.find.files({ query, dirs }).then(
        (x) => (x.data ?? []).map(path.normalize),
        () => [],
      )

    const stop = sdk.event.listen((e) => {
      invalidateFromWatcher(e.details, {
        normalize: path.normalize,
        windows: windows(),
        hasFile: (file) => Boolean(store.file[file]),
        isOpen: (file) => tabs.all().some((tab) => path.pathFromTab(tab) === file),
        loadFile: (file) => {
          void load(file, { force: true })
        },
        node: tree.node,
        isDirLoaded: tree.isLoaded,
        refreshDir: (dir) => {
          void tree.listDir(dir, { force: true })
        },
      })
    })

    const get = (input: string) => {
      const file = path.normalize(input)
      const state = store.file[file]
      const content = state?.content
      if (!content) return state
      if (hasFileContent(file)) {
        touchFileContent(file)
        return state
      }
      touchFileContent(file, approxBytes(content))
      return state
    }

    function withPath(input: string, action: (file: string) => unknown) {
      return action(path.normalize(input))
    }
    const scrollTop = (input: string) => withPath(input, (file) => view().scrollTop(file))
    const scrollLeft = (input: string) => withPath(input, (file) => view().scrollLeft(file))
    const selectedLines = (input: string) => withPath(input, (file) => view().selectedLines(file))
    const setScrollTop = (input: string, top: number) => withPath(input, (file) => view().setScrollTop(file, top))
    const setScrollLeft = (input: string, left: number) => withPath(input, (file) => view().setScrollLeft(file, left))
    const setSelectedLines = (input: string, range: SelectedLineRange | null) =>
      withPath(input, (file) => view().setSelectedLines(file, range))

    if (restored) restoreWorkspace(restored)

    onCleanup(() => {
      stop()
      viewCache.clear()
      archive()
    })

    return {
      ready: () => view().ready(),
      normalize: path.normalize,
      tab: path.tab,
      pathFromTab: path.pathFromTab,
      tree: {
        list: tree.listDir,
        refresh: (input: string) => tree.listDir(input, { force: true }),
        state: tree.dirState,
        children: tree.children,
        expand: tree.expandDir,
        collapse: tree.collapseDir,
        toggle(input: string) {
          if (tree.dirState(input)?.expanded) {
            tree.collapseDir(input)
            return
          }
          tree.expandDir(input)
        },
      },
      get,
      load,
      scrollTop,
      scrollLeft,
      setScrollTop,
      setScrollLeft,
      selectedLines,
      setSelectedLines,
      searchFiles: (query: string) => search(query, "false"),
      searchFilesAndDirectories: (query: string) => search(query, "true"),
    }
  },
})
