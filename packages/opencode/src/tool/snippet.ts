import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { Hash } from "@redcode-ai/core/util/hash"
import { Effect, Schema } from "effect"
import * as path from "path"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import type { Snippet } from "@/session/snippet"
import { Service as SnippetService } from "@/session/snippet"
import * as Bom from "@/util/bom"
import DESCRIPTION from "./snippet.md"

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({
    description: "The absolute path to the file",
  }),
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
            throw new Error(
              `Snippet not found: "${params.snippetId}". Re-read the file to get current snippet IDs.`,
            )
          }

          const source = yield* Bom.readFile(afs, snippet.file)
          const lines = source.text.split("\n")
          const content = lines.slice(snippet.startLine - 1, snippet.endLine).join("\n")

          return {
            title: `${snippet.name} (${snippet.startLine}-${snippet.endLine})`,
            output: content,
            metadata: { snippet },
          }
        }).pipe(Effect.orDie),
    }
  }).pipe(Effect.orDie),
)
