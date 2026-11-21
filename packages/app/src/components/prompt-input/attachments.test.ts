import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { ContentPart, Prompt, Scope } from "@/context/prompt"
import { attachmentMime, isArchiveFile } from "./files"
import { pasteMode } from "./paste"
import { createPromptAttachmentsWithContext } from "./attachments"

const scopeKey = (scope?: Scope) => (scope ? `${scope.dir}:${scope.id ?? ""}` : "current")

function mountAttachmentActions(input: {
  scope: () => Scope | undefined
  writeAttachment: (sessionDir: string, filename: string, data: Uint8Array) => Promise<string>
  readClipboardImage?: () => Promise<File | null>
  onTranslate?: (key: string) => void
  addPart?: (part: ContentPart) => boolean
}) {
  const editor = document.createElement("div")
  editor.contentEditable = "true"
  document.body.appendChild(editor)

  const stores = new Map<string, Prompt>()
  const prompt = {
    current: (scope?: Scope) => stores.get(scopeKey(scope)) ?? [],
    cursor: () => 0,
    set: (value: Prompt, _cursor?: number, scope?: Scope) => stores.set(scopeKey(scope), value),
  }
  const language = {
    t: (key: string | number) => {
      input.onTranslate?.(String(key))
      return String(key)
    },
  }

  const mounted = createRoot((dispose) => ({
    actions: createPromptAttachmentsWithContext(
      {
        editor: () => editor,
        isDialogActive: () => false,
        setDraggingType: () => undefined,
        focusEditor: () => undefined,
        addPart: input.addPart ?? (() => false),
        sessionDirectory: "/repo",
        scope: input.scope,
        writeAttachment: input.writeAttachment,
        readClipboardImage: input.readClipboardImage,
      },
      prompt,
      language,
    ),
    dispose,
  }))

  return { ...mounted, editor, stores }
}

