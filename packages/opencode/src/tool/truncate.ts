import { NodePath } from "@effect/platform-node"
import { Cause, Duration, Effect, Layer, Option, Schedule, Context } from "effect"
import path from "path"
import type { Agent } from "../agent/agent"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { evaluate } from "@/permission/evaluate"
import { Config } from "@/config/config"
import { Identifier } from "../id/id"
import * as Log from "@redcode-ai/core/util/log"
import { ToolID } from "./schema"
import { TRUNCATION_DIR } from "./truncation-dir"
import { ImageTokens } from "@/session/image-tokens"

const log = Log.create({ service: "truncation" })
const RETENTION = Duration.days(7)

export const MAX_LINES = 2000
export const MAX_BYTES = 50 * 1024
export const DIR = TRUNCATION_DIR
export const GLOB = path.join(TRUNCATION_DIR, "*")

export type Result = { content: string; truncated: false } | { content: string; truncated: true; outputPath: string }

export interface Options {
  maxLines?: number
  maxBytes?: number
  // 260817 Red 新增 both：head+tail 双端预览（4:1），尾部常含结论不再被整体裁掉
  direction?: "head" | "tail" | "both"
}

/** 工具结果附件的最小形状：预算只需要 mime 与 url。 */
export interface Attachment {
  mime: string
  url: string
  filename?: string
}

export interface ResultOutput<T extends Attachment = Attachment> {
  output: string
  attachments?: T[]
  metadata: { truncated: boolean; outputPath?: string; mediaPath?: string }
}

function hasTaskTool(agent?: Agent.Info) {
  if (!agent?.permission) return false
  return evaluate("task", "*", agent.permission).action !== "deny"
}

export interface Interface {
  readonly cleanup: () => Effect.Effect<void>
  readonly write: (text: string) => Effect.Effect<string>
  /**
   * Returns output unchanged when it fits within the limits, otherwise writes the full text
   * to the truncation directory and returns a preview plus a hint to inspect the saved file.
   */
  readonly output: (text: string, options?: Options, agent?: Agent.Info) => Effect.Effect<Result>
  /**
   * 模型侧硬预算版本：文本与附件一起按 token 估价（见 ImageTokens），超预算的部分
   * spill 到磁盘供恢复。与 output() 的分工：output() 管字节/行数，这个管模型可见 token。
   *
   * 260923 Red 决策记录：docs/notes/implemented/feature/2026-09-23-tool-result-token-budget.md
   */
  readonly result: (
    input: { output: string; attachments?: Attachment[]; outputPath?: string },
    options?: { model?: { providerID: string } },
    agent?: Agent.Info,
  ) => Effect.Effect<ResultOutput>
  /**
   * Resolved truncation limits: values from `tool_output` in redcode config, or MAX_LINES / MAX_BYTES if unset.
   */
  readonly limits: () => Effect.Effect<{ maxLines: number; maxBytes: number }>
}

