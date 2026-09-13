import { describe, expect, test } from "bun:test"
import {
  MAX_ATTACHMENT_BYTES,
  MAX_PROMPT_ATTACHMENTS,
  MAX_PROMPT_ATTACHMENT_BYTES,
  attachmentBytes,
  attachmentFits,
} from "./attachment-budget"

const part = (bytes: number) => ({ size: bytes, dataUrl: "" })

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
    expect(attachmentFits(1024, [], { bytes: 0, count: 0 })).toBeTrue()
  })

  test("rejects a file above the per-file ceiling", () => {
    expect(attachmentFits(MAX_ATTACHMENT_BYTES + 1, [], { bytes: 0, count: 0 })).toBeFalse()
  })

  test("rejects the ninth attachment", () => {
    const parts = Array.from({ length: MAX_PROMPT_ATTACHMENTS - 1 }, () => part(10))
    expect(attachmentFits(10, parts, { bytes: 0, count: 0 })).toBeTrue()
    expect(attachmentFits(10, [...parts, part(10)], { bytes: 0, count: 0 })).toBeFalse()
  })

  test("counts attachments that are still being read", () => {
    const parts = Array.from({ length: MAX_PROMPT_ATTACHMENTS - 1 }, () => part(10))
    expect(attachmentFits(10, parts, { bytes: 0, count: 0 })).toBeTrue()
    expect(attachmentFits(10, parts, { bytes: 0, count: 1 })).toBeFalse()
  })

  test("rejects a file that would exceed the prompt total", () => {
    const parts = [part(MAX_PROMPT_ATTACHMENT_BYTES - 100)]
    expect(attachmentFits(50, parts, { bytes: 0, count: 0 })).toBeTrue()
    expect(attachmentFits(200, parts, { bytes: 0, count: 0 })).toBeFalse()
  })

  test("does not release pending budget when a request is rejected", () => {
    const parts = [part(MAX_PROMPT_ATTACHMENT_BYTES)]
    const pending = { bytes: 0, count: 0 }
    expect(attachmentFits(10, parts, pending)).toBeFalse()
    expect(pending).toEqual({ bytes: 0, count: 0 })
  })
})
