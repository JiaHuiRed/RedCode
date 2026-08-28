import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { Image } from "@/image/image"
import { MessageID, PartID, SessionID } from "@/session/schema"
import path from "node:path"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Image.layer.pipe(Layer.provide(TestConfig.layer()))))
const tiny = testEffect(
  Layer.mergeAll(
    Image.layer.pipe(
      Layer.provide(
        TestConfig.layer({ get: () => Effect.succeed({ attachment: { image: { max_base64_bytes: 1 } } }) }),
      ),
    ),
  ),
)

function part(mime: string, data: string) {
  return {
    id: PartID.ascending(),
    messageID: MessageID.ascending(),
    sessionID: SessionID.make("ses_test"),
    type: "file" as const,
    mime,
    url: `data:${mime};base64,${data}`,
  }
}

describe("Image", () => {
  it.effect("normalizes generated png and jpeg attachments", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(
        new Uint8Array(Array.from({ length: 64 * 64 * 4 }, (_, index) => (index % 4 === 3 ? 255 : index % 251))),
        64,
        64,
      )
      const image = yield* Image.Service
      const results = yield* Effect.all([
        image.normalize(part("image/png", Buffer.from(source.get_bytes()).toString("base64"))),
        image.normalize(part("image/jpeg", Buffer.from(source.get_bytes_jpeg(90)).toString("base64"))),
      ])

      source.free()
      expect(results.map(({ part }) => part.url.startsWith(`data:${part.mime};base64,`))).toEqual([true, true])
      expect(results.every(({ part }) => part.mime === "image/png" || part.mime === "image/jpeg")).toBe(true)
    }),
  )

  it.effect("accepts webp attachments that are already within limits", () =>
    Effect.gen(function* () {
      const image = yield* Image.Service
      const input = part("image/webp", "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA")

      // 260822 cc toBe 而非 toEqual：in-budget 走的是 `return input`，返回同一个对象引用，
      // 即逐字节透传。钉住引用相等，才能在有人改成重编码时立刻报警（那会废掉内容寻址去重）。
      expect((yield* image.normalize(input)).part).toBe(input)
    }),
  )

  it.effect("resizes images that fit the byte limit but exceed dimension limits", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 9_000 * 4 }, () => 255)), 9_000, 1)
      const image = yield* Image.Service
      const result = yield* image.normalize(part("image/png", Buffer.from(source.get_bytes()).toString("base64")))
      const resized = photon.PhotonImage.new_from_byteslice(
        Buffer.from(result.part.url.slice(result.part.url.indexOf(";base64,") + ";base64,".length), "base64"),
      )

      source.free()
      // 260828 cc 断言从「每边 <= 2000」改成「每边 <= 8192 且总像素 <= 4M」——
      // 这是**有意的行为变更**不是迁就实现：9000x1 总共才 9000 像素，视觉 token 成本
      // 可以忽略，把它压成 2000 宽纯属旧盒子规则的副作用。现在只由每边硬帽收一次。
      expect(resized.get_width()).toBeLessThanOrEqual(8_192)
      expect(resized.get_height()).toBeLessThanOrEqual(8_192)
      expect(resized.get_width() * resized.get_height()).toBeLessThanOrEqual(4_000_000)
      expect(resized.get_width()).toBeGreaterThan(2_000)
      resized.free()
    }),
  )

  it.effect("resizes the 5MB base64 picture fixture", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const data = Buffer.from(
        yield* Effect.promise(() =>
          Bun.file(path.join(import.meta.dir, "fixtures", "picture-5mb-base64.png")).arrayBuffer(),
        ),
      )
      const input = part("image/png", data.toString("base64"))
      const image = yield* Image.Service
      const result = yield* image.normalize(input)
      const base64 = result.part.url.slice(result.part.url.indexOf(";base64,") + ";base64,".length)
      const resized = photon.PhotonImage.new_from_byteslice(Buffer.from(base64, "base64"))

      expect(input.url.slice(input.url.indexOf(";base64,") + ";base64,".length).length).toBe(5 * 1024 * 1024)
      // 仍然重编码（透传闸门保持旧盒子，2964 > 2000），payload 仍远低于上限；
      // 变的是它保住了源分辨率而不是被压到 2000x329。
      expect(result.part.url).not.toBe(input.url)
      expect(base64.length).toBeLessThan(1024 * 1024)
      expect(resized.get_width()).toBe(2_964)
      expect(resized.get_height()).toBe(488)
      resized.free()
    }),
  )

  tiny.effect("fails with a typed size error when no resized candidate fits", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 4 }, () => 255)), 1, 1)
      const image = yield* Image.Service
      const exit = yield* image
        .normalize(part("image/png", Buffer.from(source.get_bytes()).toString("base64")))
        .pipe(Effect.exit)

      source.free()
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(Image.SizeError)
        if (error instanceof Image.SizeError) {
          expect(error.width).toBe(1)
          expect(error.height).toBe(1)
          expect(error.max).toBe(1)
        }
      }
    }),
  )
})

