import type { Project, UserMessage } from "@redcode-ai/sdk/v2"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { createQuery, skipToken, useMutation, useQueryClient } from "@tanstack/solid-query"
import {
  batch,
  onCleanup,
  Show,
  Match,
  Switch,
  createMemo,
  createEffect,
  createComputed,
  on,
  onMount,
  untrack,
  createResource,
} from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createMediaQuery } from "@solid-primitives/media"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { debounce } from "@solid-primitives/scheduled"
import { useLocal } from "@/context/local"
import { selectionFromLines, useFile, type FileSelection, type SelectedLineRange } from "@/context/file"
import { createStore } from "solid-js/store"
import { ResizeHandle } from "@redcode-ai/ui/resize-handle"
import { Select } from "@redcode-ai/ui/select"
import { Tabs } from "@redcode-ai/ui/tabs"
import { createAutoScroll } from "@redcode-ai/ui/hooks"
import { previewSelectedLines } from "@redcode-ai/ui/pierre/selection-bridge"
import { Button } from "@redcode-ai/ui/button"
import { showToast } from "@redcode-ai/ui/toast"
import { base64Encode, checksum } from "@redcode-ai/core/util/encode"
import { useLocation, useNavigate, useSearchParams } from "@solidjs/router"
import { NewSessionDesignView, NewSessionView, SessionHeader } from "@/components/session"
import { useComments } from "@/context/comments"
import { getSessionPrefetch, SESSION_PREFETCH_TTL } from "@/context/global-sync/session-prefetch"
import { setActiveMcpDirectory } from "@/context/global-sync/child-store"
import { decodeDirectory } from "./directory-layout"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { usePrompt } from "@/context/prompt"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { useTerminal } from "@/context/terminal"
import { type FollowupDraft, sendFollowupDraft } from "@/components/prompt-input/submit"
import { createSessionComposerState, SessionComposerRegion } from "@/pages/session/composer"
import {
  createOpenReviewFile,
  createSessionTabs,
  createSizing,
} from "@/pages/session/helpers"
import { createSessionKeyboard } from "@/pages/session/session-keyboard"
import { MessageTimeline } from "@/pages/session/message-timeline"
import { type DiffStyle, SessionReviewTab, type SessionReviewTabProps } from "@/pages/session/review-tab"
import { useSessionLayout } from "@/pages/session/session-layout"
import { syncSessionModel } from "@/pages/session/session-model-helpers"
import { SessionSidePanel } from "@/pages/session/session-side-panel"
import { FileTreePanel } from "@/pages/session/file-tree-panel"
import { TerminalPanel } from "@/pages/session/terminal-panel"
import { useSessionCommands } from "@/pages/session/use-session-commands"
import { useSessionHashScroll } from "@/pages/session/use-session-hash-scroll"
import { createSessionHistoryLoader } from "@/pages/session/session-history-loader"
import { createReviewDiffHelpers } from "@/pages/session/session-review-diff"
import { createMessageNav } from "@/pages/session/session-message-nav"
import { Identifier } from "@/utils/id"
import { diffs as list } from "@/utils/diffs"
import { Persist, persisted } from "@/utils/persist"
import { extractPromptFromParts } from "@/utils/prompt"
import { same } from "@/utils/same"
import { formatServerError } from "@/utils/server-errors"
import { useUsageExceededDialogs } from "./session/usage-exceeded-dialogs"

const emptyUserMessages: UserMessage[] = []
type FollowupItem = FollowupDraft & { id: string }
type FollowupEdit = Pick<FollowupItem, "id" | "prompt" | "context">
const emptyFollowups: FollowupItem[] = []

type ChangeMode = "git" | "branch" | "turn"
type VcsMode = "git" | "branch"
const USE_NEW_SESSION_DESIGN = true

