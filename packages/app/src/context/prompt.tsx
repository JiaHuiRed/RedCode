import { createSimpleContext } from "@redcode-ai/ui/context"
import { showToast } from "@redcode-ai/ui/toast"
import { checksum } from "@redcode-ai/core/util/encode"
import { useParams } from "@solidjs/router"
import { batch, createEffect, createMemo, createRoot, getOwner, onCleanup, untrack } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
import type { FileSelection } from "@/context/file"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import {
  mergePromptImages,
  migratePromptImages,
  samePromptImages,
  serializePromptStore,
  splitPromptImages,
} from "./prompt-persistence"

interface PartBase {
  content: string
  start: number
  end: number
}

export interface TextPart extends PartBase {
  type: "text"
}

export interface FileAttachmentPart extends PartBase {
  type: "file"
  path: string
  selection?: FileSelection
}

export interface AgentPart extends PartBase {
  type: "agent"
  name: string
}

export interface ImageAttachmentPart {
  type: "image"
  id: string
  filename: string
  mime: string
  dataUrl: string
  // 260913 Red 原始字节数：预算核算用它，别再从 dataUrl 反推（base64 换算有误差）。
  size?: number
  path?: string
}

export type ContentPart = TextPart | FileAttachmentPart | AgentPart | ImageAttachmentPart
export type Prompt = ContentPart[]

