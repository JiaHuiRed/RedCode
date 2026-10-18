import { onMount } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { showToast } from "@redcode-ai/ui/toast"
import { usePrompt, type ContentPart, type ImageAttachmentPart, type Scope } from "@/context/prompt"
import { useLanguage } from "@/context/language"
import { uuid } from "@/utils/uuid"
import { getCursorPosition } from "./editor-dom"
import { attachmentFits, archiveFits, presentBudget, type PendingBudget } from "./attachment-budget"
import { attachmentMime, isArchiveFile, extName } from "./files"
import { normalizePaste, pasteMode } from "./paste"

function dataUrl(file: File, mime: string) {
  return new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.addEventListener("error", () => resolve(""))
    reader.addEventListener("load", () => {
      const value = typeof reader.result === "string" ? reader.result : ""
      const idx = value.indexOf(",")
      if (idx === -1) {
        resolve(value)
        return
      }
      resolve(`data:${mime};base64,${value.slice(idx + 1)}`)
    })
    reader.readAsDataURL(file)
  })
}

type PromptAttachmentsInput = {
  editor: () => HTMLDivElement | undefined
  isDialogActive: () => boolean
  setDraggingType: (type: "image" | "@mention" | null) => void
  focusEditor: () => void
  addPart: (part: ContentPart) => boolean
  readClipboardImage?: () => Promise<File | null>
  writeAttachment?: (sessionDir: string, filename: string, data: Uint8Array) => Promise<string>
  sessionDirectory?: string
  // 261018 Red 发起时的会话。附件要走 FileReader / arrayBuffer / IPC 落盘，完成时用户
  // 可能已经切到别的会话；写入必须回到发起时那一份 prompt，而不是「当前路由」的。
  scope?: () => Scope | undefined
}

// 261018 Red 拒绝原因结构化：批量入口原先只知道「一个都没成功」，于是不论真实原因是
// 超过 10 MiB、Web 端没有落盘通道还是 mime 不支持，都统一提示「不支持」。
export type AttachFailure = "size" | "unsupported" | "needs-desktop" | "read-failed"
type AttachResult = { ok: true } | { ok: false; reason: AttachFailure }
type AttachmentTarget = { scope: Scope | undefined; cursor: number | undefined }

export function createPromptAttachments(input: PromptAttachmentsInput) {
  return createPromptAttachmentsWithContext(input, usePrompt(), useLanguage())
}

