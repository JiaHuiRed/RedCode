import { useFilteredList } from "@redcode-ai/ui/hooks"
import { useSpring } from "@redcode-ai/ui/motion-spring"
import {
  createEffect,
  on,
  Component,
  Show,
  onCleanup,
  createMemo,
  createSignal,
  createResource,
  type Accessor,
  Suspense,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import { selectionFromLines, type SelectedLineRange, useFile } from "@/context/file"
import {
  ContentPart,
  DEFAULT_PROMPT,
  isPromptEqual,
  Prompt,
  usePrompt,
  ImageAttachmentPart,
  AgentPart,
  FileAttachmentPart,
} from "@/context/prompt"
import { useLayout } from "@/context/layout"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { useComments } from "@/context/comments"
import { Button } from "@redcode-ai/ui/button"
import { DockShellForm } from "@redcode-ai/ui/dock-surface"
import { Icon } from "@redcode-ai/ui/icon"
import { ProviderIcon } from "@redcode-ai/ui/provider-icon"
import { SessionContextUsage } from "@/components/session-context-usage"
import { Tooltip, TooltipKeybind } from "@redcode-ai/ui/tooltip"
import { EffortSliderV2 } from "@redcode-ai/ui/v2/components/effort-slider-v2.jsx"
import { Popover } from "@redcode-ai/ui/popover"
import { IconButton } from "@redcode-ai/ui/icon-button"
import { Select } from "@redcode-ai/ui/select"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { ModelSelectorPopover } from "@/components/dialog-select-model"
import { useProviders } from "@/hooks/use-providers"
import { useCommand } from "@/context/command"
import { Persist, persisted } from "@/utils/persist"
import { usePermission } from "@/context/permission"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createSessionTabs } from "@/pages/session/helpers"
import {
  createTextFragment,
  getCursorPosition,
  setCursorPosition,
  setRangeEdge,
  parseFromDOM,
} from "./prompt-input/editor-dom"
import { findHistorySuggestion } from "./prompt-input/suggestion"
import { createGhostSystem } from "./prompt-input/ghost"
import { createPromptAttachments } from "./prompt-input/attachments"
import { ACCEPTED_FILE_TYPES } from "./prompt-input/files"
import {
  canNavigateHistoryAtCursor,
  navigatePromptHistory,
  prependHistoryEntry,
  type PromptHistoryComment,
  type PromptHistoryEntry,
  type PromptHistoryStoredEntry,
  promptLength,
  serializePromptHistory,
  stripPromptHistoryImages,
} from "./prompt-input/history"
import { createPromptSubmit, type FollowupDraft } from "./prompt-input/submit"
import { PromptPopover, type AtOption, type SlashCommand } from "./prompt-input/slash-popover"
import { PromptContextItems } from "./prompt-input/context-items"
import { PromptImageAttachments } from "./prompt-input/image-attachments"
import { PromptDragOverlay } from "./prompt-input/drag-overlay"
import { promptPlaceholder } from "./prompt-input/placeholder"
import { ImagePreview } from "@redcode-ai/ui/image-preview"
import { useQueries } from "@tanstack/solid-query"
import { useQueryOptions } from "@/context/server-sync"
import { pathKey } from "@/utils/path-key"
import { getFilename } from "@redcode-ai/core/util/path"

interface PromptInputProps {
  class?: string
  variant?: "dock" | "new-session"
  ref?: (el: HTMLDivElement) => void
  newSessionWorktree?: string
  onNewSessionWorktreeChange?: (worktree: string) => void
  onNewSessionWorktreeReset?: () => void
  edit?: { id: string; prompt: Prompt; context: FollowupDraft["context"] }
  onEditLoaded?: () => void
  shouldQueue?: () => boolean
  onQueue?: (draft: FollowupDraft) => void
  onAbort?: () => void
  onSubmit?: () => void
}

const EXAMPLES = [
  "prompt.example.1",
  "prompt.example.2",
  "prompt.example.3",
  "prompt.example.4",
  "prompt.example.5",
  "prompt.example.6",
  "prompt.example.7",
  "prompt.example.8",
  "prompt.example.9",
  "prompt.example.10",
  "prompt.example.11",
  "prompt.example.12",
  "prompt.example.13",
  "prompt.example.14",
  "prompt.example.15",
  "prompt.example.16",
  "prompt.example.17",
  "prompt.example.18",
  "prompt.example.19",
  "prompt.example.20",
  "prompt.example.21",
  "prompt.example.22",
  "prompt.example.23",
  "prompt.example.24",
  "prompt.example.25",
] as const

const MAIN_WORKTREE = "main"
const CREATE_WORKTREE = "create"