export class Service extends Context.Service<Service, Interface>()("@redcode/Truncate") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    const cleanup = Effect.fn("Truncate.cleanup")(function* () {
      const cutoff = Identifier.timestamp(
        Identifier.create("tool", "ascending", Date.now() - Duration.toMillis(RETENTION)),
      )
      const entries = yield* fs.readDirectory(TRUNCATION_DIR).pipe(
        Effect.map((all) => all.filter((name) => name.startsWith("tool_"))),
        Effect.catch(() => Effect.succeed([])),
      )
      for (const entry of entries) {
        // 260923 Red spill 的附件目录叫 tool_<id>_media，剥掉后缀再按 ID 取时间戳；
        // 目录要递归删（默认 remove 对非空目录会失败）
        const id = entry.endsWith("_media") ? entry.slice(0, -"_media".length) : entry
        if (Identifier.timestamp(id) >= cutoff) continue
        yield* fs.remove(path.join(TRUNCATION_DIR, entry), { recursive: true }).pipe(Effect.catch(() => Effect.void))
      }
    })

    const write = Effect.fn("Truncate.write")(function* (text: string) {
      const file = path.join(TRUNCATION_DIR, ToolID.ascending())
      yield* fs.ensureDir(TRUNCATION_DIR).pipe(Effect.orDie)
      yield* fs.writeFileString(file, text).pipe(Effect.orDie)
      return file
    })

    const limits = Effect.fn("Truncate.limits")(function* () {
      const configSvc = yield* Effect.serviceOption(Config.Service)
      if (Option.isNone(configSvc)) return { maxLines: MAX_LINES, maxBytes: MAX_BYTES }
      const cfg = yield* configSvc.value.get().pipe(Effect.catch(() => Effect.succeed(undefined)))
      return {
        maxLines: cfg?.tool_output?.max_lines ?? MAX_LINES,
        maxBytes: cfg?.tool_output?.max_bytes ?? MAX_BYTES,
      }
    })

    const output = Effect.fn("Truncate.output")(function* (text: string, options: Options = {}, agent?: Agent.Info) {
      const resolved = yield* limits()
      const maxLines = options.maxLines ?? resolved.maxLines
      const maxBytes = options.maxBytes ?? resolved.maxBytes
      const direction = options.direction ?? "both"
      const lines = text.split("\n")
      const totalBytes = Buffer.byteLength(text, "utf-8")

      if (lines.length <= maxLines && totalBytes <= maxBytes) {
        return { content: text, truncated: false } as const
      }

      // 260817 Red 双端预览：both 按 4:1 把预算分给 head/tail（对齐压缩摘要的比例），
      // 尾部（错误信息/测试结果/命令收尾）得以保留，模型不再只看开头。
      const headMaxLines = direction === "tail" ? 0 : direction === "both" ? Math.floor(maxLines * 0.8) : maxLines
      const tailMaxLines = direction === "head" ? 0 : maxLines - headMaxLines
      const headMaxBytes = direction === "tail" ? 0 : direction === "both" ? Math.floor(maxBytes * 0.8) : maxBytes
      const tailMaxBytes = direction === "head" ? 0 : maxBytes - headMaxBytes

      const head = collectPreview(lines, headMaxLines, headMaxBytes, false)
      const tail = collectPreview(lines, tailMaxLines, tailMaxBytes, true, head.count)

      const removed = Math.max(
        0,
        head.hitBytes || tail.hitBytes ? totalBytes - head.bytes - tail.bytes : lines.length - head.count - tail.count,
      )
      const unit = head.hitBytes || tail.hitBytes ? "bytes" : "lines"
      const headPreview = head.preview.join("\n")
      const tailPreview = tail.preview.join("\n")
      const file = yield* write(text)

      const hint = hasTaskTool(agent)
        ? `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context.`
        : `The tool call succeeded but the output was truncated. Full output saved to: ${file}\nUse Grep to search the full content or Read with offset/limit to view specific sections.`

      const content =
        direction === "both"
          ? `${headPreview}\n\n...${removed} ${unit} truncated...\n\n${tailPreview}\n\n${hint}`
          : direction === "tail"
            ? `...${removed} ${unit} truncated...\n\n${hint}\n\n${tailPreview}`
            : `${headPreview}\n\n...${removed} ${unit} truncated...\n\n${hint}`

      return {
        content,
        truncated: true,
        outputPath: file,
      } as const
    })

    // 260923 Red spill 一律 fail-soft：写盘失败只回报「没能保存」，预览仍然有界。
    // 刻意不学 deepseek-harness ab102138c8 那个形状 —— 它 catch 后返回 undefined，
    // 调用方于是拿到未截断的原始结果，等于把预算整个作废。
    const spill = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.catchCause(() => Effect.succeed(undefined)))

    const writeMedia = Effect.fn("Truncate.writeMedia")(function* (attachments: Attachment[]) {
      const dir = path.join(TRUNCATION_DIR, `${ToolID.ascending()}_media`)
      yield* Effect.forEach(attachments, (attachment, index) =>
        fs.writeWithDirs(path.join(dir, `${index + 1}${mediaExtension(attachment.mime)}`), attachmentBytes(attachment)),
      )
      return dir
    })

    const result = Effect.fn("Truncate.result")(function* (
      input: { output: string; attachments?: Attachment[]; outputPath?: string },
      options: { model?: { providerID: string } } = {},
      agent?: Agent.Info,
    ) {
      const attachments = input.attachments ?? []
      const model = options.model ?? { providerID: "" }
      const fitted = ImageTokens.fitToolResult({ text: input.output, attachments }, model)
      if (!fitted.truncated) return { output: input.output, attachments, metadata: { truncated: false } }

      // 260924 Red 已由工具保存的完整输出不能用预览覆盖；新结果则先写盘再为 notice 做第二遍预算。
      const outputPath = input.outputPath || (yield* spill(write(input.output)))
      const mediaPath = fitted.dropped.length > 0 ? yield* spill(writeMedia(fitted.dropped)) : undefined

      const saved = [
        outputPath ? `Full output saved to: ${outputPath}` : "The full output could not be saved to disk.",
        fitted.dropped.length > 0
          ? `${fitted.dropped.length} attachment(s) omitted to fit the model-visible token budget${
              mediaPath ? `; saved to: ${mediaPath}` : " and could not be saved"
            }.`
          : undefined,
      ].filter((line): line is string => line !== undefined)

      const hint = hasTaskTool(agent)
        ? "Use the Task tool to have explore agent process this file with Grep and Read (with offset/limit). Do NOT read the full file yourself - delegate to save context."
        : "Use Grep to search the full content or Read with offset/limit to view specific sections."
      const notice = `The tool call succeeded but the output was truncated to fit the model-visible token budget. ${saved.join(" ")}\n${hint}`

      // notice 本身也进模型上下文，带着它重新 fit 一遍，别让提示把总账顶过线
      const final = ImageTokens.fitToolResult({ text: input.output, attachments }, model, { notice })
      return {
        output: `${final.text}\n\n${notice}`,
        attachments: final.attachments,
        metadata: {
          truncated: true,
          ...(outputPath && { outputPath }),
          ...(mediaPath && { mediaPath }),
        },
      }
    })

    yield* cleanup().pipe(
      Effect.catchCause((cause) => {
        log.error("truncation cleanup failed", { cause: Cause.pretty(cause) })
        return Effect.void
      }),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped,
    )

    return Service.of({ cleanup, write, output, result, limits })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppFileSystem.defaultLayer), Layer.provide(NodePath.layer))

