import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { Prompt, Scope } from "@/context/prompt"
import { attachmentMime, isArchiveFile } from "./files"
import { pasteMode } from "./paste"
import { createPromptAttachmentsWithContext } from "./attachments"

const scopeKey = (scope?: Scope) => (scope ? `${scope.dir}:${scope.id ?? ""}` : "current")

function mountAttachmentActions(input: {
  scope: () => Scope | undefined
  writeAttachment: (sessionDir: string, filename: string, data: Uint8Array) => Promise<string>
  readClipboardImage?: () => Promise<File | null>
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
  const language = { t: (key: string | number) => String(key) }

  const mounted = createRoot((dispose) => ({
    actions: createPromptAttachmentsWithContext(
      {
        editor: () => editor,
        isDialogActive: () => false,
        setDraggingType: () => undefined,
        focusEditor: () => undefined,
        addPart: () => false,
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
})
