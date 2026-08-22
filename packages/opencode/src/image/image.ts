import { Config } from "@/config/config"
import type { MessageV2 } from "@/session/message-v2"
import * as Log from "@redcode-ai/core/util/log"
import photonWasm from "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" }
import { Context, Effect, Layer, Schema } from "effect"
import path from "node:path"
import { fileURLToPath } from "node:url"

const MAX_BASE64_BYTES = 5 * 1024 * 1024
const MAX_WIDTH = 2000
const MAX_HEIGHT = 2000
const AUTO_RESIZE = true
// 260822 cc 必须严格单调递减，否则后面的档位不可达。
//
// 候选数组的实际顺序是 [png, q80, q85, q70, q55, q40]，.find() 取第一个字节数达标的。
// 要命中 q85 就得同时满足 bytes(q80) > MAX 且 bytes(q85) <= MAX，即 bytes(q85) < bytes(q80)
// —— 与「质量越高字节越大」矛盾。原数组里的 85 因此在任何输入下都取不到，是死代码，
// 每一档尺寸还白编码一次（2000x1333 实测单次 JPEG 编码 ~332ms + 一个 3.9MB buffer）。
// 已实测：删掉 85 之后，现有 5 条用例选中的候选与最终结果一模一样。
//
// 刻意**不**对齐官方 harness 的 85/75/60/45：那会把首个 JPEG 档从 80 抬到 85，实测
// 3000x2000 噪声图 payload 从 b64 3799524 涨到 4441280（+17%）。那是拿 vision token
// 成本换保真度，官方不按人民币计费，本仓按。要改是独立决策，不是顺手跟。
//
// 导出是为了让 image.test.ts 能钉住「严格递减」这条不变式 —— 它此前是文件内 const，
// 测试拿不到，这正是这个 bug 能长期存活的结构性原因。
export const JPEG_QUALITIES = [80, 70, 55, 40]
const log = Log.create({ service: "image" })

export class ResizerUnavailableError extends Schema.TaggedErrorClass<ResizerUnavailableError>()(
  "ImageResizerUnavailableError",
  {},
) {
  override get message() {
    return "Image resizer is unavailable"
  }
}

export class InvalidDataUrlError extends Schema.TaggedErrorClass<InvalidDataUrlError>()("ImageInvalidDataUrlError", {
  url: Schema.String,
}) {
  override get message() {
    return "Image URL must be a base64 data URL"
  }
}

export class DecodeError extends Schema.TaggedErrorClass<DecodeError>()("ImageDecodeError", {}) {
  override get message() {
    return "Image could not be decoded"
  }
}

export class SizeError extends Schema.TaggedErrorClass<SizeError>()("ImageSizeError", {
  bytes: Schema.Number,
  max: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  max_width: Schema.Number,
  max_height: Schema.Number,
}) {
  override get message() {
    return `Image ${this.width}x${this.height} with base64 size ${this.bytes} exceeds configured limits and could not be resized below ${this.max_width}x${this.max_height}/${this.max} bytes`
  }
}

export type Error = ResizerUnavailableError | InvalidDataUrlError | DecodeError | SizeError

/** 缩放后的尺寸报告；未缩放时不产出。 */
export interface ResizeReport {
  readonly sourceWidth: number
  readonly sourceHeight: number
  readonly width: number
  readonly height: number
}

/**
 * 260822 cc 把「这张图被缩过、缩了多少」告诉模型（搬自官方 deepseek-harness
 * 6e17c20804 read_image reports downscaled dimensions and coordinate scale）。
 *
 * 之前 originalWidth/originalHeight 只进了 log，模型完全不知道自己看的是缩略图：
 * 它报出的任何像素尺寸/坐标都是缩放后坐标系里的数，与原文件对不上。
 *
 * 三条约束：
 * · **必须确定性**——文案只由尺寸推导，不含时间戳/随机数。掺进去就会重演
 *   transform.ts savePartToTemp 上方记录的那次事故：同一张历史图每轮生成不同文本，
 *   provider 前缀缓存被永久钉死、命中率线性掉到 50% 且不自愈。
 * · **倍数现算，不复用 normalize 里的 scale**——那是首选尺寸的缩小率，而 ×0.75 降级
 *   循环 + Math.floor 会让最终尺寸偏离它。
 * · **宽高分开给**——降级循环对宽高各自 floor，两个方向的倍数可能不等。
 */
export function formatResizeNotice(report: ResizeReport): string {
  const x = (report.sourceWidth / report.width).toFixed(2)
  const y = (report.sourceHeight / report.height).toFixed(2)
  return (
    `This image was downscaled for transport: the file on disk is ` +
    `${report.sourceWidth}x${report.sourceHeight} px, you are seeing ${report.width}x${report.height} px. ` +
    `Multiply any coordinate or size you measure on it by ${x} horizontally and ${y} vertically ` +
    `to locate the same feature in the original file.`
  )
}

