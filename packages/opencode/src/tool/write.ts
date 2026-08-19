import { Schema } from "effect"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.md" with { type: "text" }
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Format } from "../format"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import { trimDiff } from "./edit"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Bom from "@/util/bom"
import { FileTime } from "@/file/time"

const MAX_PROJECT_DIAGNOSTICS_FILES = 5

export const Parameters = Schema.Struct({
  content: Schema.String.annotate({ description: "The content to write to the file" }),
  filePath: Schema.String.annotate({
    description: "The absolute path to the file to write (must be absolute, not relative)",
  }),
})

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* AppFileSystem.Service
    const bus = yield* Bus.Service
    const format = yield* Format.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { content: string; filePath: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          // 260810 cc: isAbsolute 对 "\users\foo" 有根无盘符路径返回 true，见 AppFileSystem.resolveFrom
          const filepath = AppFileSystem.resolveFrom(instance.directory, params.filePath)
          yield* assertExternalDirectoryEffect(ctx, filepath)

          const exists = yield* fs.existsSafe(filepath)
          // 260810 cc audit R2: 覆盖已有文件前必须本会话 read 过且此后无外部改动，
          // 防止拿旧内容把 IDE 手改/并行会话的落盘整个推平。新建文件不设限。
          if (exists) yield* FileTime.assert(ctx.sessionID, filepath)
          const source = exists ? yield* Bom.readFile(fs, filepath) : { bom: false, text: "", encoding: "utf-8" }
          const next = Bom.split(params.content)
          const desiredBom = source.bom || next.bom
          const contentOld = source.text
          const contentNew = next.text

          // 260730 Karina 编码护栏：非 UTF-8 的原文一律不写回，否则等于悄悄转编码
          const changed = exists ? Bom.detectEncodingChange(source.encoding) : undefined
          if (changed)
            return yield* Effect.fail(
              new Error(
                `拒绝写入 ${filepath}：${changed}。若确实要转成 UTF-8，请先明确告知用户并由其确认；只想改内容就换用能保留原编码的方式。`,
              ),
            )

          // 260616 Red 乱码护栏：拒绝把乱码内容写入文件（GBK 错解 UTF-8 的 PUA/替换符）
          const garbled = Bom.detectGarbled(contentNew)
          if (garbled)
            return yield* Effect.fail(
              new Error(
                `拒绝写入 ${filepath}：${garbled}。多半是用了错误编码(如 GBK)读取后又写回。请用 read 工具重新读取原文（UTF-8），不要把乱码内容写回。`,
              ),
            )

          // 260730 Karina 行尾回车膨胀护栏：`\r\r\n` 在编辑器/浏览器眼里是两个换行
          const bloat = Bom.detectCrBloat(contentNew, contentOld)
          if (bloat)
            return yield* Effect.fail(
              new Error(`拒绝写入 ${filepath}：${bloat}。请去掉多余的 \\r，或用 read 重读原文后再写。`),
            )

          const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, contentNew))
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: {
              filepath,
              diff,
            },
          })

          yield* fs.writeWithDirs(filepath, Bom.join(contentNew, desiredBom))
          if (yield* format.file(filepath)) {
            yield* Bom.syncFile(fs, filepath, desiredBom)
          }
          yield* FileTime.record(ctx.sessionID, filepath)
          yield* bus.publish(File.Event.Edited, { file: filepath })
          yield* bus.publish(FileWatcher.Event.Updated, {
            file: filepath,
            event: exists ? "change" : "add",
          })

          let output = "Wrote file successfully."
          yield* lsp.touchFile(filepath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilepath = AppFileSystem.normalizePath(filepath)
          let projectDiagnosticsCount = 0
          for (const [file, issues] of Object.entries(diagnostics)) {
            const current = file === normalizedFilepath
            if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
            const block = LSP.Diagnostic.report(current ? filepath : file, issues)
            if (!block) continue
            if (current) {
              output += `\n\nLSP errors detected in this file, please fix:\n${block}`
              continue
            }
            projectDiagnosticsCount++
            output += `\n\nLSP errors detected in other files:\n${block}`
          }

          return {
            title: path.relative(instance.worktree, filepath),
            metadata: {
              diagnostics,
              filepath,
              exists: exists,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