export type FileContextItem = {
  type: "file"
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

export type ContextItem = FileContextItem

export const DEFAULT_PROMPT: Prompt = [{ type: "text", content: "", start: 0, end: 0 }]

function isSelectionEqual(a?: FileSelection, b?: FileSelection) {
  if (!a && !b) return true
  if (!a || !b) return false
  return (
    a.startLine === b.startLine && a.startChar === b.startChar && a.endLine === b.endLine && a.endChar === b.endChar
  )
}

function isPartEqual(partA: ContentPart, partB: ContentPart) {
  switch (partA.type) {
    case "text":
      return partB.type === "text" && partA.content === partB.content
    case "file":
      return partB.type === "file" && partA.path === partB.path && isSelectionEqual(partA.selection, partB.selection)
    case "agent":
      return partB.type === "agent" && partA.name === partB.name
    case "image":
      return partB.type === "image" && partA.id === partB.id
  }
}

export function isPromptEqual(promptA: Prompt, promptB: Prompt): boolean {
  if (promptA.length !== promptB.length) return false
  for (let i = 0; i < promptA.length; i++) {
    if (!isPartEqual(promptA[i], promptB[i])) return false
  }
  return true
}

function cloneSelection(selection?: FileSelection) {
  if (!selection) return undefined
  return { ...selection }
}

function clonePart(part: ContentPart): ContentPart {
  if (part.type === "text") return { ...part }
  if (part.type === "image") return { ...part }
  if (part.type === "agent") return { ...part }
  return {
    ...part,
    selection: cloneSelection(part.selection),
  }
}

function clonePrompt(prompt: Prompt): Prompt {
  return prompt.map(clonePart)
}

function contextItemKey(item: ContextItem) {
  if (item.type !== "file") return item.type
  const start = item.selection?.startLine
  const end = item.selection?.endLine
  const key = `${item.type}:${item.path}:${start}:${end}`

  if (item.commentID) {
    return `${key}:c=${item.commentID}`
  }

  const comment = item.comment?.trim()
  if (!comment) return key
  const digest = checksum(comment) ?? comment
  return `${key}:c=${digest.slice(0, 8)}`
}

function isCommentItem(item: ContextItem | (ContextItem & { key: string })) {
  return item.type === "file" && !!item.comment?.trim()
}

function createPromptActions(
  setStore: SetStoreFunction<{
    prompt: Prompt
    cursor?: number
    context: {
      items: (ContextItem & { key: string })[]
    }
  }>,
) {
  return {
    set(prompt: Prompt, cursorPosition?: number) {
      const next = clonePrompt(prompt)
      batch(() => {
        setStore("prompt", next)
        if (cursorPosition !== undefined) setStore("cursor", cursorPosition)
      })
    },
    reset() {
      batch(() => {
        setStore("prompt", clonePrompt(DEFAULT_PROMPT))
        setStore("cursor", 0)
      })
    },
  }
}

const WORKSPACE_KEY = "__workspace__"
const MAX_PROMPT_SESSIONS = 20

type PromptSession = ReturnType<typeof createPromptSession>

export type Scope = {
  // 260915 Red 必须传路由 `:dir` 段同一形态的值（base64Encode 后的目录），不是原始
  // 文件路径——缓存键直接用 params.dir 拼（见下方 load()），形态不一致会静默落到
  // 另一个条目上（事故：d522c4b8 传原始路径，发送后输入框"复活"已发消息）。
  dir: string
  id?: string
}

type PromptCacheEntry = {
  value: PromptSession
  dispose: VoidFunction
}

// 260913 Red 草稿配额满只提示一次，避免每次按键重复弹 toast。
let storageWarned = false

function createPromptSession(dir: string, id: string | undefined) {
  const legacy = `${dir}/prompt${id ? "/" + id : ""}.v2`
  const language = useLanguage()
  const target = Persist.scoped(dir, id, "prompt", [legacy])
  const onQuota = () => {
    if (storageWarned) return
    storageWarned = true
    showToast({
      title: language.t("prompt.toast.draftStorageFull.title"),
      description: language.t("prompt.toast.draftStorageFull.description"),
    })
  }

  const [store, setStore, _, promptReady] = persisted(
    {
      ...target,
      serialize: serializePromptStore,
      // 260913 Red 草稿可能很大，配额满时不允许删除 settings/layout 等其它 RedCode.* 键。
      evictOnQuota: false,
      onQuota,
    },
    createStore<{
      prompt: Prompt
      cursor?: number
      context: {
        items: (ContextItem & { key: string })[]
      }
    }>({
      prompt: clonePrompt(DEFAULT_PROMPT),
      cursor: undefined,
      context: {
        items: [],
      },
    }),
  )
  // 260927 Red 草稿文字与图片分开落盘：dataUrl 只在附件增删时写入媒体 store，不随每次按键重复序列化。
  const [media, setMedia, __, mediaReady] = persisted(
    {
      ...Persist.media(`prompt:${target.storage ?? "default"}:${target.key}:images.v1`),
      evictOnQuota: false,
      onQuota,
    },
    createStore<{ attachments: ImageAttachmentPart[] }>({ attachments: [] }),
  )

  createEffect(() => {
    if (!promptReady() || !mediaReady()) return
    untrack(() => {
      const migration = migratePromptImages(store.prompt, media.attachments)
      if (!migration.changed) return
      batch(() => {
        if (!samePromptImages(media.attachments, migration.images)) {
          setMedia(
            "attachments",
            migration.images.map((image) => ({ ...image })),
          )
        }
        setStore("prompt", migration.text)
      })
    })
  })

  const actions = createPromptActions(setStore)
  const readyPromises = [promptReady.promise, mediaReady.promise].filter(
    (promise): promise is Promise<unknown> => promise !== undefined,
  )
  const readyPromise = readyPromises.length ? Promise.all(readyPromises) : undefined
  const ready = Object.defineProperty(() => promptReady() && mediaReady(), "promise", {
    get: () => readyPromise,
  }) as (() => boolean) & { readonly promise: Promise<unknown> | undefined }
  const set = (prompt: Prompt, cursorPosition?: number) => {
    const split = splitPromptImages(prompt)
    batch(() => {
      if (!samePromptImages(media.attachments, split.images)) {
        setMedia(
          "attachments",
          split.images.map((image) => ({ ...image })),
        )
      }
      actions.set(split.text, cursorPosition)
    })
  }
  const reset = () => {
    batch(() => {
      if (media.attachments.length > 0) setMedia("attachments", [])
      actions.reset()
    })
  }
  const current = createMemo(() => mergePromptImages(store.prompt, media.attachments))

  return {
    ready,
    current,
    cursor: createMemo(() => store.cursor),
    dirty: () => !isPromptEqual(current(), DEFAULT_PROMPT),
    context: {
      items: createMemo(() => store.context.items),
      add(item: ContextItem) {
        const key = contextItemKey(item)
        if (store.context.items.find((x) => x.key === key)) return
        setStore("context", "items", (items) => [...items, { key, ...item }])
      },
      remove(key: string) {
        setStore("context", "items", (items) => items.filter((x) => x.key !== key))
      },
      removeComment(path: string, commentID: string) {
        setStore("context", "items", (items) =>
          items.filter((item) => !(item.type === "file" && item.path === path && item.commentID === commentID)),
        )
      },
      updateComment(path: string, commentID: string, next: Partial<FileContextItem> & { comment?: string }) {
        setStore("context", "items", (items) =>
          items.map((item) => {
            if (item.type !== "file" || item.path !== path || item.commentID !== commentID) return item
            const value = { ...item, ...next }
            return { ...value, key: contextItemKey(value) }
          }),
        )
      },
      replaceComments(items: FileContextItem[]) {
        setStore("context", "items", (current) => [
          ...current.filter((item) => !isCommentItem(item)),
          ...items.map((item) => ({ ...item, key: contextItemKey(item) })),
        ])
      },
    },
    set,
    reset,
  }
}

export const { use: usePrompt, provider: PromptProvider } = createSimpleContext({
  name: "Prompt",
  gate: false,
  init: () => {
    const params = useParams()
    const cache = new Map<string, PromptCacheEntry>()

    const disposeAll = () => {
      for (const entry of cache.values()) {
        entry.dispose()
      }
      cache.clear()
    }

    onCleanup(disposeAll)

    const prune = () => {
      while (cache.size > MAX_PROMPT_SESSIONS) {
        const first = cache.keys().next().value
        if (!first) return
        const entry = cache.get(first)
        entry?.dispose()
        cache.delete(first)
      }
    }

    const owner = getOwner()
    const load = (dir: string, id: string | undefined) => {
      const key = `${dir}:${id ?? WORKSPACE_KEY}`
      const existing = cache.get(key)
      if (existing) {
        cache.delete(key)
        cache.set(key, existing)
        return existing.value
      }

      const entry = createRoot(
        (dispose) => ({
          value: createPromptSession(dir, id),
          dispose,
        }),
        owner,
      )

      cache.set(key, entry)
      prune()
      return entry.value
    }

    const session = createMemo(() => load(params.dir!, params.id))
    const pick = (scope?: Scope) => (scope ? load(scope.dir, scope.id) : session())
    // 旧写法 `ready: () => session().ready` 返回的是 ready 函数对象本身（恒 truthy），
    // 所有 `prompt.ready()` 门禁形同虚设；改成真调用，.promise 走属性透传（上游 #33528 同款）
    const ready = Object.defineProperty(() => session().ready(), "promise", {
      get: () => session().ready.promise,
    }) as (() => boolean) & { readonly promise: Promise<unknown> | undefined }

    return {
      ready,
      // 261003 Red 支持按 scope 读草稿：undo/redo/revert/restore 的迟到写入要用
      // 「发起时快照 vs 返回时内容」判断等待期用户是否已输入，避免覆盖新内容。
      current: (scope?: Scope) => pick(scope).current(),
      cursor: () => session().cursor(),
      // 260913 Red 支持按 scope 查询草稿是否为空：异步失败要恢复草稿时得先确认目标会话
      // 没有被用户重新输入过，否则会把新内容覆盖掉。
      dirty: (scope?: Scope) => pick(scope).dirty(),
      context: {
        items: () => session().context.items(),
        add: (item: ContextItem) => session().context.add(item),
        remove: (key: string) => session().context.remove(key),
        removeComment: (path: string, commentID: string) => session().context.removeComment(path, commentID),
        updateComment: (path: string, commentID: string, next: Partial<FileContextItem> & { comment?: string }) =>
          session().context.updateComment(path, commentID, next),
        replaceComments: (items: FileContextItem[]) => session().context.replaceComments(items),
      },
      set: (prompt: Prompt, cursorPosition?: number, scope?: Scope) => pick(scope).set(prompt, cursorPosition),
      reset: (scope?: Scope) => pick(scope).reset(),
    }
  },
})
