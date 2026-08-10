import path from "path"
import { Schema } from "effect"
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./ast_grep.md" with { type: "text" }
import * as Tool from "./tool"
import { Reference } from "@/reference/reference"
import { LSP } from "@/lsp/lsp"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Format } from "@/format"
import { Bus } from "../bus"
import { Glob } from "@redcode-ai/core/util/glob"
import { createTwoFilesPatch } from "diff"
import * as Bom from "@/util/bom"
import type { SgRoot, SgNode } from "@ast-grep/napi"

type AstGrepModule = typeof import("@ast-grep/napi")

const MAX_LINE_LENGTH = 2000

/** Expand meta-variables ($NAME, $A, $$$) in a replacement string using captured node values */
function expandReplaceTemplate(template: string, node: SgNode): string {
  return template.replace(/\$\$\$|\$([A-Z_][A-Z0-9_]*)/g, (match, name) => {
    if (match === "$$$") {
      const rest = node.getMatch("$$$")
      return rest?.text() ?? match
    }
    const captured = node.getMatch(name)
    return captured?.text() ?? match
  })
}

const LANG_MAP: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  html: "html",
  css: "css",
  typescript: "ts",
  javascript: "js",
}

const EXT_LANG: Record<string, string> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".jsx": "jsx",
  ".mjs": "js",
  ".cjs": "js",
  ".mts": "ts",
  ".cts": "ts",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".vue": "tsx",
  ".svelte": "tsx",
}

function resolveLang(ag: AstGrepModule, language: string) {
  const key = LANG_MAP[language.toLowerCase()]
  if (!key) return undefined
  return (ag as any)[key] as { parse(src: string): SgRoot; pattern(p: string): any; findInFiles?: Function } | undefined
}

function extToLang(ext: string): string | undefined {
  return EXT_LANG[ext.toLowerCase()]
}

interface SearchMatch {
  file: string
  line: number
  column: number
  text: string
}

interface FileEdit {
  file: string
  original: string
  modified: string
  count: number
}

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({
    description:
      "AST pattern to search for. Uses ast-grep pattern syntax with meta-variables ($A, $B, $$$). " +
      'Examples: console.log($A), function $NAME($$$) {$$$}, if ($A === $B) {$$$}, `import { $$$ } from "$A"`',
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "The directory or file to search in. Defaults to the current working directory.",
  }),
  include: Schema.optional(Schema.String).annotate({
    description: 'File pattern to include (e.g. "*.ts", "*.{ts,tsx}"). Uses gitignore-style glob.',
  }),
  language: Schema.optional(Schema.String).annotate({
    description:
      "Programming language. Auto-detected from file extension when omitted. " +
      "Set explicitly when the pattern spans multiple languages or extension detection is ambiguous. " +
      "Supported: ts, tsx, js, jsx, html, css.",
  }),
  replace: Schema.optional(Schema.String).annotate({
    description:
      "Replacement pattern using meta-variables from the search pattern ($A, $B, $$$, etc.). " +
      "When provided, performs AST-aware find-and-replace. Shows a diff preview and asks for confirmation. " +
      "Example: pattern=`console.log($A)` replace=`logger.debug($A)` will rewrite all console.log calls to logger.debug calls.",
  }),
})