// 260817 Red 双端预览 helper：单端收集预览行。
// fromTail=false 从前往后；skip 跳过前 N 行（tail 收集时避免与 head 重叠）。
function collectPreview(
  lines: string[],
  maxLines: number,
  maxBytes: number,
  fromTail: boolean,
  skip = 0,
): { preview: string[]; bytes: number; hitBytes: boolean; count: number } {
  const preview: string[] = []
  let bytes = 0
  let hitBytes = false
  if (fromTail) {
    for (let i = lines.length - 1; i >= skip && preview.length < maxLines; i--) {
      const size = Buffer.byteLength(lines[i], "utf-8") + (preview.length > 0 ? 1 : 0)
      if (bytes + size > maxBytes) {
        hitBytes = true
        break
      }
      preview.unshift(lines[i])
      bytes += size
    }
  } else {
    for (let i = 0; i < lines.length && preview.length < maxLines; i++) {
      const size = Buffer.byteLength(lines[i], "utf-8") + (preview.length > 0 ? 1 : 0)
      if (bytes + size > maxBytes) {
        hitBytes = true
        break
      }
      preview.push(lines[i])
      bytes += size
    }
  }
  return { preview, bytes, hitBytes, count: preview.length }
}

const MEDIA_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
  "application/pdf": ".pdf",
}

function mediaExtension(mime: string) {
  return MEDIA_EXTENSIONS[mime] ?? ".bin"
}

/** data: URL 解码成字节；非 data: URL（远程地址）就把 URL 本身当文本留下。 */
function attachmentBytes(attachment: Attachment): Uint8Array {
  if (!attachment.url.startsWith("data:")) return new TextEncoder().encode(attachment.url)
  const comma = attachment.url.indexOf(",")
  return new Uint8Array(Buffer.from(comma === -1 ? attachment.url : attachment.url.slice(comma + 1), "base64"))
}

export * as Truncate from "./truncate"
