import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { Hash } from "@redcode-ai/core/util/hash"
import { Effect, Schema } from "effect"
import * as path from "path"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import type { Snippet } from "@/session/snippet"
import { Service as SnippetService } from "@/session/snippet"
import * as Bom from "@/util/bom"
import DESCRIPTION from "./snippet.md" with { type: "text" }

// 260709 Red snippet tool：按 snippetId 查找并返回代码片段内容，带行号前缀和 fileTag。
export const Parameters = Schema.Struct({
  snippetId: Schema.String.annotate({
    description: "The snippet ID returned by the Read tool (e.g. 'AgentRunner_L12')",
  }),
})

export const SnippetTool = Tool.define(
  "snippet",
  Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const afs = yield* AppFileSystem.Service
    const snippetService = yield* SnippetService

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const snippet = yield* snippetService.get(ctx.messageID, params.snippetId)
          if (!snippet) {
            throw new Error(`Snippet not found: "${params.snippetId}". Re-read the file to get current snippet IDs.`)
          }

          const source = yield* Bom.readFile(afs, snippet.file)
          const fileTag = Hash.fileTag(source.text)
          const lines = source.text.split("\n")
          const slice = lines.slice(snippet.startLine - 1, snippet.endLine)
          const numbered = slice.map((line, i) => `${i + snippet.startLine}: ${line}`).join("\n")
          const relPath = path.relative(instance.worktree, snippet.file)

          return {
            title: `${relPath}: ${snippet.name} (${snippet.startLine}-${snippet.endLine})`,
            output: [
              `<path>${snippet.file}</path>`,
              `[${snippet.file}#${fileTag}]`,
              `<content>`,
              numbered,
              `</content>`,
            ].join("\n"),
            metadata: { snippet },
          }
        }).pipe(Effect.orDie),
    }
  }).pipe(Effect.orDie),
)