export default function Page() {
  const globalSync = useServerSync()
  const layout = useLayout()
  const local = useLocal()
  const file = useFile()
  const sync = useSync()
  const queryClient = useQueryClient()
  const dialog = useDialog()
  const language = useLanguage()
  const sdk = useSDK()
  const settings = useSettings()
  const prompt = usePrompt()
  const comments = useComments()
  const terminal = useTerminal()
  const [searchParams, setSearchParams] = useSearchParams<{ prompt?: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const { params, sessionKey, tabs, view } = useSessionLayout()

  createEffect(() => {
    if (!prompt.ready()) return
    untrack(() => {
      if (params.id) return
      const text = searchParams.prompt
      if (!text) return
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }], text.length)
      setSearchParams({ ...searchParams, prompt: undefined })
    })
  })

  const [ui, setUi] = createStore({
    pendingMessage: undefined as string | undefined,
    reviewSnap: false,
    scrollGesture: 0,
    scroll: {
      overflow: false,
      bottom: true,
      jump: false,
    },
  })

  const composer = createSessionComposerState()

  const autoScroll = createAutoScroll({
    working: () => true,
    overflowAnchor: "dynamic",
  })

  let resumeScroll = () => {}

  const workspaceKey = createMemo(() => params.dir ?? "")
  const workspaceTabs = createMemo(() => layout.tabs(workspaceKey))

  // 260608 Red 进入项目才连该实例 MCP（首页列项目阶段不连，避免 N×M 并发 spawn 风暴/黑窗）
  // 260609 Red params.dir 是 base64 编码，必须 decodeDirectory 还原真实路径再 set——
  //   否则 child-store 的 directoryKey(activeMcpDirectory()) 拿编码串算 key，永不等于真实目录 key，
  //   MCP query 恒 enabled:false → 对话页"未配置 MCPs"（titlebar 那条用解码后的 tab.dir 才对）。
  createEffect(
    on(
      () => params.dir,
      (dir) => {
        if (!dir) return
        const decoded = decodeDirectory(dir)
        if (decoded) setActiveMcpDirectory(decoded)
      },
    ),
  )

  createEffect(
    on(
      () => params.id,
      (id, prev) => {
        if (!id) return
        if (prev) return

        const pending = layout.handoff.tabs()
        if (!pending) return
        if (Date.now() - pending.at > 60_000) {
          layout.handoff.clearTabs()
          return
        }

        if (pending.id !== id) return
        layout.handoff.clearTabs()
        if (pending.dir !== (params.dir ?? "")) return

        const from = workspaceTabs().tabs()
        if (from.all.length === 0 && !from.active) return

        const current = tabs().tabs()
        if (current.all.length > 0 || current.active) return

        const all = normalizeTabs(from.all)
        const active = from.active ? normalizeTab(from.active) : undefined
        tabs().setAll(all)
        tabs().setActive(active && all.includes(active) ? active : all[0])

        workspaceTabs().setAll([])
        workspaceTabs().setActive(undefined)
      },
      { defer: true },
    ),
  )

  const isDesktop = createMediaQuery("(min-width: 768px)")
  const size = createSizing()
  const isV2NewSessionPage = () => !params.id
  const desktopReviewOpen = createMemo(() => isDesktop() && view().reviewPanel.opened() && !isV2NewSessionPage())
  const desktopFileTreeOpen = createMemo(() => isDesktop() && layout.fileTree.opened() && !isV2NewSessionPage())
  const sessionPanelWidth = createMemo(() => {
    if (desktopReviewOpen() && desktopFileTreeOpen()) {
      return `calc(100% - ${layout.fileTree.width()}px - ${layout.session.width()}px)`
    }
    if (desktopReviewOpen()) return `calc(100% - ${layout.session.width()}px)`
    if (desktopFileTreeOpen()) return `calc(100% - ${layout.fileTree.width()}px)`
    return "100%"
  })
  const centered = createMemo(() => isDesktop() && !desktopReviewOpen() && !desktopFileTreeOpen())

  function normalizeTab(tab: string) {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  function normalizeTabs(list: string[]) {
    const seen = new Set<string>()
    const next: string[] = []
    for (const item of list) {
      const value = normalizeTab(item)
      if (seen.has(value)) continue
      seen.add(value)
      next.push(value)
    }
    return next
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
  }

  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const isChildSession = createMemo(() => !!info()?.parentID)
  const diffs = createMemo(() => (params.id ? list(sync.data.session_diff[params.id]) : []))
  const canReview = createMemo(() => !!sync.project)
  const reviewTab = createMemo(() => isDesktop())
  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview: canReview,
  })
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab
  const revertMessageID = createMemo(() => info()?.revert?.messageID)
  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []))
  const messagesReady = createMemo(() => {
    const id = params.id
    if (!id) return true
    return sync.data.message[id] !== undefined
  })
  const historyMore = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.more(id)
  })
  const historyLoading = createMemo(() => {
    const id = params.id
    if (!id) return false
    return sync.session.history.loading(id)
  })
  const userMessages = createMemo(
    () => messages().filter((m) => m.role === "user") as UserMessage[],
    emptyUserMessages,
    { equals: same },
  )
  const visibleUserMessages = createMemo(
    () => {
      const revert = revertMessageID()
      if (!revert) return userMessages()
      return userMessages().filter((m) => m.id < revert)
    },
    emptyUserMessages,
    {
      equals: same,
    },
  )
  const lastUserMessage = createMemo(() => visibleUserMessages().at(-1))

  createEffect(() => {
    const tab = activeFileTab()
    if (!tab) return

    const path = file.pathFromTab(tab)
    if (path) void file.load(path)
  })

  createEffect(
    on(
      () => lastUserMessage()?.id,
      () => {
        const msg = lastUserMessage()
        if (!msg) return
        syncSessionModel(local, msg)
      },
    ),
  )

  createEffect(
    on(
      () => ({ dir: params.dir, id: params.id }),
      (next, prev) => {
        if (!prev) return
        if (next.dir === prev.dir && next.id === prev.id) return
        if (prev.id && !next.id) local.session.reset()
      },
      { defer: true },
    ),
  )

  const [store, setStore] = createStore({
    messageId: undefined as string | undefined,
    mobileTab: "session" as "session" | "changes",
    changes: "git" as ChangeMode,
    newSessionWorktree: "main",
    deferRender: false,
  })

  const [followup, setFollowup] = persisted(
    Persist.workspace(sdk.directory, "followup", ["followup.v1"]),
    createStore<{
      items: Record<string, FollowupItem[] | undefined>
      failed: Record<string, string | undefined>
      paused: Record<string, boolean | undefined>
      edit: Record<string, FollowupEdit | undefined>
    }>({
      items: {},
      failed: {},
      paused: {},
      edit: {},
    }),
  )

  createComputed((prev) => {
    const key = sessionKey()
    if (key !== prev) {
      setStore("deferRender", true)
      requestAnimationFrame(() => {
        setTimeout(() => setStore("deferRender", false), 0)
      })
    }
    return key
  }, sessionKey())

  let reviewFrame: number | undefined
  let refreshFrame: number | undefined
  let refreshTimer: number | undefined
  let todoFrame: number | undefined
  let todoTimer: number | undefined
  let diffFrame: number | undefined
  let diffTimer: number | undefined

  createComputed((prev) => {
    const open = desktopReviewOpen()
    if (prev === undefined || prev === open) return open

    if (reviewFrame !== undefined) cancelAnimationFrame(reviewFrame)
    setUi("reviewSnap", true)
    reviewFrame = requestAnimationFrame(() => {
      reviewFrame = undefined
      setUi("reviewSnap", false)
    })
    return open
  }, desktopReviewOpen())

  const turnDiffs = createMemo(() => list(lastUserMessage()?.summary?.diffs))
  const nogit = createMemo(() => !!sync.project && sync.project.vcs !== "git")
  const changesOptions = createMemo<ChangeMode[]>(() => {
    const list: ChangeMode[] = []
    if (sync.project?.vcs === "git") list.push("git")
    if (
      sync.project?.vcs === "git" &&
      sync.data.vcs?.branch &&
      sync.data.vcs?.default_branch &&
      sync.data.vcs.branch !== sync.data.vcs.default_branch
    ) {
      list.push("branch")
    }
    list.push("turn")
    return list
  })
  const mobileChanges = createMemo(() => !isDesktop() && store.mobileTab === "changes")
  const wantsReview = createMemo(() =>
    isDesktop()
      ? desktopFileTreeOpen() || (desktopReviewOpen() && activeTab() === "review")
      : store.mobileTab === "changes",
  )
  const vcsMode = createMemo<VcsMode | undefined>(() => {
    if (store.changes === "git" || store.changes === "branch") return store.changes
  })
  const vcsKey = createMemo(
    () => ["session-vcs", sdk.directory, sync.data.vcs?.branch ?? "", sync.data.vcs?.default_branch ?? ""] as const,
  )
  const vcsQuery = createQuery(() => {
    const mode = vcsMode()
    const enabled = wantsReview() && sync.project?.vcs === "git"

    return {
      queryKey: [...vcsKey(), mode] as const,
      enabled,
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: 60 * 1000,
      queryFn: mode
        ? () =>
            sdk.client.vcs
              .diff({ mode })
              .then((result) => list(result.data))
              .catch((error) => {
                console.debug("[session-review] failed to load vcs diff", { mode, error })
                return []
              })
        : skipToken,
    }
  })
  const refreshVcs = debounce(() => void queryClient.invalidateQueries({ queryKey: vcsKey() }), 100)
  const reviewDiffs = () => {
    if (store.changes === "git" || store.changes === "branch")
      // avoids suspense
      return vcsQuery.isFetched ? (vcsQuery.data ?? []) : []
    return turnDiffs()
  }
  const reviewCount = () => reviewDiffs().length
  const hasReview = () => reviewCount() > 0
  const reviewReady = () => {
    if (store.changes === "git" || store.changes === "branch") return !vcsQuery.isPending
    return true
  }

  const newSessionWorktree = createMemo(() => {
    if (store.newSessionWorktree === "create") return "create"
    const project = sync.project
    if (project && sdk.directory !== project.worktree) return sdk.directory
    return "main"
  })

  const nav = createMessageNav({
    visibleUserMessages,
    scroller: () => scroller,
    autoScroll,
    resumeScroll: () => resumeScroll(),
    setStoreMessageId: (id) => setStore("messageId", id),
  })

  function upsert(next: Project) {
    const list = globalSync.data.project
    sync.set("project", next.id)
    const idx = list.findIndex((item) => item.id === next.id)
    if (idx >= 0) {
      globalSync.set(
        "project",
        list.map((item, i) => (i === idx ? { ...item, ...next } : item)),
      )
      return
    }
    const at = list.findIndex((item) => item.id > next.id)
    if (at >= 0) {
      globalSync.set("project", [...list.slice(0, at), next, ...list.slice(at)])
      return
    }
    globalSync.set("project", [...list, next])
  }

  const gitMutation = useMutation(() => ({
    mutationFn: () => sdk.client.project.initGit(),
    onSuccess: (x) => {
      if (!x.data) return
      upsert(x.data)
    },
    onError: (err) => {
      showToast({
        variant: "error",
        title: language.t("common.requestFailed"),
        description: formatServerError(err, language.t),
      })
    },
  }))

  function initGit() {
    if (gitMutation.isPending) return
    gitMutation.mutate()
  }

  let inputRef!: HTMLDivElement
  let promptDock: HTMLDivElement | undefined
  let dockHeight = 0
  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let revealMessage = (_id: string) => {}
  const scrollGestureWindowMs = 250

  const markScrollGesture = (target?: EventTarget | null) => {
    const root = scroller
    if (!root) return

    const el = target instanceof Element ? target : undefined
    const nested = el?.closest("[data-scrollable]")
    if (nested && nested !== root) return

    setUi("scrollGesture", Date.now())
  }

  const hasScrollGesture = () => Date.now() - ui.scrollGesture < scrollGestureWindowMs

  const [sessionSync] = createResource(
    () => [sdk.directory, params.id] as const,
    ([directory, id]) => {
      if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame)
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
      refreshFrame = undefined
      refreshTimer = undefined
      if (!id) return

      const cached = untrack(() => sync.data.message[id] !== undefined)
      const stale = !cached
        ? false
        : (() => {
            const info = getSessionPrefetch(directory, id)
            if (!info) return true
            return Date.now() - info.at > SESSION_PREFETCH_TTL
          })()

      refreshFrame = requestAnimationFrame(() => {
        refreshFrame = undefined
        refreshTimer = window.setTimeout(() => {
          refreshTimer = undefined
          if (params.id !== id) return
          untrack(() => {
            if (stale) void sync.session.sync(id, { force: true })
          })
        }, 0)
      })

      return sync.session.sync(id)
    },
  )

  createEffect(
    on(
      () => {
        const id = params.id
        return [
          sdk.directory,
          id,
          id ? (sync.data.session_status[id]?.type ?? "idle") : "idle",
          id ? composer.blocked() : false,
        ] as const
      },
      ([dir, id, status, blocked]) => {
        if (todoFrame !== undefined) cancelAnimationFrame(todoFrame)
        if (todoTimer !== undefined) window.clearTimeout(todoTimer)
        todoFrame = undefined
        todoTimer = undefined
        if (!id) return
        if (status === "idle" && !blocked) return
        const cached = untrack(() => sync.data.todo[id] !== undefined || globalSync.data.session_todo[id] !== undefined)

        todoFrame = requestAnimationFrame(() => {
          todoFrame = undefined
          todoTimer = window.setTimeout(() => {
            todoTimer = undefined
            if (sdk.directory !== dir || params.id !== id) return
            untrack(() => {
              void sync.session.todo(id, cached ? { force: true } : undefined)
            })
          }, 0)
        })
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => visibleUserMessages().at(-1)?.id,
      (lastId, prevLastId) => {
        if (lastId && prevLastId && lastId > prevLastId) {
          setStore("messageId", undefined)
        }
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      sessionKey,
      () => {
        setStore("messageId", undefined)
        setStore("changes", "git")
        setUi("pendingMessage", undefined)
      },
      { defer: true },
    ),
  )

  const stopVcs = sdk.event.listen((evt) => {
    if (evt.details.type !== "file.watcher.updated") return
    const props =
      typeof evt.details.properties === "object" && evt.details.properties
        ? (evt.details.properties as Record<string, unknown>)
        : undefined
    const file = typeof props?.file === "string" ? props.file : undefined
    if (!file || file.startsWith(".git/")) return
    refreshVcs()
  })
  onCleanup(stopVcs)

  createEffect(
    on(
      () => params.dir,
      (dir) => {
        if (!dir) return
        setStore("newSessionWorktree", "main")
      },
      { defer: true },
    ),
  )

  const selectionPreview = (path: string, selection: FileSelection) => {
    const content = file.get(path)?.content?.content
    if (!content) return undefined
    return previewSelectedLines(content, { start: selection.startLine, end: selection.endLine })
  }

  const addCommentToContext = (input: {
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
    origin?: "review" | "file"
  }) => {
    const selection = selectionFromLines(input.selection)
    const preview = input.preview ?? selectionPreview(input.file, selection)
    const saved = comments.add({
      file: input.file,
      selection: input.selection,
      comment: input.comment,
    })
    prompt.context.add({
      type: "file",
      path: input.file,
      selection,
      comment: input.comment,
      commentID: saved.id,
      commentOrigin: input.origin,
      preview,
    })
  }

  const updateCommentInContext = (input: {
    id: string
    file: string
    selection: SelectedLineRange
    comment: string
    preview?: string
  }) => {
    comments.update(input.file, input.id, input.comment)
    prompt.context.updateComment(input.file, input.id, {
      comment: input.comment,
      ...(input.preview ? { preview: input.preview } : {}),
    })
  }

  const removeCommentFromContext = (input: { id: string; file: string }) => {
    comments.remove(input.file, input.id)
    prompt.context.removeComment(input.file, input.id)
  }

  const reviewCommentActions = createMemo(() => ({
    moreLabel: language.t("common.moreOptions"),
    editLabel: language.t("common.edit"),
    deleteLabel: language.t("common.delete"),
    saveLabel: language.t("common.save"),
  }))

  const { handleKeyDown } = createSessionKeyboard({
    isDialogActive: () => !!dialog.active,
    inputRef,
    getViewTerminalOpened: () => view().terminal.opened(),
    terminal,
    composer,
    isChildSession,
    onMarkScrollGesture: markScrollGesture,
  })

  createEffect(() => {
    const list = changesOptions()
    if (list.includes(store.changes)) return
    const next = list[0]
    if (!next) return
    setStore("changes", next)
  })

  createEffect(
    on(
      () => sync.data.session_status[params.id ?? ""]?.type,
      (next, prev) => {
        if (next !== "idle" || prev === undefined || prev === "idle") return
        refreshVcs()
      },
      { defer: true },
    ),
  )

  const fileTreeTab = () => layout.fileTree.tab()
  const setFileTreeTab = (value: "changes" | "all") => layout.fileTree.setTab(value)

  const [tree, setTree] = createStore({
    reviewScroll: undefined as HTMLDivElement | undefined,
    pendingDiff: undefined as string | undefined,
    activeDiff: undefined as string | undefined,
  })

  createEffect(
    on(
      sessionKey,
      () => {
        setTree({
          reviewScroll: undefined,
          pendingDiff: undefined,
          activeDiff: undefined,
        })
      },
      { defer: true },
    ),
  )

  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    setFileTreeTab("all")
  }

  const focusInput = () => {
    if (isChildSession()) return
    inputRef?.focus()
  }

  useSessionCommands({
    navigateMessageByOffset: (offset) => nav.navigateMessageByOffset(offset, store.messageId),
    setActiveMessage: nav.setActiveMessage,
    focusInput,
    review: reviewTab,
  })

  const openReviewFile = createOpenReviewFile({
    showAllFiles,
    tabForPath: file.tab,
    openTab: tabs().open,
    setActive: tabs().setActive,
    loadFile: file.load,
  })

  const changesTitle = () => {
    if (!canReview()) {
      return null
    }

    const label = (option: ChangeMode) => {
      if (option === "git") return language.t("ui.sessionReview.title.git")
      if (option === "branch") return language.t("ui.sessionReview.title.branch")
      return language.t("ui.sessionReview.title.lastTurn")
    }

    return (
      <Select
        options={changesOptions()}
        current={store.changes}
        label={label}
        onSelect={(option) => option && setStore("changes", option)}
        variant="ghost"
        size="small"
        valueClass="text-14-medium"
      />
    )
  }

  const empty = (text: string) => (
    <div class="h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6">
      <div class="text-14-regular text-text-weak max-w-56">{text}</div>
    </div>
  )

  const createGit = (input: { emptyClass: string }) => (
    <div class={input.emptyClass}>
      <div class="flex flex-col gap-3">
        <div class="text-14-medium text-text-strong">{language.t("session.review.noVcs.createGit.title")}</div>
        <div class="text-14-regular text-text-base max-w-md" style={{ "line-height": "var(--line-height-normal)" }}>
          {language.t("session.review.noVcs.createGit.description")}
        </div>
      </div>
      <Button size="large" disabled={gitMutation.isPending} onClick={initGit}>
        {gitMutation.isPending
          ? language.t("session.review.noVcs.createGit.actionLoading")
          : language.t("session.review.noVcs.createGit.action")}
      </Button>
    </div>
  )

  const reviewEmptyText = createMemo(() => {
    if (store.changes === "git") return language.t("session.review.noUncommittedChanges")
    if (store.changes === "branch") return language.t("session.review.noBranchChanges")
    return language.t("session.review.noChanges")
  })

  const reviewEmpty = (input: { loadingClass: string; emptyClass: string }) => {
    if (store.changes === "git" || store.changes === "branch") {
      if (!reviewReady()) return <div class={input.loadingClass}>{language.t("session.review.loadingChanges")}</div>
      return empty(reviewEmptyText())
    }

    if (store.changes === "turn") {
      if (nogit()) return createGit(input)
      return empty(reviewEmptyText())
    }

    return (
      <div class={input.emptyClass}>
        <div class="text-14-regular text-text-weak max-w-56">{reviewEmptyText()}</div>
      </div>
    )
  }

  const reviewContent = (input: {
    diffStyle: DiffStyle
    onDiffStyleChange?: (style: DiffStyle) => void
    classes?: SessionReviewTabProps["classes"]
    loadingClass: string
    emptyClass: string
  }) => (
    <Show when={!store.deferRender}>
      <SessionReviewTab
        title={changesTitle()}
        empty={reviewEmpty(input)}
        diffs={reviewDiffs}
        view={view}
        diffStyle={input.diffStyle}
        onDiffStyleChange={input.onDiffStyleChange}
        onScrollRef={(el) => setTree("reviewScroll", el)}
        focusedFile={tree.activeDiff}
        onLineComment={(comment) => addCommentToContext({ ...comment, origin: "review" })}
        onLineCommentUpdate={updateCommentInContext}
        onLineCommentDelete={removeCommentFromContext}
        lineCommentActions={reviewCommentActions()}
        commentMentions={{
          items: file.searchFilesAndDirectories,
        }}
        comments={comments.all()}
        focusedComment={comments.focus()}
        onFocusedCommentChange={comments.setFocus}
        onViewFile={openReviewFile}
        classes={input.classes}
      />
    </Show>
  )

  const reviewPanel = () => (
    <div class="flex flex-col h-full overflow-hidden bg-background-stronger contain-strict">
      <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
        {reviewContent({
          diffStyle: layout.review.diffStyle(),
          onDiffStyleChange: layout.review.setDiffStyle,
          loadingClass: "px-6 py-4 text-text-weak",
          emptyClass: "h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6",
        })}
      </div>
    </div>
  )

  createEffect(
    on(
      activeFileTab,
      (active) => {
        if (!active) return
        if (fileTreeTab() !== "changes") return
        showAllFiles()
      },
      { defer: true },
    ),
  )

  const { reviewDiffId, reviewDiffTop, scrollToReviewDiff, focusReviewDiff } = createReviewDiffHelpers({
    checksum,
    tree,
    setTree,
    view,
    openReviewPanel,
  })

  createEffect(() => {
    const pending = tree.pendingDiff
    if (!pending) return
    if (!tree.reviewScroll) return
    if (!reviewReady()) return

    const attempt = (count: number) => {
      if (tree.pendingDiff !== pending) return
      if (count > 60) {
        setTree("pendingDiff", undefined)
        return
      }

      const root = tree.reviewScroll
      if (!root) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (!scrollToReviewDiff(pending)) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      const top = reviewDiffTop(pending)
      if (top === undefined) {
        requestAnimationFrame(() => attempt(count + 1))
        return
      }

      if (Math.abs(root.scrollTop - top) <= 1) {
        setTree("pendingDiff", undefined)
        return
      }

      requestAnimationFrame(() => attempt(count + 1))
    }

    requestAnimationFrame(() => attempt(0))
  })

  createEffect(() => {
    const id = params.id
    if (!id) return

    if (!wantsReview()) return
    if (sync.data.session_diff[id] !== undefined) return
    if (sync.status === "loading") return

    void sync.session.diff(id)
  })

  createEffect(
    on(
      () => [sessionKey(), wantsReview()] as const,
      ([key, wants]) => {
        if (diffFrame !== undefined) cancelAnimationFrame(diffFrame)
        if (diffTimer !== undefined) window.clearTimeout(diffTimer)
        diffFrame = undefined
        diffTimer = undefined
        if (!wants) return

        const id = params.id
        if (!id) return
        if (!untrack(() => sync.data.session_diff[id] !== undefined)) return

        diffFrame = requestAnimationFrame(() => {
          diffFrame = undefined
          diffTimer = window.setTimeout(() => {
            diffTimer = undefined
            if (sessionKey() !== key) return
            void sync.session.diff(id, { force: true })
          }, 0)
        })
      },
      { defer: true },
    ),
  )

  let treeDir: string | undefined
  createEffect(() => {
    const dir = sdk.directory
    if (!isDesktop()) return
    if (!layout.fileTree.opened()) return
    if (sync.status === "loading") return

    fileTreeTab()
    const refresh = treeDir !== dir
    treeDir = dir
    void (refresh ? file.tree.refresh("") : file.tree.list(""))
  })

  createEffect(
    on(
      () => sdk.directory,
      () => {
        const tab = activeFileTab()
        if (!tab) return
        const path = file.pathFromTab(tab)
        if (!path) return
        void file.load(path, { force: true })
      },
      { defer: true },
    ),
  )

  let scrollStateFrame: number | undefined
  let scrollStateTarget: HTMLDivElement | undefined
  let fillFrame: number | undefined

  const jumpThreshold = (el: HTMLDivElement) => Math.max(400, el.clientHeight)

  const updateScrollState = (el: HTMLDivElement) => {
    const max = el.scrollHeight - el.clientHeight
    const distance = max - el.scrollTop
    const overflow = max > 1
    const bottom = !overflow || distance <= 2
    const jump = overflow && distance > jumpThreshold(el)

    if (ui.scroll.overflow === overflow && ui.scroll.bottom === bottom && ui.scroll.jump === jump) return
    setUi("scroll", { overflow, bottom, jump })
  }

  const scheduleScrollState = (el: HTMLDivElement) => {
    scrollStateTarget = el
    if (scrollStateFrame !== undefined) return

    scrollStateFrame = requestAnimationFrame(() => {
      scrollStateFrame = undefined

      const target = scrollStateTarget
      scrollStateTarget = undefined
      if (!target) return

      updateScrollState(target)
    })
  }

  resumeScroll = () => {
    setStore("messageId", undefined)
    autoScroll.forceScrollToBottom()
    clearMessageHash()

    const el = scroller
    if (el) scheduleScrollState(el)
  }

  // When the user returns to the bottom, treat the active message as "latest".
  createEffect(
    on(
      autoScroll.userScrolled,
      (scrolled) => {
        if (scrolled) return
        setStore("messageId", undefined)
        clearMessageHash()
      },
      { defer: true },
    ),
  )

  let fill = () => {}

  const setScrollRef = (el: HTMLDivElement | undefined) => {
    scroller = el
    autoScroll.scrollRef(el)
    if (!el) return
    scheduleScrollState(el)
    fill()
  }

  const markUserScroll = nav.markScroll

  createResizeObserver(
    () => content,
    () => {
      const el = scroller
      if (el) scheduleScrollState(el)
      fill()
    },
  )

  const historyLoader = createSessionHistoryLoader({
    sessionID: () => params.id,
    loaded: () => messages().length,
    visibleUserMessages,
    historyMore,
    historyLoading,
    loadMore: (sessionID) => sync.session.history.loadMore(sessionID),
    userScrolled: autoScroll.userScrolled,
    scroller: () => scroller,
  })

  fill = () => {
    if (fillFrame !== undefined) return

    fillFrame = requestAnimationFrame(() => {
      fillFrame = undefined

      if (!params.id || !messagesReady()) return
      if (autoScroll.userScrolled() || historyLoading()) return

      const el = scroller
      if (!el) return
      if (el.scrollHeight > el.clientHeight + 1) return
      if (!historyMore()) return

      void historyLoader.loadAndReveal()
    })
  }

  createEffect(
    on(
      () =>
        [
          params.id,
          messagesReady(),
          historyMore(),
          historyLoading(),
          autoScroll.userScrolled(),
          visibleUserMessages().length,
        ] as const,
      ([id, ready, more, loading, scrolled]) => {
        if (!id || !ready || loading || scrolled) return
        if (!more) return
        fill()
      },
      { defer: true },
    ),
  )

  const draft = (id: string) =>
    extractPromptFromParts(sync.data.part[id] ?? [], {
      directory: sdk.directory,
      attachmentName: language.t("common.attachment"),
    })

  const line = (id: string) => {
    const text = draft(id)
      .map((part) => (part.type === "image" ? `[image:${part.filename}]` : part.content))
      .join("")
      .replace(/\s+/g, " ")
      .trim()
    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const fail = (err: unknown) => {
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: formatServerError(err, language.t),
    })
  }

  const merge = (next: NonNullable<ReturnType<typeof info>>) =>
    sync.set("session", (list) => {
      const idx = list.findIndex((item) => item.id === next.id)
      if (idx < 0) return list
      const out = list.slice()
      out[idx] = next
      return out
    })

  const roll = (sessionID: string, next: NonNullable<ReturnType<typeof info>>["revert"]) =>
    sync.set("session", (list) => {
      const idx = list.findIndex((item) => item.id === sessionID)
      if (idx < 0) return list
      const out = list.slice()
      out[idx] = { ...out[idx], revert: next }
      return out
    })

  const busy = (sessionID: string) => sync.data.session_working(sessionID)

  const queuedFollowups = createMemo(() => {
    const id = params.id
    if (!id) return emptyFollowups
    return followup.items[id] ?? emptyFollowups
  })

  const editingFollowup = createMemo(() => {
    const id = params.id
    if (!id) return
    return followup.edit[id]
  })

  const followupMutation = useMutation(() => ({
    mutationFn: async (input: { sessionID: string; id: string; manual?: boolean }) => {
      const item = (followup.items[input.sessionID] ?? []).find((entry) => entry.id === input.id)
      if (!item) return

      if (input.manual) setFollowup("paused", input.sessionID, undefined)
      setFollowup("failed", input.sessionID, undefined)

      const ok = await sendFollowupDraft({
        client: sdk.client,
        sync,
        globalSync,
        draft: item,
        optimisticBusy: item.sessionDirectory === sdk.directory,
      }).catch((err) => {
        setFollowup("failed", input.sessionID, input.id)
        fail(err)
        return false
      })
      if (!ok) return

      setFollowup("items", input.sessionID, (items) => (items ?? []).filter((entry) => entry.id !== input.id))
      if (input.manual) resumeScroll()
    },
  }))

  const followupBusy = (sessionID: string) =>
    followupMutation.isPending && followupMutation.variables?.sessionID === sessionID

  const sendingFollowup = createMemo(() => {
    const id = params.id
    if (!id) return
    if (!followupBusy(id)) return
    return followupMutation.variables?.id
  })

  const queueEnabled = createMemo(() => {
    const id = params.id
    if (!id) return false
    return settings.general.followup() === "queue" && busy(id) && !composer.blocked() && !isChildSession()
  })

  const followupText = (item: FollowupDraft) => {
    const text = item.prompt
      .map((part) => {
        if (part.type === "image") return `[image:${part.filename}]`
        if (part.type === "file") return `[file:${part.path}]`
        if (part.type === "agent") return `@${part.name}`
        return part.content
      })
      .join("")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => !!line)

    if (text) return text
    return `[${language.t("common.attachment")}]`
  }

  const queueFollowup = (draft: FollowupDraft) => {
    setFollowup("items", draft.sessionID, (items) => [
      ...(items ?? []),
      { id: Identifier.ascending("message"), ...draft },
    ])
    setFollowup("failed", draft.sessionID, undefined)
    setFollowup("paused", draft.sessionID, undefined)
  }

  const followupDock = createMemo(() => queuedFollowups().map((item) => ({ id: item.id, text: followupText(item) })))

  const sendFollowup = (sessionID: string, id: string, opts?: { manual?: boolean }) => {
    if (sync.session.get(sessionID)?.parentID) return Promise.resolve()
    const item = (followup.items[sessionID] ?? []).find((entry) => entry.id === id)
    if (!item) return Promise.resolve()
    if (followupBusy(sessionID)) return Promise.resolve()

    return followupMutation.mutateAsync({ sessionID, id, manual: opts?.manual })
  }

  const editFollowup = (id: string) => {
    const sessionID = params.id
    if (!sessionID) return
    if (followupBusy(sessionID)) return

    const item = queuedFollowups().find((entry) => entry.id === id)
    if (!item) return

    setFollowup("items", sessionID, (items) => (items ?? []).filter((entry) => entry.id !== id))
    setFollowup("failed", sessionID, (value) => (value === id ? undefined : value))
    setFollowup("edit", sessionID, {
      id: item.id,
      prompt: item.prompt,
      context: item.context,
    })
  }

  const clearFollowupEdit = () => {
    const id = params.id
    if (!id) return
    setFollowup("edit", id, undefined)
  }

  const halt = (sessionID: string) =>
    busy(sessionID) ? sdk.client.session.abort({ sessionID }).catch(() => {}) : Promise.resolve()

  const revertMutation = useMutation(() => ({
    mutationFn: async (input: { sessionID: string; messageID: string }) => {
      const prev = prompt.current().slice()
      const last = info()?.revert
      const value = draft(input.messageID)
      batch(() => {
        roll(input.sessionID, { messageID: input.messageID })
        prompt.set(value)
      })
      await halt(input.sessionID)
        .then(() => sdk.client.session.revert(input))
        .then((result) => {
          if (result.data) merge(result.data)
        })
        .catch((err) => {
          batch(() => {
            roll(input.sessionID, last)
            prompt.set(prev)
          })
          fail(err)
        })
    },
  }))

  const restoreMutation = useMutation(() => ({
    mutationFn: async (id: string) => {
      const sessionID = params.id
      if (!sessionID) return

      const next = userMessages().find((item) => item.id > id)
      const prev = prompt.current().slice()
      const last = info()?.revert

      batch(() => {
        roll(sessionID, next ? { messageID: next.id } : undefined)
        if (next) {
          prompt.set(draft(next.id))
          return
        }
        prompt.reset()
      })

      const task = !next
        ? halt(sessionID).then(() => sdk.client.session.unrevert({ sessionID }))
        : halt(sessionID).then(() =>
            sdk.client.session.revert({
              sessionID,
              messageID: next.id,
            }),
          )

      await task
        .then((result) => {
          if (result.data) merge(result.data)
        })
        .catch((err) => {
          batch(() => {
            roll(sessionID, last)
            prompt.set(prev)
          })
          fail(err)
        })
    },
  }))

  const reverting = createMemo(() => revertMutation.isPending || restoreMutation.isPending)
  const restoring = createMemo(() => (restoreMutation.isPending ? restoreMutation.variables : undefined))

  const revert = (input: { sessionID: string; messageID: string }) => {
    if (reverting()) return
    return revertMutation.mutateAsync(input)
  }

  const restore = (id: string) => {
    if (!params.id || reverting()) return
    return restoreMutation.mutateAsync(id)
  }

  const rolled = createMemo(() => {
    const id = revertMessageID()
    if (!id) return []
    return userMessages()
      .filter((item) => item.id >= id)
      .map((item) => ({ id: item.id, text: line(item.id) }))
  })

  // 260608 Red 逐条分叉：从指定消息派生新会话并跳转（复用 dialog-fork 的逻辑，省去选择对话框）
  const fork = (input: { sessionID: string; messageID: string }) => {
    const restored = draft(input.messageID)
    const dir = base64Encode(sdk.directory)
    return sdk.client.session
      .fork({ sessionID: input.sessionID, messageID: input.messageID })
      .then((forked) => {
        if (!forked.data) {
          showToast({ title: language.t("common.requestFailed") })
          return
        }
        prompt.set(restored, undefined, { dir, id: forked.data.id })
        navigate(`/${dir}/session/${forked.data.id}`)
      })
      .catch((err: unknown) => {
        fail(err)
      })
  }

  const actions = { revert, fork }

  createEffect(() => {
    const sessionID = params.id
    if (!sessionID) return

    const item = queuedFollowups()[0]
    if (!item) return
    if (followupBusy(sessionID)) return
    if (followup.failed[sessionID] === item.id) return
    if (followup.paused[sessionID]) return
    if (isChildSession()) return
    if (composer.blocked()) return
    if (busy(sessionID)) return

    void sendFollowup(sessionID, item.id)
  })

  createResizeObserver(
    () => promptDock,
    ({ height }) => {
      const next = Math.ceil(height)

      if (next === dockHeight) return

      const el = scroller
      const delta = next - dockHeight
      const stick = el
        ? !autoScroll.userScrolled() || el.scrollHeight - el.clientHeight - el.scrollTop < 10 + Math.max(0, delta)
        : false

      dockHeight = next

      if (stick) autoScroll.forceScrollToBottom()

      if (el) scheduleScrollState(el)
      fill()
    },
  )

  const { clearMessageHash, scrollToMessage } = useSessionHashScroll({
    sessionKey,
    sessionID: () => params.id,
    messagesReady,
    visibleUserMessages,
    historyMore,
    historyLoading,
    loadMore: (sessionID) => sync.session.history.loadMore(sessionID),
    currentMessageId: () => store.messageId,
    pendingMessage: () => ui.pendingMessage,
    setPendingMessage: (value) => setUi("pendingMessage", value),
    setActiveMessage: nav.setActiveMessage,
    autoScroll,
    scroller: () => scroller,
    anchor: nav.anchor,
    revealMessage: (id) => revealMessage(id),
    scheduleScrollState,
    consumePendingMessage: layout.pendingMessage.consume,
  })
  nav.setScrollToMessage(scrollToMessage)

  createEffect(
    on(
      () => params.id,
      (id) => {
        if (!id) requestAnimationFrame(() => inputRef?.focus())
      },
    ),
  )

  onMount(() => {
    makeEventListener(document, "keydown", handleKeyDown)
  })

  onCleanup(() => {
    if (reviewFrame !== undefined) cancelAnimationFrame(reviewFrame)
    if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame)
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
    if (todoFrame !== undefined) cancelAnimationFrame(todoFrame)
    if (todoTimer !== undefined) window.clearTimeout(todoTimer)
    if (diffFrame !== undefined) cancelAnimationFrame(diffFrame)
    if (diffTimer !== undefined) window.clearTimeout(diffTimer)
    if (scrollStateFrame !== undefined) cancelAnimationFrame(scrollStateFrame)
    if (fillFrame !== undefined) cancelAnimationFrame(fillFrame)
  })

  useUsageExceededDialogs()

  const composerRegion = (placement: "dock" | "inline") => (
    <SessionComposerRegion
      state={composer}
      ready={!store.deferRender && messagesReady()}
      centered={placement === "dock" && centered()}
      placement={placement}
      inputRef={(el) => {
        inputRef = el
      }}
      newSessionWorktree={newSessionWorktree()}
      onNewSessionWorktreeChange={(value) => setStore("newSessionWorktree", value)}
      onNewSessionWorktreeReset={() => setStore("newSessionWorktree", "main")}
      onSubmit={() => {
        comments.clear()
        resumeScroll()
      }}
      onResponseSubmit={resumeScroll}
      followup={
        params.id && !isChildSession()
          ? {
              queue: queueEnabled,
              items: followupDock(),
              sending: sendingFollowup(),
              edit: editingFollowup(),
              onQueue: queueFollowup,
              onAbort: () => {
                const id = params.id
                if (!id) return
                setFollowup("paused", id, true)
              },
              onSend: (id) => {
                void sendFollowup(params.id!, id, { manual: true })
              },
              onEdit: editFollowup,
              onEditLoaded: clearFollowupEdit,
            }
          : undefined
      }
      revert={
        rolled().length > 0
          ? {
              items: rolled(),
              restoring: restoring(),
              disabled: reverting(),
              onRestore: restore,
            }
          : undefined
      }
      setPromptDockRef={(el) => {
        promptDock = el
      }}
    />
  )

  return (
    <div
      class="relative size-full overflow-hidden flex flex-col"
      // 260610 Red 毛玻璃 B：设了聊天背景图则会话页根容器去实色底，露出根布局整窗壁纸做毛玻璃；否则维持原实色
      classList={{ "bg-background-base": !settings.appearance.chatBackground() }}
    >
      {sessionSync() ?? ""}
      <SessionHeader />
      <div class="flex-1 min-h-0 flex flex-col md:flex-row">
        <Show when={!isDesktop() && !!params.id}>
          <Tabs value={store.mobileTab} class="h-auto">
            <Tabs.List>
              <Tabs.Trigger
                value="session"
                class="!w-1/2 !max-w-none"
                classes={{ button: "w-full" }}
                onClick={() => setStore("mobileTab", "session")}
              >
                {language.t("session.tab.session")}
              </Tabs.Trigger>
              <Tabs.Trigger
                value="changes"
                class="!w-1/2 !max-w-none !border-r-0"
                classes={{ button: "w-full" }}
                onClick={() => setStore("mobileTab", "changes")}
              >
                {hasReview()
                  ? language.t("session.review.filesChanged", { count: reviewCount() })
                  : language.t("session.review.change.other")}
              </Tabs.Trigger>
            </Tabs.List>
          </Tabs>
        </Show>

        <FileTreePanel
          diffsReady={reviewReady}
          diffs={reviewDiffs}
          reviewCount={reviewCount}
          hasReview={hasReview}
          activeDiff={tree.activeDiff}
          focusReviewDiff={focusReviewDiff}
          size={size}
        />
        <div
          classList={{
            "@container relative shrink-0 flex flex-col min-h-0 h-full flex-1 md:flex-none": true,
            // 260610 Red 毛玻璃 B：设了背景图则聊天栏去实色底，露出主卡片整窗毛玻璃；无背景图维持原实色
            "bg-background-stronger": !settings.appearance.chatBackground(),
            "duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
              !size.active() && !ui.reviewSnap,
            "transition-[width]": !isV2NewSessionPage(),
          }}
          style={{
            width: sessionPanelWidth(),
          }}
          // 260608 Red 毛玻璃 A 触发钩子：设了聊天背景图才打标记，CSS 据此让气泡/输入框半透明模糊透出背景图
          data-chat-frost={settings.appearance.chatBackground() ? "" : undefined}
        >
          {/* 260610 Red 背景图已上移到根布局整窗铺底（layout.tsx），此处仅保留遮罩压暗保证对话可读 */}
          <Show when={settings.appearance.chatBackground()}>
            {/* 260608 Yuqi 半透明遮罩：压低壁纸亮度确保文字可读，同时过渡到两侧面板的实色背景 */}
            {/* 260609 Yuqi 0.4→0.62：哥哥实测 0.4 仍偏亮压不住文字，加深遮罩保证对话可读 */}
            {/* 260610 Red 0.5.0 refine#1：0.62→0.3，两侧栏已改深色磨砂当暗壳，聊天区作为更亮的焦点区，弱化暗罩 */}
            <div
              aria-hidden="true"
              class="absolute inset-0 z-0 pointer-events-none"
              style={{ background: "rgba(0,0,0,0.3)" }}
            />
          </Show>
          <div class="relative z-[1] flex-1 min-h-0 overflow-hidden">
            <Switch>
              <Match when={params.id && mobileChanges()}>
                <div class="relative h-full overflow-hidden">
                  {reviewContent({
                    diffStyle: "unified",
                    classes: {
                      root: "pb-8",
                      header: "px-4",
                      container: "px-4",
                    },
                    loadingClass: "px-4 py-4 text-text-weak",
                    emptyClass: "h-full pb-64 -mt-4 flex flex-col items-center justify-center text-center gap-6",
                  })}
                </div>
              </Match>
              <Match when={params.id}>
                <Show when={messagesReady()}>
                  <MessageTimeline
                    actions={actions}
                    scroll={ui.scroll}
                    onResumeScroll={resumeScroll}
                    setScrollRef={setScrollRef}
                    onScheduleScrollState={scheduleScrollState}
                    onAutoScrollHandleScroll={autoScroll.handleScroll}
                    onMarkScrollGesture={markScrollGesture}
                    hasScrollGesture={hasScrollGesture}
                    onUserScroll={nav.markScroll}
                    onHistoryScroll={historyLoader.onScrollerScroll}
                    onAutoScrollInteraction={autoScroll.handleInteraction}
                    shouldAnchorBottom={() =>
                      !location.hash && !store.messageId && !ui.pendingMessage && !autoScroll.userScrolled()
                    }
                    centered={centered()}
                    setContentRef={(el) => {
                      content = el
                      autoScroll.contentRef(el)

                      const root = scroller
                      if (root) scheduleScrollState(root)
                    }}
                    historyShift={historyLoader.shift()}
                    userMessages={historyLoader.userMessages()}
                    anchor={nav.anchor}
                    setRevealMessage={(fn) => {
                      revealMessage = fn
                    }}
                  />
                </Show>
              </Match>
              <Match when={true}>
                <Show when={USE_NEW_SESSION_DESIGN} fallback={<NewSessionView worktree={newSessionWorktree()} />}>
                  <NewSessionDesignView worktree={newSessionWorktree()}>
                    {composerRegion("inline")}
                  </NewSessionDesignView>
                </Show>
              </Match>
            </Switch>
          </div>

          <Show when={params.id || !USE_NEW_SESSION_DESIGN}>{composerRegion("dock")}</Show>

          <Show when={desktopReviewOpen()}>
            <div onPointerDown={() => size.start()}>
              <ResizeHandle
                direction="horizontal"
                invert={true}
                size={layout.session.width()}
                      min={340}
                max={typeof window === "undefined" ? 1000 : window.innerWidth * 0.45}
                onResize={(width) => {
                  size.touch()
                  layout.session.resize(width)
                }}
              />
            </div>
          </Show>
        </div>

        <SessionSidePanel
          canReview={canReview}
          reviewPanel={reviewPanel}
          reviewSnap={ui.reviewSnap}
          size={size}
        />
      </div>

      <TerminalPanel />
    </div>
  )
}