// 260822 cc JPEG 候选梯子的闸门。
//
// 原梯子是 [80, 85, 70, 55, 40]：候选顺序为 [png, q80, q85, q70, q55, q40]，.find() 取
// 第一个字节数达标的，所以命中 q85 需要 bytes(q85) < bytes(q80) —— 与「质量越高字节越大」
// 矛盾，那一档在任何输入下都不可达。这个 bug 能长期存活的结构性原因是 JPEG_QUALITIES
// 是文件内 const、测试拿不到，于是最廉价的那种闸门写不出来。现已导出。
describe("Image JPEG candidate ladder", () => {
  it.effect("the quality ladder is strictly descending", () =>
    Effect.gen(function* () {
      const ladder = Image.JPEG_QUALITIES
      expect(ladder.length).toBeGreaterThan(0)
      // 严格递减：等值也不行——相等的后一档同样不可达（前一档先被 find 命中）
      for (let i = 1; i < ladder.length; i++) expect(ladder[i]).toBeLessThan(ladder[i - 1])
      expect(new Set(ladder).size).toBe(ladder.length)
    }),
  )

  // JPEG 分支此前实际覆盖率是 0：4 条正向用例全在第 0 档的 PNG 候选就命中了。
  // 噪声图不可压缩，PNG 候选必然超限，于是第一次真正走到 JPEG 档。
  it.effect("falls through to a JPEG candidate when the PNG candidate is over budget", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const side = 1000
      const pixels = new Uint8Array(side * side * 4)
      // 确定性伪随机（LCG），保证同一输入每次跑出同样的字节数
      let seed = 0x2545f491
      for (let i = 0; i < pixels.length; i += 4) {
        seed = (seed * 1664525 + 1013904223) >>> 0
        pixels[i] = seed & 0xff
        pixels[i + 1] = (seed >>> 8) & 0xff
        pixels[i + 2] = (seed >>> 16) & 0xff
        pixels[i + 3] = 255
      }
      const source = new photon.PhotonImage(pixels, side, side)
      const png = Buffer.from(source.get_bytes()).toString("base64")
      source.free()

      const image = yield* Image.Service
      const result = yield* image.normalize(part("image/png", png))
      expect(result.part.mime).toBe("image/jpeg")
      expect(result.part.url.startsWith("data:image/jpeg;base64,")).toBe(true)
    }),
  )
})

