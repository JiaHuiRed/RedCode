import type { Prompt } from "@/context/prompt"
import type { SelectedLineRange } from "@/context/file"

const DEFAULT_PROMPT: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]

export const MAX_HISTORY = 100

export type PromptHistoryComment = {
  id: string
  path: string
  selection: SelectedLineRange
  comment: string
  time: number
  origin?: "review" | "file"
  preview?: string
}

export type PromptHistoryEntry = {
  prompt: Prompt
  comments: PromptHistoryComment[]
}

export type PromptHistoryStoredEntry = Prompt | PromptHistoryEntry

/**
 * 历史记录落盘前剔掉 image part。
 *
 * 260901 cc 这是草稿那条（context/prompt.tsx:167 serializePromptStore，注释写着「贴图后
 * 打字卡顿的根因」）漏掉的另一半：草稿修了，历史没修。而历史比草稿严重得多——草稿在
 * 每个工作区自己的文件里（实测都 ≤6KB），历史在 **Persist.global 共用的 RedCode.global.dat**。
 *
 * 他机器上实测的构成：
 *     RedCode.global.dat 2.64MB
 *       prompt-history      2678KB  98.9%   ← 30 张 base64 PNG + 1 个 base64 PDF
 *       command.catalog.v1    10KB
 *       layout                 9KB   ← 拖分栏条改的就是这个
 *       model / layout.page / server / notification 合计 ~11KB
 *
 * electron-store 底下的 conf 是「一个 name 一个 JSON 文件」，而且 get 和 set **都**要
 * readFileSync 整个文件 + JSON.parse（set 还要再 stringify + 原子写）。所以这 2.6MB 的
 * 陈年图片给**每一次全局持久化读写**都加了一个常数：改侧栏宽度、切模型、写命令目录，
 * 全都要把它连读带写过一遍，而且是在 **Electron 主进程**上同步做——主进程一卡，
 * 标题栏拖动、菜单、所有 IPC 一起卡，这也是为什么在渲染进程抓 CPU profile 只看得到 idle。
 *
 * 代价与草稿那条一致：重开应用后历史只保留文字，图片不保留。
 * mime 是 application/pdf 的附件也走 type: "image"（ImageAttachmentPart 带 mime 字段），
 * 一起剔掉。
 */
function stripHistoryPrompt(prompt: unknown): unknown {
  if (!Array.isArray(prompt)) return prompt
  return prompt.filter((part) => (part as { type?: unknown } | null)?.type !== "image")
}

/** 剔完只剩空文本的条目直接丢掉——那是「只发了一张图」的记录，没有可回溯的内容。 */
function isEmptyStoredPrompt(prompt: unknown) {
  if (!Array.isArray(prompt)) return false
  return prompt.every((part) => {
    const item = part as { type?: unknown; content?: unknown } | null
    return item?.type === "text" && typeof item.content === "string" && item.content.trim() === ""
  })
}

function stripHistoryEntry(entry: unknown): unknown {
  if (Array.isArray(entry)) return stripHistoryPrompt(entry)
  if (entry && typeof entry === "object" && "prompt" in entry) {
    const item = entry as { prompt: unknown }
    return { ...item, prompt: stripHistoryPrompt(item.prompt) }
  }
  return entry
}

function entryPrompt(entry: unknown): unknown {
  if (Array.isArray(entry)) return entry
  if (entry && typeof entry === "object" && "prompt" in entry) return (entry as { prompt: unknown }).prompt
  return undefined
}

/**
 * 同时用于 persist 的 `migrate`（读路径）与 `serialize`（写路径）。
 *
 * 两个都要挂：`serialize` 只管以后别再写进去，存量那 2.6MB 得靠 `migrate` 才会缩——
 * persist.ts:207-213 的 normalize() 用的是裸 JSON.stringify，读进来什么样就写回去什么样，
 * 而 readCurrent（persist.ts:221-228）在 migrate 改变了内容时会 setItem 回盘，
 * 所以挂上 migrate 后**下次启动读到它就地瘦身**，不需要额外的一次性清理脚本。
 */