export const AstGrepTool = Tool.define(
  "ast_grep",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const reference = yield* Reference.Service
    const lsp = yield* LSP.Service
    const format = yield* Format.Service
    const bus = yield* Bus.Service
    // 260612 Red lazy load — native binding crashes bun-compiled binary if imported at init
    let _ag: AstGrepModule | undefined
    const getAg = () =>
      _ag
        ? Effect.succeed(_ag)
        : Effect.gen(function* () {
            const m = yield* Effect.tryPromise({
              try: () => import("@ast-grep/napi") as Promise<AstGrepModule>,
              catch: () => new Error("Failed to load @ast-grep/napi"),
            })
            _ag = m
            return m
          })

    const searchInFiles = Effect.fn("AstGrep.search")(function* (
      pattern: string,
      dir: string,
      includeGlob: string | undefined,
      langOverride: string | undefined,
      ctx: Tool.Context,
    ) {
      const ag = yield* getAg()
      let files: string[]
      const info = yield* fs.stat(dir).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!info) return { output: `Path not found: ${dir}`, matches: [] as SearchMatch[] }
      if (info.type === "Directory") {
        files = Glob.scanSync(includeGlob ?? "**/*", { cwd: dir, absolute: true, dot: true })
          .filter((f) => !!path.extname(f).toLowerCase())
          .slice(0, 500)
      } else {
        files = [dir]
      }

      if (files.length === 0) return { output: "No files matched.", matches: [] as SearchMatch[] }

      const allMatches: SearchMatch[] = []
      for (const file of files) {
        const stat = yield* fs.stat(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!stat || stat.type !== "File") continue
        if ((stat.size ?? 0) > 1024 * 1024) continue

        const source = yield* Bom.readFile(fs, file).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!source || !source.text) continue

        const ext = path.extname(file)
        const langStr = langOverride ?? (ext ? extToLang(ext) : undefined)
        if (!langStr) continue
        const mod = resolveLang(ag, langStr)
        if (!mod) continue

        try {
          const root = mod.parse(source.text)
          const config = mod.pattern(pattern)
          const nodes = root.root().findAll(config) as SgNode[]
          for (const n of nodes) {
            const r = n.range()
            allMatches.push({
              file: AppFileSystem.resolve(file),
              line: r.start.line + 1,
              column: r.start.column + 1,
              text: n.text().length > 120 ? n.text().slice(0, 120) + "..." : n.text(),
            })
          }
        } catch {
          // skip per-file parse errors
        }
      }
      return { output: "", matches: allMatches }
    })

    const replaceInFiles = Effect.fn("AstGrep.replace")(function* (
      pattern: string,
      replacement: string,
      dir: string,
      includeGlob: string | undefined,
      langOverride: string | undefined,
      ctx: Tool.Context,
    ) {
      const ag = yield* getAg()
      let files: string[]
      const info = yield* fs.stat(dir).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!info) return { output: `Path not found: ${dir}`, files: [] as FileEdit[] }
      if (info.type === "Directory") {
        files = Glob.scanSync(includeGlob ?? "**/*", { cwd: dir, absolute: true, dot: true })
          .filter((f) => !!path.extname(f).toLowerCase())
          .slice(0, 500)
      } else {
        files = [dir]
      }

      if (files.length === 0) return { output: "No files matched.", files: [] as FileEdit[] }

      const edited: FileEdit[] = []
      for (const file of files) {
        const stat = yield* fs.stat(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!stat || stat.type !== "File") continue
        if ((stat.size ?? 0) > 1024 * 1024) continue

        const source = yield* Bom.readFile(fs, file).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!source || !source.text) continue

        const ext = path.extname(file)
        const langStr = langOverride ?? (ext ? extToLang(ext) : undefined)
        if (!langStr) continue
        const mod = resolveLang(ag, langStr)
        if (!mod) continue

        try {
          const root = mod.parse(source.text)
          const config = mod.pattern(pattern)
          const nodes = root.root().findAll(config) as SgNode[]
          if (nodes.length === 0) continue

          // 260730 Karina 非 UTF-8 的文件不改：下面 writeWithDirs 只会写 UTF-8，
          // 改了就等于悄悄把人家的 GBK 文件转了编码。搜索那条路径不受影响，只读不写。
          if (Bom.detectEncodingChange(source.encoding)) continue

          const edits = nodes.map((n: SgNode) => n.replace(expandReplaceTemplate(replacement, n)))
          const modified = root.root().commitEdits(edits)
          if (modified !== source.text) {
            edited.push({ file: AppFileSystem.resolve(file), original: source.text, modified, count: nodes.length })
          }
        } catch {
          // skip per-file parse errors
        }
      }
      return { output: "", files: edited }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: {
        pattern: string
        path?: string
        include?: string
        language?: string
        replace?: string
      }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "grep",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
              include: params.include,
              replace: params.replace,
            },
          })

          const ins = yield* InstanceState.context
          const requested = AppFileSystem.resolveFrom(ins.directory, params.path ?? ".")
          yield* reference.ensure(requested)
          const requestedInfo = yield* fs.stat(requested).pipe(Effect.catch(() => Effect.succeed(undefined)))
          yield* assertExternalDirectoryEffect(ctx, requested, {
            bypass: yield* reference.contains(requested),
            kind: requestedInfo?.type === "Directory" ? "directory" : "file",
          })
          const resolved = AppFileSystem.resolve(requested)

          if (params.replace) {
            const result = yield* replaceInFiles(
              params.pattern,
              params.replace,
              resolved,
              params.include,
              params.language,
              ctx,
            )
            if (result.files.length === 0) {
              return { title: params.pattern, metadata: { matches: 0, replaced: 0, truncated: false }, output: result.output || "No matches found." }
            }

            let totalReplaced = 0
            const diffs: string[] = []
            for (const fe of result.files) {
              const patch = createTwoFilesPatch(fe.file, fe.file, fe.original, fe.modified)
              diffs.push(patch)
              totalReplaced += fe.count
            }
            const preview = diffs.join("\n").slice(0, 10000)

            yield* ctx.ask({
              permission: "edit",
              patterns: result.files.map((f) => path.relative(ins.worktree, f.file)),
              always: ["*"],
              metadata: { filepath: result.files.length > 1 ? result.files[0].file : result.files[0].file, diff: preview },
            })

            for (const fe of result.files) {
              yield* fs.writeWithDirs(fe.file, Bom.join(fe.modified, false))
              if (yield* format.file(fe.file)) {
                yield* Bom.syncFile(fs, fe.file, false)
              }
              yield* bus.publish(File.Event.Edited, { file: fe.file })
            }

            return {
              title: params.pattern,
              metadata: { matches: totalReplaced, replaced: totalReplaced, truncated: false },
              output: `Applied ${totalReplaced} AST replacements across ${result.files.length} files.`,
            }
          }

          // Search mode
          const search = yield* searchInFiles(params.pattern, resolved, params.include, params.language, ctx)
          const { matches } = search
          if (matches.length === 0) {
            return { title: params.pattern, metadata: { matches: 0, replaced: 0, truncated: false }, output: "No matches found." }
          }

          const limit = 150
          const truncated = matches.length > limit
          const display = truncated ? matches.slice(0, limit) : matches
          const lines: string[] = [
            `Found ${matches.length} AST pattern matches${truncated ? ` (showing first ${limit})` : ""}`,
          ]
          let current = ""
          for (const m of display) {
            if (current !== m.file) {
              if (current) lines.push("")
              current = m.file
              lines.push(`${m.file}:`)
            }
            lines.push(`  Line ${m.line}:${m.column}: ${m.text}`)
          }
          if (truncated) {
            lines.push("")
            lines.push(`(Results truncated: showing ${limit} of ${matches.length} matches.)`)
          }

          return {
            title: params.pattern,
            metadata: { matches: matches.length, replaced: 0, truncated },
            output: lines.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
