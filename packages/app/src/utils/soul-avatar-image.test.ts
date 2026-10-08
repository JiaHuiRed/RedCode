import { describe, expect, test } from "bun:test"
import { inspectSoulAvatar, prepareSoulAvatar } from "./soul-avatar-image"

const png = (width: number, height: number) =>
  Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    (width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff,
    (height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff,
  ])

const jpeg = (width: number, height: number) =>
  Uint8Array.from([
    0xff, 0xd8, 0xff, 0xc0, 0, 11, 8,
    (height >>> 8) & 0xff, height & 0xff, (width >>> 8) & 0xff, width & 0xff, 1, 1, 0x11, 0,
  ])

const webp = (width: number, height: number) =>
  Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 22, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x58, 10, 0, 0, 0, 0, 0, 0, 0,
    (width - 1) & 0xff, ((width - 1) >>> 8) & 0xff, ((width - 1) >>> 16) & 0xff,
    (height - 1) & 0xff, ((height - 1) >>> 8) & 0xff, ((height - 1) >>> 16) & 0xff,
  ])

const webpLossless = (width: number, height: number) => {
  const packedWidth = width - 1
  const packedHeight = height - 1
  return Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 17, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x4c, 5, 0, 0, 0, 0x2f,
    packedWidth & 0xff, ((packedHeight & 0x03) << 6) | ((packedWidth >>> 8) & 0x3f),
    (packedHeight >>> 2) & 0xff, (packedHeight >>> 10) & 0x0f,
  ])
}

describe("inspectSoulAvatar", () => {
  test("reads PNG dimensions regardless of filename or MIME", () => {
    expect(inspectSoulAvatar(png(640, 480))).toEqual({ mime: "image/png", width: 640, height: 480 })
  })
  test("reads JPEG SOF dimensions", () => {
    expect(inspectSoulAvatar(jpeg(320, 240))).toEqual({ mime: "image/jpeg", width: 320, height: 240 })
  })
  test("reads WebP VP8X dimensions", () => {
    expect(inspectSoulAvatar(webp(256, 192))).toEqual({ mime: "image/webp", width: 256, height: 192 })
  })
  test("includes VP8L upper height bits in the size limit check", () => {
    expect(inspectSoulAvatar(webpLossless(64, 2049))).toEqual({ mime: "image/webp", width: 64, height: 2049 })
    expect(() => inspectSoulAvatar(webpLossless(64, 4097))).toThrow("IMAGE_DIMENSIONS_EXCEEDED")
  })
  test("rejects unsupported signatures and malformed headers", () => {
    expect(() => inspectSoulAvatar(new Uint8Array([1, 2, 3]))).toThrow("INVALID_IMAGE")
    expect(() => inspectSoulAvatar(png(20, 20).slice(0, 18))).toThrow("INVALID_IMAGE")
    expect(() => inspectSoulAvatar(jpeg(20, 20).slice(0, 7))).toThrow("INVALID_IMAGE")
    expect(() => inspectSoulAvatar(webp(20, 20).slice(0, 20))).toThrow("INVALID_IMAGE")
  })
  test("rejects zero, dimension-overflow, and pixel-overflow images", () => {
    expect(() => inspectSoulAvatar(png(0, 20))).toThrow("INVALID_IMAGE")
    expect(() => inspectSoulAvatar(png(4097, 1))).toThrow("IMAGE_DIMENSIONS_EXCEEDED")
    expect(() => inspectSoulAvatar(png(4096, 4096))).toThrow("IMAGE_DIMENSIONS_EXCEEDED")
  })
  test("rejects byte arrays larger than the standalone file limit", () => {
    expect(() => inspectSoulAvatar(new Uint8Array(5 * 1024 * 1024 + 1))).toThrow("IMAGE_FILE_TOO_LARGE")
  })
})

test("prepareSoulAvatar rejects oversized input before browser decoding", async () => {
  const file = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "avatar.png", { type: "image/png" })
  await expect(prepareSoulAvatar(file)).rejects.toThrow("IMAGE_FILE_TOO_LARGE")
})