function archive(name: string) {
  return new File([Uint8Array.of(0x50, 0x4b, 0, 0)], name, { type: "application/zip" })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("attachmentMime", () => {
  test("keeps PDFs when the browser reports the mime", async () => {
    const file = new File(["%PDF-1.7"], "guide.pdf", { type: "application/pdf" })
    expect(await attachmentMime(file)).toBe("application/pdf")
  })

  test("normalizes structured text types to text/plain", async () => {
    const file = new File(['{"ok":true}\n'], "data.json", { type: "application/json" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("accepts text files even with a misleading browser mime", async () => {
    const file = new File(["export const x = 1\n"], "main.ts", { type: "video/mp2t" })
    expect(await attachmentMime(file)).toBe("text/plain")
  })

  test("rejects binary files", async () => {
    const file = new File([Uint8Array.of(0, 255, 1, 2)], "blob.bin", { type: "application/octet-stream" })
    expect(await attachmentMime(file)).toBeUndefined()
  })

  // 261011 Red 压缩包放行：mime 命中、Windows 变体 mime 命中、仅扩展名命中三条路都要通
  test("accepts archives by mime", async () => {
    const file = new File([Uint8Array.of(0x50, 0x4b, 0, 0)], "bundle.zip", { type: "application/zip" })
    expect(await attachmentMime(file)).toBe("application/zip")
  })

  test("accepts archives with the Windows explorer mime variant", async () => {
    const file = new File([Uint8Array.of(0x50, 0x4b, 0, 0)], "bundle.zip", {
      type: "application/x-zip-compressed",
    })
    expect(await attachmentMime(file)).toBe("application/x-zip-compressed")
  })

  test("accepts archives by extension when mime is generic", async () => {
    const file = new File([Uint8Array.of(0, 1, 2, 3)], "backup.7z", { type: "application/octet-stream" })
    expect(await attachmentMime(file)).toBe("application/x-7z-compressed")
  })

  test("normalizes archive extension aliases to canonical mime", async () => {
    expect(await attachmentMime(new File([new Uint8Array(4)], "x.tgz", { type: "" }))).toBe("application/gzip")
    expect(await attachmentMime(new File([new Uint8Array(4)], "x.tar", { type: "" }))).toBe("application/x-tar")
    expect(await attachmentMime(new File([new Uint8Array(4)], "x.rar", { type: "" }))).toBe("application/vnd.rar")
  })

  test("isArchiveFile matches both mime and extension paths", () => {
    expect(isArchiveFile({ name: "a.zip", type: "" })).toBe(true)
    expect(isArchiveFile({ name: "a", type: "application/zip" })).toBe(true)
    expect(isArchiveFile({ name: "a.bin", type: "application/octet-stream" })).toBe(false)
  })
})

describe("pasteMode", () => {
  test("uses native paste for short single-line text", () => {
    expect(pasteMode("hello world")).toBe("native")
  })

  test("uses manual paste for multiline text", () => {
    expect(
      pasteMode(`{
  "ok": true
}`),
    ).toBe("manual")
    expect(pasteMode("a\r\nb")).toBe("manual")
  })

  test("uses manual paste for large text", () => {
    expect(pasteMode("x".repeat(8000))).toBe("manual")
  })
})

describe("attachment prompt scope", () => {
  test("keeps every file in a batch on the scope captured before the first async write", async () => {
    const scopeA = { dir: "repo", id: "session-a" }
    const scopeB = { dir: "repo", id: "session-b" }
    let activeScope = scopeA
    const firstWriteStarted = deferred<void>()
    const releaseFirstWrite = deferred<void>()
    let writes = 0
    const mounted = mountAttachmentActions({
      scope: () => activeScope,
      writeAttachment: async (directory, filename) => {
        writes += 1
        if (writes === 1) {
          firstWriteStarted.resolve()
          await releaseFirstWrite.promise
        }
        return `${directory}/${filename}`
      },
    })

    try {
      const batch = mounted.actions.addAttachments([archive("first.zip"), archive("second.zip")])
      await firstWriteStarted.promise
      activeScope = scopeB
      releaseFirstWrite.resolve()
      expect(await batch).toBe(true)

      expect(mounted.stores.get(scopeKey(scopeA))?.map((part) => part.type === "image" && part.filename)).toEqual([
        "first.zip",
        "second.zip",
      ])
      expect(mounted.stores.has(scopeKey(scopeB))).toBe(false)
    } finally {
      mounted.dispose()
      mounted.editor.remove()
    }
  })

  test("keeps a native clipboard image on the scope captured before clipboard read resolves", async () => {
    const scopeA = { dir: "repo", id: "session-a" }
    const scopeB = { dir: "repo", id: "session-b" }
    let activeScope = scopeA
    const readStarted = deferred<void>()
    const resolveClipboard = deferred<File | null>()
    const mounted = mountAttachmentActions({
      scope: () => activeScope,
      readClipboardImage: () => {
        readStarted.resolve()
        return resolveClipboard.promise
      },
      writeAttachment: async (directory, filename) => `${directory}/${filename}`,
    })

    try {
      const paste = mounted.actions.handlePaste({
        clipboardData: { items: [], getData: () => "" },
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
      } as unknown as ClipboardEvent)
      await readStarted.promise
      activeScope = scopeB
      resolveClipboard.resolve(archive("clipboard.zip"))
      await paste

      expect(mounted.stores.get(scopeKey(scopeA))?.map((part) => part.type === "image" && part.filename)).toEqual([
        "clipboard.zip",
      ])
      expect(mounted.stores.has(scopeKey(scopeB))).toBe(false)
    } finally {
      mounted.dispose()
      mounted.editor.remove()
    }
  })

  // 261105 Red 部分失败必须提示：此前 found 为真就吞掉失败项，用户以为文件全加上了。
  test("warns when only part of a batch is added", async () => {
    const translated: string[] = []
    const mounted = mountAttachmentActions({
      scope: () => undefined,
      onTranslate: (key) => translated.push(key),
      writeAttachment: async (directory, filename) => `${directory}/${filename}`,
    })

    try {
      const ok = archive("good.zip")
      const bad = new File([Uint8Array.of(0, 255, 1, 2)], "blob.bin", { type: "application/octet-stream" })
      expect(await mounted.actions.addAttachments([ok, bad])).toBe(true)
      expect(translated).toContain("prompt.toast.attachmentPartial.title")
    } finally {
      mounted.dispose()
      mounted.editor.remove()
    }
  })

  // 261121 Red 方案①：混合粘贴（文件 + text/plain）此前在 files 分支直接 return，说明文字
  // 被丢。现在文字先落正文（addPart 同步段执行），附件异步补读；附件读取失败也不影响
  // 已插入的文字。
  test("mixed paste inserts the note into the draft before attachments resolve", async () => {
    const addedParts: ContentPart[] = []
    const mounted = mountAttachmentActions({
      scope: () => undefined,
      // bun 的 DOM 没有 execCommand：insert 走 addPart 回退，插入内容可直接断言
      addPart: (part) => {
        addedParts.push(part)
        return true
      },
      writeAttachment: async (directory, filename) => `${directory}/${filename}`,
    })

    try {
      const shot = new File([Uint8Array.of(0x89, 0x50)], "shot.png", { type: "image/png" })
      const paste = mounted.actions.handlePaste({
        clipboardData: {
          items: [{ kind: "file", getAsFile: () => shot }],
          getData: () => "请看右下角",
        },
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
      } as unknown as ClipboardEvent)
      // 文字插入在同步段完成——不 await 附件也已在 addPart 里
      expect(addedParts).toEqual([{ type: "text", content: "请看右下角", start: 0, end: 0 }])
      await paste
      const stored = mounted.stores.get("current") ?? []
      expect(stored.filter((part) => part.type === "image").length).toBe(1)
    } finally {
      mounted.dispose()
      mounted.editor.remove()
    }
  })

  // 261121 Red 方案①：附件超限被拒时，混合粘贴的说明文字必须已经落草稿——数据丢失
  // 的底线是文字保住。
  test("mixed paste keeps the note when the attachment is rejected", async () => {
    const addedParts: ContentPart[] = []
    const mounted = mountAttachmentActions({
      scope: () => undefined,
      addPart: (part) => {
        addedParts.push(part)
        return true
      },
      writeAttachment: async (directory, filename) => `${directory}/${filename}`,
    })

    try {
      // 超过 10 MiB 内联线的二进制文件会被 size 检查拒绝
      const big = new File([new Uint8Array(11 * 1024 * 1024).fill(0)], "huge.png", { type: "image/png" })
      const paste = mounted.actions.handlePaste({
        clipboardData: {
          items: [{ kind: "file", getAsFile: () => big }],
          getData: () => "附件超限这段也要在",
        },
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
      } as unknown as ClipboardEvent)
      expect(addedParts).toEqual([{ type: "text", content: "附件超限这段也要在", start: 0, end: 0 }])
      await paste
      expect((mounted.stores.get("current") ?? []).filter((part) => part.type === "image").length).toBe(0)
    } finally {
      mounted.dispose()
      mounted.editor.remove()
    }
  })
})
