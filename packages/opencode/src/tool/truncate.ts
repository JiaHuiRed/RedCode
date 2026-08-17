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
   * Resolved truncation limits: values from `tool_output` in redcode config, or MAX_LINES / MAX_BYTES if unset.
   */
  readonly limits: () => Effect.Effect<{ maxLines: number; maxBytes: number }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Truncate") {}

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
        if (Identifier.timestamp(entry) >= cutoff) continue
        yield* fs.remove(path.join(TRUNCATION_DIR, entry)).pipe(Effect.catch(() => Effect.void))
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

      const removed = Math.max(0, (head.hitBytes || tail.hitBytes ? totalBytes - head.bytes - tail.bytes : lines.length - head.count - tail.count))
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

    yield* cleanup().pipe(
      Effect.catchCause((cause) => {
        log.error("truncation cleanup failed", { cause: Cause.pretty(cause) })
        return Effect.void
      }),
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped,
    )

    return Service.of({ cleanup, write, output, limits })
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

export * as Truncate from "./truncate"
