import { describe, expect, test } from "bun:test"
import { attachmentMime, isArchiveFile } from "./files"
import { pasteMode } from "./paste"

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