export interface Interface {
  readonly normalize: (
    input: MessageV2.FilePart,
  ) => Effect.Effect<{ part: MessageV2.FilePart; resize?: ResizeReport }, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Image") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const loadPhoton = yield* Effect.cached(
      Effect.sync(() => {
        // Patched photon-node reads this during module init so Bun compiled binaries use the embedded wasm path.
        ;(globalThis as typeof globalThis & { __REDCODE_PHOTON_WASM_PATH?: string }).__REDCODE_PHOTON_WASM_PATH =
          path.isAbsolute(photonWasm) ? photonWasm : fileURLToPath(new URL(photonWasm, import.meta.url))
      }).pipe(
        Effect.andThen(() => Effect.tryPromise(() => import("@silvia-odwyer/photon-node"))),
        Effect.tapError((error) => Effect.sync(() => log.warn("failed to load photon", { error }))),
        Effect.mapError(() => new ResizerUnavailableError()),
      ),
    )

    const normalize = Effect.fn("Image.normalize")(function* (input: MessageV2.FilePart) {
      const image = (yield* config.get()).attachment?.image
      const info = {
        autoResize: image?.auto_resize ?? AUTO_RESIZE,
        maxWidth: image?.max_width ?? MAX_WIDTH,
        maxHeight: image?.max_height ?? MAX_HEIGHT,
        maxBase64Bytes: image?.max_base64_bytes ?? MAX_BASE64_BYTES,
      }
      if (!input.url.startsWith("data:") || !input.url.includes(";base64,"))
        return yield* new InvalidDataUrlError({ url: input.url })

      const base64 = input.url.slice(input.url.indexOf(";base64,") + ";base64,".length)
      const bytes = Buffer.byteLength(base64, "utf8")

      const photon = yield* loadPhoton

      const decoded = yield* Effect.try({
        try: () => photon.PhotonImage.new_from_byteslice(Buffer.from(base64, "base64")),
        catch: (error) => {
          log.warn("failed to decode image", { error })
          return new DecodeError()
        },
      })

      try {
        const originalWidth = decoded.get_width()
        const originalHeight = decoded.get_height()
        if (originalWidth <= info.maxWidth && originalHeight <= info.maxHeight && bytes <= info.maxBase64Bytes)
          // in-budget 原样透传：返回同一个 part 对象引用，逐字节相同（内容寻址去重的前提）
          return { part: input }
        if (!info.autoResize)
          return yield* new SizeError({
            bytes,
            max: info.maxBase64Bytes,
            width: originalWidth,
            height: originalHeight,
            max_width: info.maxWidth,
            max_height: info.maxHeight,
          })

        const scale = Math.min(1, info.maxWidth / originalWidth, info.maxHeight / originalHeight)
        for (const size of Array.from({ length: 32 }).reduce<Array<{ width: number; height: number }>>((acc) => {
          const previous = acc.at(-1) ?? {
            width: Math.max(1, Math.round(originalWidth * scale)),
            height: Math.max(1, Math.round(originalHeight * scale)),
          }
          const next =
            acc.length === 0
              ? previous
              : {
                  width: previous.width === 1 ? 1 : Math.max(1, Math.floor(previous.width * 0.75)),
                  height: previous.height === 1 ? 1 : Math.max(1, Math.floor(previous.height * 0.75)),
                }
          return acc.some((item) => item.width === next.width && item.height === next.height) ? acc : [...acc, next]
        }, [])) {
          const resized = photon.resize(decoded, size.width, size.height, photon.SamplingFilter.Lanczos3)
          const candidate = [
            { data: Buffer.from(resized.get_bytes()).toString("base64"), mime: "image/png" },
            ...JPEG_QUALITIES.map((quality) => ({
              data: Buffer.from(resized.get_bytes_jpeg(quality)).toString("base64"),
              mime: "image/jpeg",
            })),
          ]
            .map((item) => ({ ...item, bytes: Buffer.byteLength(item.data, "utf8") }))
            .find((item) => item.bytes <= info.maxBase64Bytes)
          resized.free()

          if (candidate) {
            log.info("using resized image", {
              from_mime: input.mime,
              to_mime: candidate.mime,
              from: `${originalWidth}x${originalHeight}`,
              to: `${size.width}x${size.height}`,
            })
            return {
              part: {
                ...input,
                mime: candidate.mime,
                url: `data:${candidate.mime};base64,${candidate.data}`,
              },
              resize: {
                sourceWidth: originalWidth,
                sourceHeight: originalHeight,
                width: size.width,
                height: size.height,
              },
            }
          }
        }

        return yield* new SizeError({
          bytes,
          max: info.maxBase64Bytes,
          width: originalWidth,
          height: originalHeight,
          max_width: info.maxWidth,
          max_height: info.maxHeight,
        })
      } finally {
        decoded.free()
      }
    })

    return Service.of({ normalize })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))

export * as Image from "./image"
