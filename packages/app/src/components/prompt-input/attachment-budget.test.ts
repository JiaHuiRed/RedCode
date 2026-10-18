import { describe, expect, test } from "bun:test"
import {
  MAX_ARCHIVE_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_PROMPT_ARCHIVE_BYTES,
  MAX_PROMPT_ATTACHMENT_BYTES,
  MAX_PROMPT_ATTACHMENTS,
  archiveFits,
  attachmentBytes,
  attachmentFits,
  presentBudget,
  type PendingBudget,
} from "./attachment-budget"

const part = (bytes: number) => ({ size: bytes, dataUrl: "" })
const pending = (inlineBytes = 0, archiveBytes = 0, count = 0): PendingBudget => ({
  inlineBytes,
  archiveBytes,
  count,
})
const none = pending()

describe("attachmentBytes", () => {
  test("prefers the recorded size", () => {
    expect(attachmentBytes({ size: 1234, dataUrl: "data:image/png;base64,AAAA" })).toBe(1234)
  })

  test("derives bytes from the base64 payload", () => {
    expect(attachmentBytes({ dataUrl: "data:image/png;base64,AAAA" })).toBe(3)
  })

  test("does not under-count a malformed data url", () => {
    const malformed = "data:image/png;base64"
    const bytes = attachmentBytes({ dataUrl: malformed })
    expect(bytes).toBe(Math.ceil((malformed.length * 3) / 4))
    expect(bytes).toBeGreaterThan(0)
  })
})

describe("attachmentFits", () => {
  test("accepts a file within every budget", () => {
    expect(attachmentFits(1024, [], 0, none)).toBeTrue()
  })

  test("rejects a file above the per-file ceiling", () => {
    expect(attachmentFits(MAX_ATTACHMENT_BYTES + 1, [], 0, none)).toBeFalse()
  })

  test("rejects the ninth attachment", () => {
    const parts = Array.from({ length: MAX_PROMPT_ATTACHMENTS - 1 }, () => part(10))
    expect(attachmentFits(10, parts, parts.length, none)).toBeTrue()
    const full = [...parts, part(10)]
    expect(attachmentFits(10, full, full.length, none)).toBeFalse()
  })

  test("counts attachments that are still being read", () => {
    const parts = Array.from({ length: MAX_PROMPT_ATTACHMENTS - 1 }, () => part(10))
    expect(attachmentFits(10, parts, parts.length, none)).toBeTrue()
    expect(attachmentFits(10, parts, parts.length, pending(0, 0, 1))).toBeFalse()
  })

  test("rejects a file that would exceed the prompt total", () => {
    const parts = [part(MAX_PROMPT_ATTACHMENT_BYTES - 100)]
    expect(attachmentFits(50, parts, parts.length, none)).toBeTrue()
    expect(attachmentFits(200, parts, parts.length, none)).toBeFalse()
  })

  test("does not release pending budget when a request is rejected", () => {
    const parts = [part(MAX_PROMPT_ATTACHMENT_BYTES)]
    const budget = pending()
    expect(attachmentFits(10, parts, parts.length, budget)).toBeFalse()
    expect(budget).toEqual(pending())
  })

  // 261018 Red 顺序无关：压缩包只占它自己那条字节线，不参与内联求和。
  // 旧实现把 ZIP 字节算进 20 MiB 内联线，于是「先 ZIP 后 PNG」失败、「先 PNG 后 ZIP」成功。
  test("mixed attachment order does not change the outcome", () => {
    const sized = (bytes: number, filename: string) => ({ size: bytes, dataUrl: "", filename })
    const isArchive = (p: { filename?: string }) => p.filename!.endsWith(".zip")
    const zip = sized(36 * 1024 * 1024, "debug.zip")
    const png = sized(1 * 1024 * 1024, "shot.png")

    // ZIP 先进来，再加 PNG：PNG 只看内联线，36 MiB 的包不该让它失败
    const afterZip = presentBudget([zip], isArchive)
    expect(archiveFits(zip.size!, afterZip.archives, afterZip.count, none)).toBeTrue()
    expect(attachmentFits(png.size!, afterZip.inline, afterZip.count, none)).toBeTrue()

    // 反过来也一样
    const afterPng = presentBudget([png], isArchive)
    expect(attachmentFits(png.size!, afterPng.inline, afterPng.count, none)).toBeTrue()
    expect(archiveFits(zip.size!, afterPng.archives, afterPng.count, none)).toBeTrue()

    // 反证旧行为：如果把全部附件（含 ZIP）当作内联字节，PNG 会被拒
    expect(attachmentFits(png.size!, [zip], 1, none)).toBeFalse()
  })
})

// 261018 Red 压缩包独立预算：36 MiB 的调试包是正常用途，不应被 base64 的 10 MiB 单件线拦下。
describe("archiveFits", () => {
  const zip = 36 * 1024 * 1024

  test("accepts a 36 MiB archive above the inline per-file ceiling", () => {
    expect(zip).toBeGreaterThan(MAX_ATTACHMENT_BYTES)
    expect(archiveFits(zip, [], 0, none)).toBeTrue()
  })

  test("rejects an archive above its own ceiling", () => {
    expect(archiveFits(MAX_ARCHIVE_BYTES + 1, [], 0, none)).toBeFalse()
  })

  test("keeps archive bytes separate from the inline image total", () => {
    const images = [part(MAX_PROMPT_ATTACHMENT_BYTES)]
    // 图片占满内联线不影响压缩包；件数由调用方传入（含全部附件）
    expect(archiveFits(zip, [], images.length, none)).toBeTrue()
  })

  test("shares the attachment count ceiling", () => {
    const images = Array.from({ length: MAX_PROMPT_ATTACHMENTS }, () => part(10))
    expect(archiveFits(zip, [], images.length, none)).toBeFalse()
  })

  test("counts archives that are still being written", () => {
    expect(archiveFits(1, [], 0, pending(0, MAX_PROMPT_ARCHIVE_BYTES, 0))).toBeFalse()
  })

  // 261018 Red 跨类别在途件数共享：7 件已有 + 1 件图片在途时，再进来的 ZIP 必须被拒绝。
  // 旧实现按类别各存一份 count，ZIP 只看到自己的 0 → 放行 → 9 件。
  test("sees in-flight inline attachments when counting the shared ceiling", () => {
    expect(archiveFits(zip, [], MAX_PROMPT_ATTACHMENTS - 1, pending(0, 0, 1))).toBeFalse()
    expect(archiveFits(zip, [], MAX_PROMPT_ATTACHMENTS - 2, pending(0, 0, 1))).toBeTrue()
  })
})