export const PromptInput: Component<PromptInputProps> = (props) => {
  const sdk = useSDK()
  const queryOptions = useQueryOptions()

  const sync = useSync()
  const local = useLocal()
  const files = useFile()
  const prompt = usePrompt()
  const layout = useLayout()
  const comments = useComments()
  const dialog = useDialog()
  const providers = useProviders()
  const command = useCommand()
  const permission = usePermission()
  const language = useLanguage()
  const platform = usePlatform()
  const { params, tabs, view } = useSessionLayout()
  let editorRef!: HTMLDivElement
  let fileInputRef: HTMLInputElement | undefined
  let scrollRef!: HTMLDivElement
  let slashPopoverRef!: HTMLDivElement

  const mirror = { input: false }
  const inset = 56

  const scrollCursorIntoView = () => {
    const container = scrollRef
    const selection = window.getSelection()
    if (!container || !selection || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    if (!editorRef.contains(range.startContainer)) return

    const cursor = getCursorPosition(editorRef)
    const length = promptLength(prompt.current().filter((part) => part.type !== "image"))
    if (cursor >= length) {
      container.scrollTop = container.scrollHeight
      return
    }

    const rect = range.getClientRects().item(0) ?? range.getBoundingClientRect()
    if (!rect.height) return

    const containerRect = container.getBoundingClientRect()
    const top = rect.top - containerRect.top + container.scrollTop
    const bottom = rect.bottom - containerRect.top + container.scrollTop
    const padding = 12

    if (top < container.scrollTop + padding) {
      container.scrollTop = Math.max(0, top - padding)
      return
    }

    if (bottom > container.scrollTop + container.clientHeight - inset) {
      container.scrollTop = bottom - container.clientHeight + inset
    }
  }

  const queueScroll = (count = 2) => {
    requestAnimationFrame(() => {
      scrollCursorIntoView()
      if (count > 1) queueScroll(count - 1)
    })
  }

  const activeFileTab = createSessionTabs({
    tabs,
    pathFromTab: files.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? files.tab(tab) : tab),
  }).activeFileTab

  const commentInReview = (path: string) => {
    const sessionID = params.id
    if (!sessionID) return false

    const diffs = sync.data.session_diff[sessionID]
    if (!diffs) return false
    return diffs.some((diff) => diff.file === path)
  }

  const openComment = (item: { path: string; commentID?: string; commentOrigin?: "review" | "file" }) => {
    if (!item.commentID) return

    const focus = { file: item.path, id: item.commentID }
    comments.setActive(focus)

    const queueCommentFocus = (attempts = 6) => {
      const schedule = (left: number) => {
        requestAnimationFrame(() => {
          comments.setFocus({ ...focus })
          if (left <= 0) return
          requestAnimationFrame(() => {
            const current = comments.focus()
            if (!current) return
            if (current.file !== focus.file || current.id !== focus.id) return
            schedule(left - 1)
          })
        })
      }

      schedule(attempts)
    }

    const wantsReview = item.commentOrigin === "review" || (item.commentOrigin !== "file" && commentInReview(item.path))
    if (wantsReview) {
      if (!view().reviewPanel.opened()) view().reviewPanel.open()
      layout.fileTree.setTab("changes")
      tabs().setActive("review")
      queueCommentFocus()
      return
    }

    if (!view().reviewPanel.opened()) view().reviewPanel.open()
    layout.fileTree.setTab("all")
    const tab = files.tab(item.path)
    void tabs().open(tab)
    tabs().setActive(tab)
    void Promise.resolve(files.load(item.path)).finally(() => queueCommentFocus())
  }

  const recent = createMemo(() => {
    const all = tabs().all()
    const active = activeFileTab()
    const order = active ? [active, ...all.filter((x) => x !== active)] : all
    const seen = new Set<string>()
    const paths: string[] = []

    for (const tab of order) {
      const path = files.pathFromTab(tab)
      if (!path) continue
      if (seen.has(path)) continue
      seen.add(path)
      paths.push(path)
    }

    return paths
  })
  const info = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))
  const working = createMemo(() => sync.data.session_working(params.id ?? ""))
  const imageAttachments = createMemo(() =>
    prompt.current().filter((part): part is ImageAttachmentPart => part.type === "image"),
  )

  const [store, setStore] = createStore<{
    popover: "at" | "slash" | null
    historyIndex: number
    savedPrompt: PromptHistoryEntry | null
    placeholder: number
    draggingType: "image" | "@mention" | null
    mode: "normal" | "shell"
    applyingHistory: boolean
  }>({
    popover: null,
    historyIndex: -1,
    savedPrompt: null as PromptHistoryEntry | null,
    placeholder: Math.floor(Math.random() * EXAMPLES.length),
    draggingType: null,
    mode: "normal",
    applyingHistory: false,
  })

  const buttonsSpring = useSpring(() => (store.mode === "normal" ? 1 : 0), { visualDuration: 0.2, bounce: 0 })
  const motion = (value: number) => ({
    opacity: value,
    transform: `scale(${0.98 + value * 0.02})`,
    filter: `blur(${(1 - value) * 2}px)`,
    "pointer-events": value > 0.5 ? ("auto" as const) : ("none" as const),
  })
  const buttons = createMemo(() => motion(buttonsSpring()))
  const shell = createMemo(() => motion(1 - buttonsSpring()))
  const control = createMemo(() => ({ height: "28px", ...buttons() }))

  const commentCount = createMemo(() => {
    if (store.mode === "shell") return 0
    return prompt.context.items().filter((item) => !!item.comment?.trim()).length
  })
  const blank = createMemo(() => {
    const text = prompt
      .current()
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
    return text.trim().length === 0 && imageAttachments().length === 0 && commentCount() === 0
  })
  const stopping = createMemo(() => working() && blank())
  const tip = () => {
    if (stopping()) {
      return (
        <div class="flex items-center gap-2">
          <span>{language.t("prompt.action.stop")}</span>
          <span class="text-icon-base text-12-medium text-[10px]!">{language.t("common.key.esc")}</span>
        </div>
      )
    }

    return (
      <div class="flex items-center gap-2">
        <span>{language.t("prompt.action.send")}</span>
        <Icon name="enter" size="small" class="text-icon-base" />
      </div>
    )
  }

  const contextItems = createMemo(() => {
    const items = prompt.context.items()
    if (store.mode !== "shell") return items
    return items.filter((item) => !item.comment?.trim())
  })

  const hasUserPrompt = createMemo(() => {
    const sessionID = params.id
    if (!sessionID) return false
    const messages = sync.data.message[sessionID]
    if (!messages) return false
    return messages.some((m) => m.role === "user")
  })

  // 260901 cc migrate + serialize 两个都要挂，见 history.ts 的 stripPromptHistoryImages：
  //   serialize 管「以后别再写进去」，migrate 管「存量就地瘦身」。
  //   这个 store 住在 Persist.global 共用的 RedCode.global.dat 里，它一胖，
  //   layout / model / command.catalog 每一次写都跟着变贵。
  const [history, setHistory] = persisted(
    {
      ...Persist.global("prompt-history", ["prompt-history.v1"]),
      migrate: stripPromptHistoryImages,
      serialize: serializePromptHistory,
    },
    createStore<{
      entries: PromptHistoryStoredEntry[]
    }>({
      entries: [],
    }),
  )
  const [shellHistory, setShellHistory] = persisted(
    {
      ...Persist.global("prompt-history-shell", ["prompt-history-shell.v1"]),
      migrate: stripPromptHistoryImages,
      serialize: serializePromptHistory,
    },
    createStore<{
      entries: PromptHistoryStoredEntry[]
    }>({
      entries: [],
    }),
  )

  const suggest = createMemo(() => !hasUserPrompt())

  const placeholder = createMemo(() =>
    promptPlaceholder({
      mode: store.mode,
      commentCount: commentCount(),
      example: suggest() ? (store.mode === "shell" ? "git status" : language.t(EXAMPLES[store.placeholder])) : "",
      suggest: suggest(),
      t: (key, params) => language.t(key as Parameters<typeof language.t>[0], params as never),
    }),
  )

  const historyComments = () => {
    const byID = new Map(comments.all().map((item) => [`${item.file}\n${item.id}`, item] as const))
    return prompt.context.items().flatMap((item) => {
      if (item.type !== "file") return []
      const comment = item.comment?.trim()
      if (!comment) return []

      const selection = item.commentID ? byID.get(`${item.path}\n${item.commentID}`)?.selection : undefined
      const nextSelection =
        selection ??
        (item.selection
          ? ({
              start: item.selection.startLine,
              end: item.selection.endLine,
            } satisfies SelectedLineRange)
          : undefined)
      if (!nextSelection) return []

      return [
        {
          id: item.commentID ?? item.key,
          path: item.path,
          selection: { ...nextSelection },
          comment,
          time: item.commentID ? (byID.get(`${item.path}\n${item.commentID}`)?.time ?? Date.now()) : Date.now(),
          origin: item.commentOrigin,
          preview: item.preview,
        } satisfies PromptHistoryComment,
      ]
    })
  }

  const applyHistoryComments = (items: PromptHistoryComment[]) => {
    comments.replace(
      items.map((item) => ({
        id: item.id,
        file: item.path,
        selection: { ...item.selection },
        comment: item.comment,
        time: item.time,
      })),
    )
    prompt.context.replaceComments(
      items.map((item) => ({
        type: "file" as const,
        path: item.path,
        selection: selectionFromLines(item.selection),
        comment: item.comment,
        commentID: item.id,
        commentOrigin: item.origin,
        preview: item.preview,
      })),
    )
  }

  const applyHistoryPrompt = (entry: PromptHistoryEntry, position: "start" | "end") => {
    const p = entry.prompt
    const length = position === "start" ? 0 : promptLength(p)
    setStore("applyingHistory", true)
    applyHistoryComments(entry.comments)
    prompt.set(p, length)
    requestAnimationFrame(() => {
      editorRef.focus()
      setCursorPosition(editorRef, length)
      setStore("applyingHistory", false)
      queueScroll()
    })
  }

  const getCaretState = () => {
    const selection = window.getSelection()
    const textLength = promptLength(prompt.current())
    if (!selection || selection.rangeCount === 0) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    const anchorNode = selection.anchorNode
    if (!anchorNode || !editorRef.contains(anchorNode)) {
      return { collapsed: false, cursorPosition: 0, textLength }
    }
    return {
      collapsed: selection.isCollapsed,
      cursorPosition: getCursorPosition(editorRef),
      textLength,
    }
  }

  const escBlur = () => platform.platform === "desktop" && platform.os === "macos"

  const pick = () => fileInputRef?.click()

  const setMode = (mode: "normal" | "shell") => {
    setStore("mode", mode)
    setStore("popover", null)
    requestAnimationFrame(() => editorRef?.focus())
  }

  const shellModeKey = "mod+shift+x"
  const normalModeKey = "mod+shift+e"

  command.register("prompt-input", () => [
    {
      id: "file.attach",
      title: language.t("prompt.action.attachFile"),
      category: language.t("command.category.file"),
      keybind: "mod+u",
      disabled: store.mode !== "normal",
      onSelect: pick,
    },
    {
      id: "prompt.mode.shell",
      title: language.t("command.prompt.mode.shell"),
      category: language.t("command.category.session"),
      keybind: shellModeKey,
      disabled: store.mode === "shell",
      onSelect: () => setMode("shell"),
    },
    {
      id: "prompt.mode.normal",
      title: language.t("command.prompt.mode.normal"),
      category: language.t("command.category.session"),
      keybind: normalModeKey,
      disabled: store.mode === "normal",
      onSelect: () => setMode("normal"),
    },
  ])
  const closePopover = () => setStore("popover", null)

  const [composing, setComposing] = createSignal(false)

  const resetHistoryNavigation = (force = false) => {
    if (!force && (store.historyIndex < 0 || store.applyingHistory)) return
    setStore("historyIndex", -1)
    setStore("savedPrompt", null)
  }

  const clearEditor = () => {
    editorRef.innerHTML = ""
  }

  const setEditorText = (text: string) => {
    clearEditor()
    editorRef.textContent = text
  }

  const ghost = createGhostSystem({
    editorRef,
    store: {
      get mode() {
        return store.mode
      },
      get popover() {
        return store.popover
      },
      get historyIndex() {
        return store.historyIndex
      },
    },
    prompt: {
      current: () => prompt.current(),
      set: (parts, cursor) => prompt.set(parts, cursor),
    },
    composing,
    history,
    mirror,
    setEditorText,
    setCursorPosition,
    resetHistoryNavigation,
  })

  const focusEditorEnd = () => {
    requestAnimationFrame(() => {
      editorRef.focus()
      const range = document.createRange()
      const selection = window.getSelection()
      range.selectNodeContents(editorRef)
      range.collapse(false)
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
  }

  const currentCursor = () => {
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0 || !editorRef.contains(selection.anchorNode)) return null
    return getCursorPosition(editorRef)
  }

  const restoreFocus = () => {
    requestAnimationFrame(() => {
      const cursor = prompt.cursor() ?? promptLength(prompt.current())
      editorRef.focus()
      setCursorPosition(editorRef, cursor)
      queueScroll()
    })
  }

  const renderEditorWithCursor = (parts: Prompt) => {
    const cursor = currentCursor()
    renderEditor(parts)
    if (cursor !== null) setCursorPosition(editorRef, cursor)
  }

  createEffect(() => {
    params.id
    if (params.id) return
    if (!suggest()) return
    const interval = setInterval(() => {
      setStore("placeholder", (prev) => (prev + 1) % EXAMPLES.length)
    }, 6500)
    onCleanup(() => clearInterval(interval))
  })

  const isImeComposing = (event: KeyboardEvent) => event.isComposing || composing() || event.keyCode === 229

  const handleBlur = () => {
    closePopover()
    setComposing(false)
    clearGhost()
  }

  const handleCompositionStart = () => {
    setComposing(true)
  }

  const handleCompositionEnd = () => {
    setComposing(false)
    requestAnimationFrame(() => {
      if (composing()) return
      reconcile(prompt.current().filter((part) => part.type !== "image"))
    })
  }

  // 260707 Red ghost 补全（历史前缀 inline 建议，fish/zsh-autosuggestions 风格）：
  // 在文末光标之后插入不可编辑、不计长度的灰字节点；→/End/Tab 接受，任意输入清除。
  const clearGhost = () => {
    editorRef?.querySelectorAll("[data-ghost]").forEach((el) => el.remove())
  }

  const ghostSuffix = () => editorRef?.querySelector("[data-ghost]")?.textContent ?? ""

  const applyGhost = (suffix: string) => {
    clearGhost()
    if (!suffix) return
    const span = document.createElement("span")
    span.dataset.ghost = "true"
    span.setAttribute("contenteditable", "false")
    span.className = "opacity-40 pointer-events-none select-none"
    span.textContent = suffix
    editorRef.appendChild(span)
  }

  const updateGhost = () => {
    clearGhost()
    if (store.mode !== "normal" || store.popover || store.historyIndex >= 0 || composing()) return
    const parts = prompt.current().filter((part) => part.type !== "image")
    if (parts.some((part) => part.type !== "text")) return
    const text = parts.map((part) => ("content" in part ? part.content : "")).join("")
    if (!text || text.includes("\n")) return
    const { collapsed, cursorPosition } = getCaretState()
    if (!collapsed || cursorPosition !== text.length) return
    const suffix = findHistorySuggestion(history.entries, text)
    if (suffix) applyGhost(suffix)
  }

  const acceptGhost = () => {
    const suffix = ghostSuffix()
    if (!suffix) return false
    clearGhost()
    const text = prompt
      .current()
      .filter((part) => part.type !== "image")
      .map((part) => ("content" in part ? part.content : ""))
      .join("")
    const full = text + suffix
    mirror.input = true
    prompt.set([{ type: "text", content: full, start: 0, end: full.length }], full.length)
    setEditorText(full)
    setCursorPosition(editorRef, full.length)
    resetHistoryNavigation()
    return true
  }

  const agentList = createMemo(() =>
    sync.data.agent
      .filter((agent) => !agent.hidden && agent.mode !== "primary")
      .map((agent): AtOption => ({ type: "agent", name: agent.name, display: agent.displayName ?? agent.name })),
  )
  const agentNames = createMemo(() => local.agent.list().map((agent) => agent.name))

  const handleAtSelect = (option: AtOption | undefined) => {
    if (!option) return
    if (option.type === "agent") {
      addPart({ type: "agent", name: option.name, content: "@" + option.name, start: 0, end: 0 })
    } else {
      addPart({ type: "file", path: option.path, content: "@" + option.path, start: 0, end: 0 })
    }
  }

  const atKey = (x: AtOption | undefined) => {
    if (!x) return ""
    return x.type === "agent" ? `agent:${x.name}` : `file:${x.path}`
  }

  const {
    flat: atFlat,
    active: atActive,
    setActive: setAtActive,
    onInput: atOnInput,
    onKeyDown: atOnKeyDown,
    loading: atLoading,
  } = useFilteredList<AtOption>({
    items: async (query) => {
      const agents = agentList()
      const open = recent()
      const seen = new Set(open)
      const pinned: AtOption[] = open.map((path) => ({ type: "file", path, display: path, recent: true }))
      if (!query.trim()) return [...agents, ...pinned]
      const paths = await files.searchFilesAndDirectories(query)
      const fileOptions: AtOption[] = paths
        .filter((path) => !seen.has(path))
        .map((path) => ({ type: "file", path, display: path }))
      return [...agents, ...pinned, ...fileOptions]
    },
    key: atKey,
    filterKeys: ["display"],
    groupBy: (item) => {
      if (item.type === "agent") return "agent"
      if (item.recent) return "recent"
      return "file"
    },
    sortGroupsBy: (a, b) => {
      const rank = (category: string) => {
        if (category === "agent") return 0
        if (category === "recent") return 1
        return 2
      }
      return rank(a.category) - rank(b.category)
    },
    onSelect: handleAtSelect,
  })

  const slashCommands = createMemo<SlashCommand[]>(() => {
    const builtin = command.options
      .filter((opt) => !opt.disabled && !opt.id.startsWith("suggested.") && opt.slash)
      .map((opt) => ({
        id: opt.id,
        trigger: opt.slash!,
        title: opt.title,
        description: opt.description,
        keybind: opt.keybind,
        type: "builtin" as const,
      }))

    const custom = sync.data.command.map((cmd) => ({
      id: `custom.${cmd.name}`,
      trigger: cmd.name,
      title: cmd.name,
      description: cmd.description,
      type: "custom" as const,
      source: cmd.source,
    }))

    return [...custom, ...builtin]
  })

  const handleSlashSelect = (cmd: SlashCommand | undefined) => {
    if (!cmd) return
    closePopover()
    const images = imageAttachments()

    if (cmd.type === "custom") {
      const text = `/${cmd.trigger} `
      setEditorText(text)
      prompt.set([{ type: "text", content: text, start: 0, end: text.length }, ...images], text.length)
      focusEditorEnd()
      return
    }

    clearEditor()
    prompt.set([...DEFAULT_PROMPT, ...images], 0)
    command.trigger(cmd.id, "slash")
  }

  const {
    flat: slashFlat,
    active: slashActive,
    setActive: setSlashActive,
    onInput: slashOnInput,
    onKeyDown: slashOnKeyDown,
  } = useFilteredList<SlashCommand>({
    items: slashCommands,
    key: (x) => x?.id,
    filterKeys: ["trigger", "title"],
    onSelect: handleSlashSelect,
  })

  const createPill = (part: FileAttachmentPart | AgentPart) => {
    const pill = document.createElement("span")
    pill.textContent = part.content
    pill.setAttribute("data-type", part.type)
    if (part.type === "file") pill.setAttribute("data-path", part.path)
    if (part.type === "agent") pill.setAttribute("data-name", part.name)
    pill.setAttribute("contenteditable", "false")
    pill.style.userSelect = "text"
    pill.style.cursor = "default"
    return pill
  }

  const isNormalizedEditor = () =>
    Array.from(editorRef.childNodes).every((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? ""
        if (!text.includes("\u200B")) return true
        if (text !== "\u200B") return false

        const prev = node.previousSibling
        const next = node.nextSibling
        const prevIsBr = prev?.nodeType === Node.ELEMENT_NODE && (prev as HTMLElement).tagName === "BR"
        return !!prevIsBr && !next
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return false
      const el = node as HTMLElement
      if (el.dataset.ghost === "true") return true
      if (el.dataset.type === "file") return true
      if (el.dataset.type === "agent") return true
      return el.tagName === "BR"
    })

  const renderEditor = (parts: Prompt) => {
    clearEditor()
    for (const part of parts) {
      if (part.type === "text") {
        editorRef.appendChild(createTextFragment(part.content))
        continue
      }
      if (part.type === "file" || part.type === "agent") {
        editorRef.appendChild(createPill(part))
      }
    }

    const last = editorRef.lastChild
    if (last?.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR") {
      editorRef.appendChild(document.createTextNode("\u200B"))
    }
  }

  // Auto-scroll active command into view when navigating with keyboard
  createEffect(() => {
    const activeId = slashActive()
    if (!activeId || !slashPopoverRef) return

    requestAnimationFrame(() => {
      const element = slashPopoverRef.querySelector(`[data-slash-id="${activeId}"]`)
      element?.scrollIntoView({ block: "nearest", behavior: "smooth" })
    })
  })
  const selectPopoverActive = () => {
    if (store.popover === "at") {
      // 260901 cc Tab 走的是这条路而不是 useFilteredList 的 onKeyDown，所以那边的
      //   同款闸门管不到这里，要单独判一次：新查询在途时 atFlat() 还是上一次的结果，
      //   选中就等于插入一个用户没挑的候选。说明见 use-filtered-list.tsx 的 Enter 分支。
      if (atLoading()) return
      const items = atFlat()
      if (items.length === 0) return
      const active = atActive()
      const item = items.find((entry) => atKey(entry) === active) ?? items[0]
      handleAtSelect(item)
      return
    }

    if (store.popover === "slash") {
      const items = slashFlat()
      if (items.length === 0) return
      const active = slashActive()
      const item = items.find((entry) => entry.id === active) ?? items[0]
      handleSlashSelect(item)
    }
  }

  const reconcile = (input: Prompt) => {
    if (mirror.input) {
      mirror.input = false
      if (isNormalizedEditor()) return

      renderEditorWithCursor(input)
      return
    }

    const dom = parseFromDOM(editorRef)
    if (isNormalizedEditor() && isPromptEqual(input, dom)) return

    renderEditorWithCursor(input)
  }

  createEffect(
    on(
      () => prompt.current(),
      (parts) => {
        if (composing()) return
        reconcile(parts.filter((part) => part.type !== "image"))
      },
    ),
  )

  const handleInput = () => {
    clearSendError()
    clearGhost()
    const rawParts = parseFromDOM(editorRef)
    const images = imageAttachments()
    const cursorPosition = getCursorPosition(editorRef)
    const rawText =
      rawParts.length === 1 && rawParts[0]?.type === "text"
        ? rawParts[0].content
        : rawParts.map((p) => ("content" in p ? p.content : "")).join("")
    const hasNonText = rawParts.some((part) => part.type !== "text")
    const textContent = (editorRef.textContent ?? "").replace(/\u200B/g, "")
    const shouldReset =
      textContent.length === 0 && rawText.replace(/\n/g, "").length === 0 && !hasNonText && images.length === 0

    if (shouldReset) {
      closePopover()
      resetHistoryNavigation()
      if (prompt.dirty()) {
        mirror.input = true
        prompt.set(DEFAULT_PROMPT, 0)
      }
      queueScroll()
      return
    }

    const shellMode = store.mode === "shell"

    if (!shellMode) {
      const atMatch = rawText.substring(0, cursorPosition).match(/@(\S*)$/)
      const slashMatch = rawText.match(/^\/(\S*)$/)

      if (atMatch) {
        atOnInput(atMatch[1])
        setStore("popover", "at")
      } else if (slashMatch) {
        slashOnInput(slashMatch[1])
        setStore("popover", "slash")
      } else {
        closePopover()
      }
    } else {
      closePopover()
    }

    resetHistoryNavigation()

    mirror.input = true
    prompt.set([...rawParts, ...images], cursorPosition)
    updateGhost()
    queueScroll()
  }

  const addPart = (part: ContentPart) => {
    if (part.type === "image") return false

    const selection = window.getSelection()
    if (!selection) return false

    if (selection.rangeCount === 0 || !editorRef.contains(selection.anchorNode)) {
      editorRef.focus()
      const cursor = prompt.cursor() ?? promptLength(prompt.current())
      setCursorPosition(editorRef, cursor)
    }

    if (selection.rangeCount === 0) return false
    const range = selection.getRangeAt(0)
    if (!editorRef.contains(range.startContainer)) return false

    if (part.type === "file" || part.type === "agent") {
      const cursorPosition = getCursorPosition(editorRef)
      const rawText = prompt
        .current()
        .map((p) => ("content" in p ? p.content : ""))
        .join("")
      const textBeforeCursor = rawText.substring(0, cursorPosition)
      const atMatch = textBeforeCursor.match(/@(\S*)$/)
      const pill = createPill(part)
      const gap = document.createTextNode(" ")

      if (atMatch) {
        const start = atMatch.index ?? cursorPosition - atMatch[0].length
        setRangeEdge(editorRef, range, "start", start)
        setRangeEdge(editorRef, range, "end", cursorPosition)
      }

      range.deleteContents()
      range.insertNode(gap)
      range.insertNode(pill)
      range.setStartAfter(gap)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    if (part.type === "text") {
      const fragment = createTextFragment(part.content)
      const last = fragment.lastChild
      range.deleteContents()
      range.insertNode(fragment)
      if (last) {
        if (last.nodeType === Node.TEXT_NODE) {
          const text = last.textContent ?? ""
          if (text === "\u200B") {
            range.setStart(last, 0)
          }
          if (text !== "\u200B") {
            range.setStart(last, text.length)
          }
        }
        if (last.nodeType !== Node.TEXT_NODE) {
          const isBreak = last.nodeType === Node.ELEMENT_NODE && (last as HTMLElement).tagName === "BR"
          const next = last.nextSibling
          const emptyText = next?.nodeType === Node.TEXT_NODE && (next.textContent ?? "") === ""
          if (isBreak && (!next || emptyText)) {
            const placeholder = next && emptyText ? next : document.createTextNode("\u200B")
            if (!next) last.parentNode?.insertBefore(placeholder, null)
            placeholder.textContent = "\u200B"
            range.setStart(placeholder, 0)
          } else {
            range.setStartAfter(last)
          }
        }
      }
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    handleInput()
    closePopover()
    return true
  }

  const addToHistory = (prompt: Prompt, mode: "normal" | "shell") => {
    const currentHistory = mode === "shell" ? shellHistory : history
    const setCurrentHistory = mode === "shell" ? setShellHistory : setHistory
    const next = prependHistoryEntry(currentHistory.entries, prompt, mode === "shell" ? [] : historyComments())
    if (next === currentHistory.entries) return
    setCurrentHistory("entries", next)
  }

  createEffect(
    on(
      () => props.edit?.id,
      (id) => {
        const edit = props.edit
        if (!id || !edit) return

        for (const item of prompt.context.items()) {
          prompt.context.remove(item.key)
        }

        for (const item of edit.context) {
          prompt.context.add({
            type: item.type,
            path: item.path,
            selection: item.selection,
            comment: item.comment,
            commentID: item.commentID,
            commentOrigin: item.commentOrigin,
            preview: item.preview,
          })
        }

        setStore("mode", "normal")
        setStore("popover", null)
        setStore("historyIndex", -1)
        setStore("savedPrompt", null)
        prompt.set(edit.prompt, promptLength(edit.prompt))
        requestAnimationFrame(() => {
          editorRef.focus()
          setCursorPosition(editorRef, promptLength(edit.prompt))
          queueScroll()
        })
        props.onEditLoaded?.()
      },
      { defer: true },
    ),
  )

  const navigateHistory = (direction: "up" | "down") => {
    const result = navigatePromptHistory({
      direction,
      entries: store.mode === "shell" ? shellHistory.entries : history.entries,
      historyIndex: store.historyIndex,
      currentPrompt: prompt.current(),
      currentComments: historyComments(),
      savedPrompt: store.savedPrompt,
    })
    if (!result.handled) return false
    setStore("historyIndex", result.historyIndex)
    setStore("savedPrompt", result.savedPrompt)
    applyHistoryPrompt(result.entry, result.cursor)
    return true
  }

  const { addAttachments, removeAttachment, handlePaste } = createPromptAttachments({
    editor: () => editorRef,
    isDialogActive: () => !!dialog.active,
    setDraggingType: (type) => setStore("draggingType", type),
    focusEditor: () => {
      editorRef.focus()
      setCursorPosition(editorRef, promptLength(prompt.current()))
    },
    addPart,
    readClipboardImage: platform.readClipboardImage,
    writeAttachment: platform.writeAttachment,
    sessionDirectory: sdk.directory,
  })

  const fileAttachmentInput = () => (
    <input
      ref={(el) => (fileInputRef = el)}
      type="file"
      multiple
      accept={ACCEPTED_FILE_TYPES.join(",")}
      class="hidden"
      onChange={(e) => {
        const list = e.currentTarget.files
        if (list) void addAttachments(Array.from(list))
        e.currentTarget.value = ""
      }}
    />
  )

  const variants = createMemo(() => ["default", ...local.model.variant.list()])
  const variantLabel = (value: string) => (value === "default" ? language.t("common.default") : value)
  const accepting = createMemo(() => {
    const id = params.id
    if (!id) return permission.isAutoAcceptingDirectory(sdk.directory)
    return permission.isAutoAccepting(id, sdk.directory)
  })

  const { abort, handleSubmit, sendError, clearSendError } = createPromptSubmit({
    info,
    imageAttachments,
    commentCount,
    autoAccept: () => accepting(),
    mode: () => store.mode,
    working,
    editor: () => editorRef,
    queueScroll,
    promptLength,
    addToHistory,
    resetHistoryNavigation: () => {
      resetHistoryNavigation(true)
    },
    setMode: (mode) => setStore("mode", mode),
    setPopover: (popover) => setStore("popover", popover),
    newSessionWorktree: () => props.newSessionWorktree,
    onNewSessionWorktreeReset: props.onNewSessionWorktreeReset,
    shouldQueue: props.shouldQueue,
    onQueue: props.onQueue,
    onAbort: props.onAbort,
    onSubmit: props.onSubmit,
  })

  const handleKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "u") {
      event.preventDefault()
      if (store.mode !== "normal") return
      pick()
      return
    }

    if (event.key === "Backspace") {
      const selection = window.getSelection()
      if (selection && selection.isCollapsed) {
        const node = selection.anchorNode
        const offset = selection.anchorOffset
        if (node && node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent ?? ""
          if (/^\u200B+$/.test(text) && offset > 0) {
            const range = document.createRange()
            range.setStart(node, 0)
            range.collapse(true)
            selection.removeAllRanges()
            selection.addRange(range)
          }
        }
      }
    }

    if (event.key === "!" && store.mode === "normal") {
      const cursorPosition = getCursorPosition(editorRef)
      if (cursorPosition === 0) {
        setStore("mode", "shell")
        setStore("popover", null)
        event.preventDefault()
        return
      }
    }

    if (event.key === "Escape") {
      if (store.popover) {
        closePopover()
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (store.mode === "shell") {
        setStore("mode", "normal")
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (working()) {
        void abort()
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (escBlur()) {
        editorRef.blur()
        event.preventDefault()
        event.stopPropagation()
        return
      }
    }

    if (store.mode === "shell") {
      const { collapsed, cursorPosition, textLength } = getCaretState()
      if (event.key === "Backspace" && collapsed && cursorPosition === 0 && textLength === 0) {
        setStore("mode", "normal")
        event.preventDefault()
        return
      }
    }

    // Handle Shift+Enter BEFORE IME check - Shift+Enter is never used for IME input
    // and should always insert a newline regardless of composition state
    if (event.key === "Enter" && event.shiftKey) {
      addPart({ type: "text", content: "\n", start: 0, end: 0 })
      event.preventDefault()
      return
    }

    if (event.key === "Enter" && isImeComposing(event)) {
      return
    }

    // 260823 Red Ctrl/Cmd+Enter 属于权限弹窗快捷键（session-permission-dock 在 window 层监听，
    // 焦点在输入框内也响应）。这里只 preventDefault 阻止 contenteditable 默认插入换行，
    // 不 stopPropagation —— 事件必须继续冒泡到 window 让 dock 消费，否则权限确认失效。
    if (event.key === "Enter" && !event.shiftKey && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      return
    }

    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey

    if (store.popover) {
      if (event.key === "Tab") {
        selectPopoverActive()
        event.preventDefault()
        return
      }
      const nav = event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Enter"
      const ctrlNav = ctrl && (event.key === "n" || event.key === "p")
      if (nav || ctrlNav) {
        if (store.popover === "at") {
          atOnKeyDown(event)
          event.preventDefault()
          return
        }
        if (store.popover === "slash") {
          slashOnKeyDown(event)
        }
        event.preventDefault()
        return
      }
    }

    if (ctrl && event.code === "KeyG") {
      if (store.popover) {
        closePopover()
        event.preventDefault()
        return
      }
      if (working()) {
        void abort()
        event.preventDefault()
      }
      return
    }

    // 260707 Red ghost 补全接受：→/End/Tab，仅当无 popover、光标塌缩落在文末且有 ghost 时。
    if (!store.popover && (event.key === "ArrowRight" || event.key === "End" || event.key === "Tab")) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        // fall through
      } else if (ghostSuffix()) {
        const { collapsed, cursorPosition, textLength } = getCaretState()
        if (collapsed && cursorPosition === textLength) {
          if (acceptGhost()) {
            event.preventDefault()
            return
          }
        }
      }
    }

    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const { collapsed } = getCaretState()
      if (!collapsed) return

      const cursorPosition = getCursorPosition(editorRef)
      const textContent = prompt
        .current()
        .map((part) => ("content" in part ? part.content : ""))
        .join("")
      const direction = event.key === "ArrowUp" ? "up" : "down"
      if (!canNavigateHistoryAtCursor(direction, textContent, cursorPosition, store.historyIndex >= 0)) return
      if (navigateHistory(direction)) {
        event.preventDefault()
      }
      return
    }

    // Note: Shift+Enter is handled earlier, before IME check
    // 260823 Red Ctrl/Cmd+Enter 是权限弹窗"允许一次"的快捷键（session-permission-dock
    // window 级监听），输入框发送必须排除带修饰键的 Enter——否则按 Ctrl+Enter 时
    // 输入框文字先被 handleSubmit 发出去，权限随后也被允许，撞成两个动作。
    if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault()
      if (event.repeat) return
      if (
        working() &&
        prompt
          .current()
          .map((part) => ("content" in part ? part.content : ""))
          .join("")
          .trim().length === 0 &&
        imageAttachments().length === 0 &&
        commentCount() === 0
      ) {
        return
      }
      void handleSubmit(event)
    }
  }

  const [agentsQuery, globalProvidersQuery, providersQuery] = useQueries(() => ({
    queries: [
      queryOptions.agents(pathKey(sdk.directory)),
      queryOptions.providers(null),
      queryOptions.providers(pathKey(sdk.directory)),
    ],
  }))

  const agentsLoading = () => agentsQuery.isLoading
  const agentsShouldFadeIn = createMemo((prev) => prev ?? agentsLoading())
  const providersLoading = () => agentsLoading() || providersQuery.isLoading || globalProvidersQuery.isLoading
  const providersShouldFadeIn = createMemo((prev) => prev ?? providersLoading())

  const [promptReady] = createResource(
    () => prompt.ready.promise,
    (p) => p,
  )

  const designPlaceholder = () => {
    if (store.mode === "shell") return placeholder()
    return "Ask anything, / for commands, @ for context..."
  }

  // 260731 Karina GUI 输入框一直没有主 agent 切换入口 —— 工具栏只有模型和推理强度两个
  // 控件，于是永远停在 local.agent.list()[0]（build），plan / redmind 在界面上选不到。
  // 底层早就是通的：local.agent 的 list/current/set 在 @提及子代理时就在用，
  // agent.cycle 命令也早注册了（use-session-commands.tsx）、有快捷键、命令面板里能调，
  // 缺的只是这个可见控件。照 variantControl 的样式做，保持一排控件观感一致。
  const agentControl = () => (
    <Show when={local.agent.list().length > 1}>
      <div
        data-component="prompt-agent-control"
        style={providersShouldFadeIn() ? { animation: "fade-in 0.3s" } : undefined}
        class="flex items-center"
      >
        <Icon name="sliders" size="small" class="text-v2-icon-icon-muted pointer-events-none shrink-0" />
        <TooltipKeybind
          placement="top"
          gutter={4}
          title={language.t("command.agent.cycle")}
          keybind={command.keybind("agent.cycle")}
        >
          <Select
            size="normal"
            options={local.agent.list()}
            current={local.agent.current()}
            value={(item) => item.name}
            label={(item) => item.displayName ?? item.name}
            onSelect={(item) => {
              if (item) {
                local.agent.set(item.name)
                restoreFocus()
              }
            }}
            class="capitalize max-w-[160px] text-text-base"
            valueClass="truncate text-13-regular"
            triggerStyle={control()}
            triggerProps={{ "data-action": "prompt-agent" }}
            variant="ghost"
          />
        </TooltipKeybind>
      </div>
    </Show>
  )

  const variantControl = () => (
    <Show when={variants().length > 1}>
      <div
        data-component="prompt-variant-control"
        style={providersShouldFadeIn() ? { animation: "fade-in 0.3s" } : undefined}
        class="flex items-center"
      >
        {/* 260902 cc 下拉 → 弹窗里的滑杆。两步：
            ① 档位本来就是有序的一条轴（low→high），下拉把它呈现成无序候选，滑杆才是它的形状；
            ② 滑杆必须放进弹窗。第一版直接嵌在底栏，64px 宽根本滑不出"滚动感"，而且这排
               控件（模型选择器等）本来就都是弹窗，嵌一个异类进去也不成体统。
            "default" 保留为最左一档：它是"交给模型/agent 自己定"不是"最低强度"，
            但它是唯一能滑回未设置状态的路径，放在轴的起点当原点。 */}
        <TooltipKeybind
          placement="top"
          gutter={4}
          title={language.t("command.model.variant.cycle")}
          keybind={command.keybind("model.variant.cycle")}
        >
          <Popover
            placement="top"
            gutter={8}
            class="w-[236px]"
            triggerAs={Button}
            triggerProps={{
              variant: "ghost",
              size: "normal",
              style: control(),
              class: "min-w-0 max-w-[160px] justify-start text-[13px] font-[440] leading-4 text-v2-text-text-faint",
              "data-action": "prompt-model-variant",
            }}
            trigger={
              <>
                <Icon
                  name="brain"
                  size="small"
                  class={
                    local.model.variant.current() ? "shrink-0 text-yellow-400" : "shrink-0 text-v2-icon-icon-muted"
                  }
                />
                <span class="truncate capitalize">{variantLabel(local.model.variant.current() ?? "default")}</span>
                <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
              </>
            }
            onOpenChange={(open: boolean) => {
              if (!open) restoreFocus()
            }}
          >
            <div class="flex flex-col gap-2">
              <div class="flex items-baseline justify-between gap-2">
                <span class="text-11-regular text-text-weak">{language.t("settings.agents.variant.title")}</span>
                <span
                  class={`capitalize text-12-medium truncate ${
                    local.model.variant.current() ? "text-yellow-400" : "text-text-base"
                  }`}
                >
                  {variantLabel(local.model.variant.current() ?? "default")}
                </span>
              </div>
              <div class="flex items-baseline justify-between gap-2 text-11-regular text-text-weaker">
                <span>{language.t("prompt.variant.faster")}</span>
                <span>{language.t("prompt.variant.smarter")}</span>
              </div>
              <EffortSliderV2
                steps={variants()}
                current={local.model.variant.current() ?? "default"}
                label={variantLabel}
                title={language.t("settings.agents.variant.title")}
                onChange={(value) => local.model.variant.set(value === "default" ? undefined : value)}
                style={{ "--effort-slider-v2-width": "100%", "--effort-slider-v2-height": "20px" }}
              />
            </div>
          </Popover>
        </TooltipKeybind>
      </div>
    </Show>
  )

  const modelControl = () => (
    <Show when={!providersLoading()}>
      <Show
        when={providers.paid().length > 0}
        fallback={
          <TooltipKeybind
            placement="top"
            gutter={4}
            title={language.t("command.model.choose")}
            keybind={command.keybind("model.choose")}
          >
            <Button
              data-action="prompt-model"
              as="div"
              variant="ghost"
              size="normal"
              class="min-w-0 max-w-[220px] justify-start text-[13px] font-[440] leading-4 text-v2-text-text-faint group"
              style={control()}
              onClick={() => {
                void import("@/components/dialog-select-model-unpaid").then((x) => {
                  dialog.show(() => <x.DialogSelectModelUnpaid model={local.model} />)
                })
              }}
            >
              <Show when={local.model.current()?.provider?.id}>
                <ProviderIcon
                  id={local.model.current()?.provider?.id ?? ""}
                  class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
                  style={{ "will-change": "opacity", transform: "translateZ(0)" }}
                />
              </Show>
              <span class="truncate">{local.model.current()?.name ?? language.t("dialog.model.select.title")}</span>
              <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
            </Button>
          </TooltipKeybind>
        }
      >
        <TooltipKeybind
          placement="top"
          gutter={4}
          title={language.t("command.model.choose")}
          keybind={command.keybind("model.choose")}
        >
          <ModelSelectorPopover
            model={local.model}
            triggerAs={Button}
            triggerProps={{
              variant: "ghost",
              size: "normal",
              style: control(),
              class:
                "min-w-0 max-w-[220px] justify-start text-[13px] font-[440] leading-4 text-v2-text-text-faint group",
              "data-action": "prompt-model",
            }}
            onClose={restoreFocus}
          >
            <Show when={local.model.current()?.provider?.id}>
              <ProviderIcon
                id={local.model.current()?.provider?.id ?? ""}
                class="size-4 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity duration-150"
                style={{ "will-change": "opacity", transform: "translateZ(0)" }}
              />
            </Show>
            <span class="truncate">{local.model.current()?.name ?? language.t("dialog.model.select.title")}</span>
            <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
          </ModelSelectorPopover>
        </TooltipKeybind>
      </Show>
    </Show>
  )

  const newSession = () => props.variant === "new-session"
  const worktrees = createMemo(() => [MAIN_WORKTREE, ...(sync.project?.sandboxes ?? []), CREATE_WORKTREE])
  const currentWorktree = createMemo(() => {
    if (worktrees().includes(props.newSessionWorktree ?? MAIN_WORKTREE))
      return props.newSessionWorktree ?? MAIN_WORKTREE
    return MAIN_WORKTREE
  })
  const worktreeLabel = (value: string) => {
    if (value === MAIN_WORKTREE) return MAIN_WORKTREE
    if (value === CREATE_WORKTREE) return language.t("session.new.worktree.create")
    return getFilename(value)
  }

  return (
    <div class="relative size-full flex flex-col gap-0">
      {/* 260901 cc 同 session.tsx 那处：只为触发挂起、不渲染任何东西，但会一路挂到应用级
          Suspense 把整扇窗顶成 Splash。就地兜住，见那边的完整说明。 */}
      <Suspense>{(promptReady(), null)}</Suspense>
      <PromptPopover
        popover={store.popover}
        setSlashPopoverRef={(el) => (slashPopoverRef = el)}
        atFlat={atFlat()}
        atActive={atActive() ?? undefined}
        atKey={atKey}
        setAtActive={setAtActive}
        onAtSelect={handleAtSelect}
        slashFlat={slashFlat()}
        slashActive={slashActive() ?? undefined}
        setSlashActive={setSlashActive}
        onSlashSelect={handleSlashSelect}
        commandKeybind={command.keybind}
        t={(key) => language.t(key as Parameters<typeof language.t>[0])}
      />
      <DockShellForm
        data-component={newSession() ? "session-new-composer" : "session-composer"}
        onSubmit={handleSubmit}
        classList={{
          "group/prompt-input min-h-[96px] w-full rounded-xl bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]": true,
          "border-icon-info-active border-dashed": store.draggingType !== null,
          [props.class ?? ""]: !!props.class,
        }}
      >
        <PromptDragOverlay
          type={store.draggingType}
          label={language.t(store.draggingType === "@mention" ? "prompt.dropzone.file.label" : "prompt.dropzone.label")}
        />
        <PromptContextItems
          items={contextItems()}
          active={(item) => {
            const active = comments.active()
            return !!item.commentID && item.commentID === active?.id && item.path === active?.file
          }}
          openComment={openComment}
          remove={(item) => {
            if (item.commentID) comments.remove(item.path, item.commentID)
            prompt.context.remove(item.key)
          }}
          t={(key) => language.t(key as Parameters<typeof language.t>[0])}
        />
        <PromptImageAttachments
          attachments={imageAttachments()}
          onOpen={(attachment) =>
            dialog.show(() => {
              const imgs = imageAttachments().map((a) => ({ src: a.dataUrl, alt: a.filename }))
              const idx = imageAttachments().findIndex((a) => a.id === attachment.id)
              return <ImagePreview images={imgs} initialIndex={Math.max(0, idx)} />
            })
          }
          onRemove={removeAttachment}
          removeLabel={language.t("prompt.attachment.remove")}
        />
        <div
          class="relative min-h-[52px]"
          onMouseDown={(e) => {
            const target = e.target
            if (!(target instanceof HTMLElement)) return
            if (target.closest('[data-action="prompt-attach"], [data-action="prompt-submit"]')) return
            editorRef?.focus()
          }}
        >
          <div class="relative max-h-[180px] overflow-y-auto no-scrollbar" ref={(el) => (scrollRef = el)}>
            <div
              data-component="prompt-input"
              ref={(el) => {
                editorRef = el
                props.ref?.(el)
              }}
              role="textbox"
              aria-multiline="true"
              aria-label={designPlaceholder()}
              contenteditable="true"
              autocapitalize={store.mode === "normal" ? "sentences" : "off"}
              autocorrect={store.mode === "normal" ? "on" : "off"}
              spellcheck={store.mode === "normal"}
              inputMode="text"
              // @ts-expect-error
              autocomplete="off"
              onInput={handleInput}
              onPaste={handlePaste}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              classList={{
                "select-text": true,
                "min-h-[52px] w-full px-4 pt-4 pb-2 focus:outline-none whitespace-pre-wrap leading-5 text-[13px] font-[440] text-v2-text-text-faint [font-family:Inter,var(--font-family-sans)]": true,
                "[&_[data-type=file]]:text-syntax-property": true,
                "[&_[data-type=agent]]:text-syntax-type": true,
                "font-mono!": store.mode === "shell",
              }}
            />
            <div
              data-component={newSession() ? "session-new-design-text" : "session-composer-text"}
              class="absolute top-0 inset-x-0 px-4 pt-4 pointer-events-none whitespace-nowrap truncate leading-5 text-[13px] font-[440] text-v2-text-text-faint [font-family:Inter,var(--font-family-sans)]"
              classList={{ "font-mono!": store.mode === "shell", hidden: prompt.dirty() }}
            >
              {designPlaceholder()}
            </div>
          </div>
        </div>
        <div class="flex h-11 items-center px-2">
          <div class="flex min-w-0 flex-1 items-center gap-0">
            {fileAttachmentInput()}
            <TooltipKeybind
              placement="top"
              title={language.t("prompt.action.attachFile")}
              keybind={command.keybind("file.attach")}
            >
              <IconButton
                data-action="prompt-attach"
                type="button"
                icon="plus"
                variant="ghost"
                class="size-7 rounded-md p-[6px] text-v2-icon-icon-muted"
                style={buttons()}
                onClick={pick}
                disabled={store.mode !== "normal"}
                tabIndex={store.mode === "normal" ? undefined : -1}
                aria-label={language.t("prompt.action.attachFile")}
              />
            </TooltipKeybind>
            <Show when={newSession()}>
              <div class="relative">
                <div class="pointer-events-none absolute left-2 top-1/2 z-10 flex size-4 -translate-y-1/2 items-center justify-center">
                  <Icon name="sliders" size="small" />
                </div>
                <Select
                  size="normal"
                  options={worktrees()}
                  current={currentWorktree()}
                  label={worktreeLabel}
                  onSelect={(value) => {
                    if (value) props.onNewSessionWorktreeChange?.(value)
                    restoreFocus()
                  }}
                  class="max-w-[175px] justify-start text-text-base [&_[data-component=icon]]:text-v2-icon-icon-muted"
                  valueClass="truncate pl-5 text-[13px] font-[440] leading-4 text-v2-text-text-faint"
                  triggerStyle={control()}
                  triggerProps={{ "data-action": "prompt-workspace" }}
                  variant="ghost"
                />
              </div>
            </Show>
            {agentControl()}
            {modelControl()}
            {variantControl()}
            {/* 260819 cc 上下文窗口指示器紧跟模型/档位——与 timeline 顶栏那个是同一个组件，
                这里只是把它放到用户真正在看的位置（选模型的那一行）。组件自带
                <Show when={params.id}> 守卫，新建会话页没有 id 时整块不渲染。 */}
            <SessionContextUsage placement="top" />
          </div>
          <Tooltip placement="top" inactive={!working() && blank()} value={tip()}>
            <IconButton
              data-action="prompt-submit"
              type="submit"
              disabled={!working() && blank()}
              tabIndex={store.mode === "normal" ? undefined : -1}
              icon={stopping() ? "stop" : store.mode === "shell" ? "arrow-undo-down" : "arrow-up"}
              variant="primary"
              class="size-7 rounded-md p-[6px] text-v2-icon-icon-muted shadow-[var(--v2-elevation-button-contrast)] disabled:opacity-50"
              style={{
                "background-image":
                  "linear-gradient(180deg,var(--v2-alpha-light-20) 0%,var(--v2-alpha-light-0) 100%),linear-gradient(90deg,var(--v2-background-bg-contrast) 0%,var(--v2-background-bg-contrast) 100%)",
              }}
              aria-label={stopping() ? language.t("prompt.action.stop") : language.t("prompt.action.send")}
            />
          </Tooltip>
        </div>
        <PromptErrorBanner error={sendError} onRetry={handleSubmit} onDismiss={clearSendError} />
      </DockShellForm>
    </div>
  )
}

function PromptErrorBanner(props: {
  error: Accessor<string | null>
  onRetry: (e: Event) => void
  onDismiss: () => void
}) {
  return (
    <Show when={props.error()}>
      <div class="mx-2 mb-2 rounded-lg border border-border-warning-base bg-surface-warning-weak px-3 py-2 text-13-regular text-text-on-warning-strong">
        <div class="flex items-center gap-2">
          <span class="flex-1 truncate">{props.error()}</span>
          <button
            type="button"
            onClick={() => props.onRetry(new Event("submit"))}
            class="shrink-0 rounded px-2 py-0.5 text-13-medium text-text-on-warning-strong hover:bg-surface-warning-base active:bg-surface-warning-strong"
          >
            Retry
          </button>
          <button
            type="button"
            onClick={props.onDismiss}
            class="shrink-0 size-5 flex items-center justify-center rounded text-text-on-warning-strong hover:bg-surface-warning-base"
          >
            ×
          </button>
        </div>
      </div>
    </Show>
  )
}
