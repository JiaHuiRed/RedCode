import { onMount } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { showToast } from "@redcode-ai/ui/toast"
import { usePrompt, type ContentPart, type ImageAttachmentPart } from "@/context/prompt"
import { useLanguage } from "@/context/language"
import { uuid } from "@/utils/uuid"
import { getCursorPosition } from "./editor-dom"
import { attachmentFits } from "./attachment-budget"
import { attachmentMime } from "./files"
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
}

export function createPromptAttachments(input: PromptAttachmentsInput) {
  const prompt = usePrompt()
  const language = useLanguage()

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

  // 260913 Red 正在读盘的附件先占额度：只看 prompt.current() 的话，同时粘贴的两个大文件
  // 互相看不见，会双双通过检查。key 取会话目录，跨会话不共享额度。
  const pendingBudget = new Map<string, { bytes: number; count: number }>()
  const budgetKey = () => input.sessionDirectory ?? "default"
  const budgetFor = (key: string) => pendingBudget.get(key) ?? { bytes: 0, count: 0 }

  const add = async (file: File, toast = true) => {
    // 260913 Red 预算检查放在读内容和落盘之前：先读 10MB+ 再拒绝是白花的时间和内存。
    const key = budgetKey()
    const existing = prompt.current().filter((part): part is ImageAttachmentPart => part.type === "image")
    if (!attachmentFits(file.size, existing, budgetFor(key))) {
      if (toast) warnSize()
      return false
    }

    const mime = await attachmentMime(file)
    if (!mime) {
      if (toast) warn()
      return false
    }

    const editor = input.editor()
    if (!editor) return false

    const pending = budgetFor(key)
    pendingBudget.set(key, { bytes: pending.bytes + file.size, count: pending.count + 1 })
    try {
      const url = await dataUrl(file, mime)
      if (!url) return false

      // 260629 Red: 落盘到 .attachments/，让 build-request-parts 走 file:// URL 而非 base64 dataUrl
      let attachmentPath: string | undefined
      if (input.sessionDirectory && input.writeAttachment) {
        const ext = mime.split("/")[1]?.split("+")[0] || "bin"
        const filename = `${uuid()}.${ext}`
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
      const cursor = prompt.cursor() ?? getCursorPosition(editor)
      prompt.set([...prompt.current(), attachment], cursor)
      return true
    } finally {
      // 260913 Red 只在真的占过额度之后才释放；提前 return 的路径不会走到这里。
      const now = budgetFor(key)
      const next = { bytes: Math.max(0, now.bytes - file.size), count: Math.max(0, now.count - 1) }
      if (next.bytes === 0 && next.count === 0) pendingBudget.delete(key)
      else pendingBudget.set(key, next)
    }
  }

  const addAttachment = (file: File) => add(file)

  const addAttachments = async (files: File[], toast = true) => {
    let found = false

    for (const file of files) {
      const ok = await add(file, false)
      if (ok) found = true
    }

    if (!found && files.length > 0 && toast) warn()
    return found
  }

  const removeAttachment = (id: string) => {
    const current = prompt.current()
    const next = current.filter((part) => part.type !== "image" || part.id !== id)
    prompt.set(next, prompt.cursor())
  }

  const handlePaste = async (event: ClipboardEvent) => {
    const clipboardData = event.clipboardData
    if (!clipboardData) return

    event.preventDefault()
    event.stopPropagation()

    const files = Array.from(clipboardData.items).flatMap((item) => {
      if (item.kind !== "file") return []
      const file = item.getAsFile()
      return file ? [file] : []
    })

    if (files.length > 0) {
      await addAttachments(files)
      return
    }

    const plainText = clipboardData.getData("text/plain") ?? ""

    // Desktop: Browser clipboard has no images and no text, try platform's native clipboard for images
    if (input.readClipboardImage && !plainText) {
      const file = await input.readClipboardImage()
      if (file) {
        await addAttachment(file)
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