export function createPromptAttachmentsWithContext(
  input: PromptAttachmentsInput,
  prompt: Pick<ReturnType<typeof usePrompt>, "current" | "cursor" | "set">,
  language: Pick<ReturnType<typeof useLanguage>, "t">,
) {
  const captureTarget = (): AttachmentTarget => ({
    scope: input.scope?.(),
    cursor: prompt.cursor(),
  })

  const warn = () => {
    showToast({
      title: language.t("prompt.toast.pasteUnsupported.title"),
      description: language.t("prompt.toast.pasteUnsupported.description"),
    })
  }

  const warnSize = () => {
    showToast({
      title: language.t("prompt.toast.attachmentTooLarge.title"),
      description: language.t("prompt.toast.attachmentTooLarge.description"),
    })
  }

  // 261011 Red 压缩包只能在桌面端用：它不作 base64 dataUrl（既不进 localStorage 也不进请求体，
  // 那是 OOM 风险面），只以磁盘路径存在，而落盘依赖 writeAttachment IPC——浏览器端没有。
  const warnArchiveNeedsDesktop = () => {
    showToast({
      title: language.t("prompt.toast.archiveNeedsDesktop.title"),
      description: language.t("prompt.toast.archiveNeedsDesktop.description"),
    })
  }

  // 260913 Red 正在读盘的附件先占额度：只看 prompt.current() 的话，同时粘贴的两个大文件
  // 互相看不见，会双双通过检查。pending 按 prompt scope 分桶，同项目的 A/B 会话不互占额度。
  // 261018 Red 合并成一条 PendingBudget：字节仍分两类，件数共享——见 attachment-budget.ts。
  const pendingBudget = new Map<string, PendingBudget>()
  // 261018 Red pending 是每个 prompt 的临时额度，不是整个项目共用；同目录的 A/B 会话也要隔离。
  const budgetKey = (scope: Scope | undefined) =>
    JSON.stringify([scope?.dir ?? input.sessionDirectory ?? "default", scope?.id ?? null])
  const budgetFor = (key: string): PendingBudget =>
    pendingBudget.get(key) ?? { inlineBytes: 0, archiveBytes: 0, count: 0 }
  const isArchivePart = (part: ImageAttachmentPart) => isArchiveFile({ name: part.filename ?? "", type: part.mime })

  const add = async (file: File, target: AttachmentTarget, toast = true): Promise<AttachResult> => {
    // scope 与光标在入口处一起定格；读 MIME、FileReader、arrayBuffer、IPC 落盘全是 await，
    // 完成时用户可能已经切到别的会话。此后所有读写都走发起时的 target。
    // 260913 Red 预算检查放在读内容和落盘之前：先读 10MB+ 再拒绝是白花的时间和内存。
    const archive = isArchiveFile(file)
    const key = budgetKey(target.scope)
    // existing 是所有附件（含压缩包）：件数用它数，字节只取对应类别——否则先加入的
    // 36 MiB 压缩包会被算进 20 MiB 的内联线，让同一组附件因添加顺序而结果不同。
    const existing = prompt.current(target.scope).filter((part): part is ImageAttachmentPart => part.type === "image")
    const budget = presentBudget(existing, isArchivePart)
    const fits = archive
      ? archiveFits(file.size, budget.archives, budget.count, budgetFor(key))
      : attachmentFits(file.size, budget.inline, budget.count, budgetFor(key))
    if (!fits) {
      if (toast) warnSize()
      return { ok: false, reason: "size" }
    }

    // 261018 Red 预占必须在第一个 await 之前。预算检查与预占之间只要隔着一个 await，
    // 并发的两次 add（拖放 + 粘贴是两条入口）就会各自读到同一份未占用额度，
    // 双双通过 8 件上限——这正是跨类别计数修完之后剩下的那个窗口。
    const reserved = budgetFor(key)
    pendingBudget.set(key, {
      inlineBytes: reserved.inlineBytes + (archive ? 0 : file.size),
      archiveBytes: reserved.archiveBytes + (archive ? file.size : 0),
      count: reserved.count + 1,
    })
    try {
      const mime = await attachmentMime(file)
      if (!mime) {
        if (toast) warn()
        return { ok: false, reason: "unsupported" }
      }

      // 261011 Red 压缩包分支：只落盘、不读内容。dataUrl 完全跳过（readAsDataURL 会把
      // 几十 MB 的包整个 base64 化，正是内存问题的形状）；没有落盘通道就拒绝，绝不静默降级
      // 成空 url 的坏 part。
      if (archive && !(input.sessionDirectory && input.writeAttachment)) {
        if (toast) warnArchiveNeedsDesktop()
        return { ok: false, reason: "needs-desktop" }
      }

      const editor = input.editor()
      if (!editor) return { ok: false, reason: "read-failed" }

      const url = archive ? "" : await dataUrl(file, mime)
      if (!archive && !url) return { ok: false, reason: "read-failed" }

      // 260629 Red: 落盘到 .attachments/，让 build-request-parts 走 file:// URL 而非 base64 dataUrl
      let attachmentPath: string | undefined
      if (input.sessionDirectory && input.writeAttachment) {
        // 261011 Red 压缩包用原始扩展名（归一化 mime 的子路径如 x-zip-compressed 当扩展名太丑），
        // 图片/PDF 维持既有的 mime 推导。
        const filename = archive
          ? `${uuid()}.${extName(file.name) || "zip"}`
          : `${uuid()}.${mime.split("/")[1]?.split("+")[0] || "bin"}`
        attachmentPath = await input.writeAttachment(
          input.sessionDirectory,
          filename,
          new Uint8Array(await file.arrayBuffer()),
        )
      }

      const attachment: ImageAttachmentPart = {
        type: "image",
        id: uuid(),
        filename: file.name,
        mime,
        dataUrl: url,
        size: file.size,
        path: attachmentPath,
      }
      const cursor = target.cursor ?? getCursorPosition(editor)
      prompt.set([...prompt.current(target.scope), attachment], cursor, target.scope)
      return { ok: true }
    } finally {
      // 260913 Red 预占之后的所有路径（含上面几个提前 return）都在这里释放，额度不会漏。
      const now = budgetFor(key)
      const next: PendingBudget = {
        inlineBytes: Math.max(0, now.inlineBytes - (archive ? 0 : file.size)),
        archiveBytes: Math.max(0, now.archiveBytes - (archive ? file.size : 0)),
        count: Math.max(0, now.count - 1),
      }
      if (next.inlineBytes === 0 && next.archiveBytes === 0 && next.count === 0) pendingBudget.delete(key)
      else pendingBudget.set(key, next)
    }
  }

  const addAttachment = async (file: File, target: AttachmentTarget) => (await add(file, target)).ok

  // 261018 Red 多文件失败时按「最有帮助的那条」提示，而不是一律说到底层的不支持：
  // 优先级按用户能据此调整动作的程度排（改小文件 > 换桌面端 > 换文件类型）。
  const FAILURE_PRIORITY: AttachFailure[] = ["size", "needs-desktop", "unsupported", "read-failed"]
  const pickReason = (current: AttachFailure | undefined, next: AttachFailure | undefined) => {
    if (!current) return next
    if (!next) return current
    return FAILURE_PRIORITY.indexOf(current) <= FAILURE_PRIORITY.indexOf(next) ? current : next
  }
  const warnFailure = (reason: AttachFailure) => {
    if (reason === "size") return warnSize()
    if (reason === "needs-desktop") return warnArchiveNeedsDesktop()
    return warn()
  }

  const addAttachmentsInScope = async (files: File[], target: AttachmentTarget, toast = true) => {
    let found = false
    let reason: AttachFailure | undefined

    for (const file of files) {
      const result = await add(file, target, false)
      if (result.ok) found = true
      else reason = pickReason(reason, result.reason)
    }

    if (!found && files.length > 0 && toast && reason) warnFailure(reason)
    return found
  }

  const addAttachments = async (files: File[], toast = true) =>
    addAttachmentsInScope(files, captureTarget(), toast)

  const removeAttachment = (id: string) => {
    const current = prompt.current()
    const next = current.filter((part) => part.type !== "image" || part.id !== id)
    prompt.set(next, prompt.cursor())
  }

  const handlePaste = async (event: ClipboardEvent) => {
    const clipboardData = event.clipboardData
    if (!clipboardData) return

    const target = captureTarget()
    event.preventDefault()
    event.stopPropagation()

    const files = Array.from(clipboardData.items).flatMap((item) => {
      if (item.kind !== "file") return []
      const file = item.getAsFile()
      return file ? [file] : []
    })

    if (files.length > 0) {
      await addAttachmentsInScope(files, target)
      return
    }

    const plainText = clipboardData.getData("text/plain") ?? ""

    // Desktop: Browser clipboard has no images and no text, try platform's native clipboard for images
    if (input.readClipboardImage && !plainText) {
      const file = await input.readClipboardImage()
      if (file) {
        await addAttachment(file, target)
        return
      }
    }

    if (!plainText) return

    const text = normalizePaste(plainText)

    const put = () => {
      if (input.addPart({ type: "text", content: text, start: 0, end: 0 })) return true
      input.focusEditor()
      return input.addPart({ type: "text", content: text, start: 0, end: 0 })
    }

    if (pasteMode(text) === "manual") {
      put()
      return
    }

    const inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, text)
    if (inserted) return

    put()
  }

  const handleGlobalDragOver = (event: DragEvent) => {
    if (input.isDialogActive()) return

    event.preventDefault()
    const hasFiles = event.dataTransfer?.types.includes("Files")
    const hasText = event.dataTransfer?.types.includes("text/plain")
    if (hasFiles) {
      input.setDraggingType("image")
    } else if (hasText) {
      input.setDraggingType("@mention")
    }
  }

  const handleGlobalDragLeave = (event: DragEvent) => {
    if (input.isDialogActive()) return
    if (!event.relatedTarget) {
      input.setDraggingType(null)
    }
  }

  const handleGlobalDrop = async (event: DragEvent) => {
    if (input.isDialogActive()) return

    event.preventDefault()
    input.setDraggingType(null)

    const plainText = event.dataTransfer?.getData("text/plain")
    const filePrefix = "file:"
    if (plainText?.startsWith(filePrefix)) {
      const filePath = plainText.slice(filePrefix.length)
      input.focusEditor()
      input.addPart({ type: "file", path: filePath, content: "@" + filePath, start: 0, end: 0 })
      return
    }

    const dropped = event.dataTransfer?.files
    if (!dropped) return

    await addAttachments(Array.from(dropped))
  }

  onMount(() => {
    makeEventListener(document, "dragover", handleGlobalDragOver)
    makeEventListener(document, "dragleave", handleGlobalDragLeave)
    makeEventListener(document, "drop", handleGlobalDrop)
  })

  return {
    addAttachment,
    addAttachments,
    removeAttachment,
    handlePaste,
  }
}