// 260822 cc 缩放报告与坐标倍数（搬自官方 harness 6e17c20804）
// 260828 cc 尺寸规则从「每边盒子」改成「总像素预算 + 每边硬帽」之后的行为闸门。
describe("Image pixel budget", () => {
  // R3 的实际修复点：长截图不再被压成十分之一宽。
  // 旧规则 scale = min(1, 2000/100, 2000/2400) = 0.833 -> 83x2000（宽度砍掉 17%）；
  // 新规则总共才 240K 像素，远在 4M 预算内，只受每边 8192 约束 -> 原尺寸保留。
  it.effect("keeps the short edge of a tall screenshot instead of crushing it", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 100 * 2_400 * 4 }, () => 255)), 100, 2_400)
      const image = yield* Image.Service
      const result = yield* image.normalize(part("image/png", Buffer.from(source.get_bytes()).toString("base64")))
      const out = photon.PhotonImage.new_from_byteslice(
        Buffer.from(result.part.url.slice(result.part.url.indexOf(";base64,") + ";base64,".length), "base64"),
      )
      source.free()

      expect(out.get_width()).toBe(100)
      expect(out.get_height()).toBe(2_400)
      out.free()
    }),
  )

  // 回归闸门：方形图落在预算边界上，行为必须与改动前逐像素相同。
  it.effect("leaves a square image at the budget boundary exactly as before", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 2_100 * 2_100 * 4 }, () => 255)), 2_100, 2_100)
      const image = yield* Image.Service
      const result = yield* image.normalize(part("image/png", Buffer.from(source.get_bytes()).toString("base64")))
      const out = photon.PhotonImage.new_from_byteslice(
        Buffer.from(result.part.url.slice(result.part.url.indexOf(";base64,") + ";base64,".length), "base64"),
      )
      source.free()

      // 2100x2100 = 4.41M px 超 4M 预算 -> sqrt(4M/4.41M) = 0.952 -> 2000x2000，
      // 与旧盒子规则 min(1, 2000/2100) = 0.952 得到的结果相同。
      expect(out.get_width()).toBe(2_000)
      expect(out.get_height()).toBe(2_000)
      out.free()
    }),
  )
})

// 260828 cc JPEG 源不可能带 alpha，给它排一个 PNG 候选是纯浪费 —— PNG 排在第一位，
// 一旦碰巧落在字节预算内就会被选中，那正是「照片被路由到无损编码器」的病。
describe("Image alpha routing", () => {
  it.effect("never offers a PNG candidate for a JPEG source", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 3_000 * 100 * 4 }, () => 255)), 3_000, 100)
      const image = yield* Image.Service
      // 全白图的 PNG 极小，旧实现里它一定排第一且在预算内 —— 所以这条断言能区分两种实现。
      const result = yield* image.normalize(part("image/jpeg", Buffer.from(source.get_bytes_jpeg(90)).toString("base64")))
      source.free()

      expect(result.part.mime).toBe("image/jpeg")
    }),
  )

  it.effect("still offers PNG first for a source that may carry alpha", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 3_000 * 100 * 4 }, () => 255)), 3_000, 100)
      const image = yield* Image.Service
      const result = yield* image.normalize(part("image/png", Buffer.from(source.get_bytes()).toString("base64")))
      source.free()

      expect(result.part.mime).toBe("image/png")
    }),
  )
})

describe("Image resize report", () => {
  it.effect("reports source dimensions when the image was downscaled, and nothing when it was not", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 9_000 * 4 }, () => 255)), 9_000, 1)
      const image = yield* Image.Service
      const resized = yield* image.normalize(part("image/png", Buffer.from(source.get_bytes()).toString("base64")))
      source.free()

      expect(resized.resize).toBeDefined()
      expect(resized.resize!.sourceWidth).toBe(9_000)
      expect(resized.resize!.sourceHeight).toBe(1)
      expect(resized.resize!.width).toBeLessThanOrEqual(8_192)
      expect(resized.resize!.width).toBeGreaterThan(2_000)

      // 未缩放的图不产出报告 —— 否则模型会被告知一个不存在的坐标换算
      const small = yield* image.normalize(
        part("image/webp", "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"),
      )
      expect(small.resize).toBeUndefined()
    }),
  )

  // 文案必须完全由尺寸推导。掺进时间戳/随机数就会重演 260804 那次事故：同一张历史图
  // 每轮生成不同文本 → provider 前缀缓存被永久钉死、命中率线性掉到 50% 且不自愈。
  it.effect("the notice is deterministic and states the back-mapping multiplier", () =>
    Effect.gen(function* () {
      const report = { sourceWidth: 3840, sourceHeight: 2160, width: 2000, height: 1125 }
      const a = Image.formatResizeNotice(report)
      const b = Image.formatResizeNotice({ ...report })
      expect(a).toBe(b)
      expect(a).toContain("3840x2160")
      expect(a).toContain("2000x1125")
      expect(a).toContain("1.92") // 3840/2000，宽方向回映射倍数
    }),
  )
})