export function stripPromptHistoryImages(value: unknown): unknown {
  const store = value as { entries?: unknown } | null
  if (!store || typeof store !== "object" || !Array.isArray(store.entries)) return value
  const entries = store.entries.map(stripHistoryEntry).filter((entry) => !isEmptyStoredPrompt(entryPrompt(entry)))
  return { ...store, entries }
}

export function serializePromptHistory(value: unknown) {
  return JSON.stringify(stripPromptHistoryImages(value))
}

export function canNavigateHistoryAtCursor(direction: "up" | "down", text: string, cursor: number, inHistory = false) {
  const position = Math.max(0, Math.min(cursor, text.length))
  const atStart = position === 0
  const atEnd = position === text.length
  if (inHistory) return atStart || atEnd
  if (direction === "up") return position === 0 && text.length === 0
  return position === text.length
}

export function clonePromptParts(prompt: Prompt): Prompt {
  return prompt.map((part) => {
    if (part.type === "text") return { ...part }
    if (part.type === "image") return { ...part }
    if (part.type === "agent") return { ...part }
    return {
      ...part,
      selection: part.selection ? { ...part.selection } : undefined,
    }
  })
}

function cloneSelection(selection: SelectedLineRange): SelectedLineRange {
  return {
    start: selection.start,
    end: selection.end,
    ...(selection.side ? { side: selection.side } : {}),
    ...(selection.endSide ? { endSide: selection.endSide } : {}),
  }
}

export function clonePromptHistoryComments(comments: PromptHistoryComment[]) {
  return comments.map((comment) => ({
    ...comment,
    selection: cloneSelection(comment.selection),
  }))
}

export function normalizePromptHistoryEntry(entry: PromptHistoryStoredEntry): PromptHistoryEntry {
  if (Array.isArray(entry)) {
    return {
      prompt: clonePromptParts(entry),
      comments: [],
    }
  }
  return {
    prompt: clonePromptParts(entry.prompt),
    comments: clonePromptHistoryComments(entry.comments),
  }
}

export function promptLength(prompt: Prompt) {
  return prompt.reduce((len, part) => len + ("content" in part ? part.content.length : 0), 0)
}

export function prependHistoryEntry(
  entries: PromptHistoryStoredEntry[],
  prompt: Prompt,
  comments: PromptHistoryComment[] = [],
  max = MAX_HISTORY,
) {
  const text = prompt
    .map((part) => ("content" in part ? part.content : ""))
    .join("")
    .trim()
  const hasImages = prompt.some((part) => part.type === "image")
  const hasComments = comments.some((comment) => !!comment.comment.trim())
  if (!text && !hasImages && !hasComments) return entries

  const entry = {
    prompt: clonePromptParts(prompt),
    comments: clonePromptHistoryComments(comments),
  } satisfies PromptHistoryEntry
  const last = entries[0]
  if (last && isPromptEqual(last, entry)) return entries
  return [entry, ...entries].slice(0, max)
}

function isCommentEqual(commentA: PromptHistoryComment, commentB: PromptHistoryComment) {
  return (
    commentA.path === commentB.path &&
    commentA.comment === commentB.comment &&
    commentA.origin === commentB.origin &&
    commentA.preview === commentB.preview &&
    commentA.selection.start === commentB.selection.start &&
    commentA.selection.end === commentB.selection.end &&
    commentA.selection.side === commentB.selection.side &&
    commentA.selection.endSide === commentB.selection.endSide
  )
}

function isPromptEqual(promptA: PromptHistoryStoredEntry, promptB: PromptHistoryStoredEntry) {
  const entryA = normalizePromptHistoryEntry(promptA)
  const entryB = normalizePromptHistoryEntry(promptB)
  if (entryA.prompt.length !== entryB.prompt.length) return false
  for (let i = 0; i < entryA.prompt.length; i++) {
    const partA = entryA.prompt[i]
    const partB = entryB.prompt[i]
    if (partA.type !== partB.type) return false
    if (partA.type === "text" && partA.content !== (partB.type === "text" ? partB.content : "")) return false
    if (partA.type === "file") {
      if (partA.path !== (partB.type === "file" ? partB.path : "")) return false
      const a = partA.selection
      const b = partB.type === "file" ? partB.selection : undefined
      const sameSelection =
        (!a && !b) ||
        (!!a &&
          !!b &&
          a.startLine === b.startLine &&
          a.startChar === b.startChar &&
          a.endLine === b.endLine &&
          a.endChar === b.endChar)
      if (!sameSelection) return false
    }
    if (partA.type === "agent" && partA.name !== (partB.type === "agent" ? partB.name : "")) return false
    if (partA.type === "image" && partA.id !== (partB.type === "image" ? partB.id : "")) return false
  }
  if (entryA.comments.length !== entryB.comments.length) return false
  for (let i = 0; i < entryA.comments.length; i++) {
    const commentA = entryA.comments[i]
    const commentB = entryB.comments[i]
    if (!commentA || !commentB || !isCommentEqual(commentA, commentB)) return false
  }
  return true
}

type HistoryNavInput = {
  direction: "up" | "down"
  entries: PromptHistoryStoredEntry[]
  historyIndex: number
  currentPrompt: Prompt
  currentComments: PromptHistoryComment[]
  savedPrompt: PromptHistoryEntry | null
}

type HistoryNavResult =
  | {
      handled: false
      historyIndex: number
      savedPrompt: PromptHistoryEntry | null
    }
  | {
      handled: true
      historyIndex: number
      savedPrompt: PromptHistoryEntry | null
      entry: PromptHistoryEntry
      cursor: "start" | "end"
    }

export function navigatePromptHistory(input: HistoryNavInput): HistoryNavResult {
  if (input.direction === "up") {
    if (input.entries.length === 0) {
      return {
        handled: false,
        historyIndex: input.historyIndex,
        savedPrompt: input.savedPrompt,
      }
    }

    if (input.historyIndex === -1) {
      const entry = normalizePromptHistoryEntry(input.entries[0])
      return {
        handled: true,
        historyIndex: 0,
        savedPrompt: {
          prompt: clonePromptParts(input.currentPrompt),
          comments: clonePromptHistoryComments(input.currentComments),
        },
        entry,
        cursor: "start",
      }
    }

    if (input.historyIndex < input.entries.length - 1) {
      const next = input.historyIndex + 1
      const entry = normalizePromptHistoryEntry(input.entries[next])
      return {
        handled: true,
        historyIndex: next,
        savedPrompt: input.savedPrompt,
        entry,
        cursor: "start",
      }
    }

    return {
      handled: false,
      historyIndex: input.historyIndex,
      savedPrompt: input.savedPrompt,
    }
  }

  if (input.historyIndex > 0) {
    const next = input.historyIndex - 1
    const entry = normalizePromptHistoryEntry(input.entries[next])
    return {
      handled: true,
      historyIndex: next,
      savedPrompt: input.savedPrompt,
      entry,
      cursor: "end",
    }
  }

  if (input.historyIndex === 0) {
    if (input.savedPrompt) {
      return {
        handled: true,
        historyIndex: -1,
        savedPrompt: null,
        entry: input.savedPrompt,
        cursor: "end",
      }
    }

    return {
      handled: true,
      historyIndex: -1,
      savedPrompt: null,
      entry: {
        prompt: DEFAULT_PROMPT,
        comments: [],
      },
      cursor: "end",
    }
  }

  return {
    handled: false,
    historyIndex: input.historyIndex,
    savedPrompt: input.savedPrompt,
  }
}
