import { Effect, Option, Schema, Scope, Stream } from "effect"
import { NonNegativeInt } from "@redcode-ai/core/schema"
import * as path from "path"
import * as Tool from "./tool"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { LSP } from "@/lsp/lsp"
import DESCRIPTION from "./read.md"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Instruction } from "../session/instruction"
import { isPdfAttachment, sniffAttachmentMime } from "@/util/media"
import { Reference } from "@/reference/reference"
import { Hash } from "@redcode-ai/core/util/hash"
import * as Bom from "@/util/bom"
import { Service as SnippetService, type Snippet } from "@/session/snippet"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_BYTES = 50 * 1024
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`
// 这份采样同时用于 mime 嗅探、二进制判定和编码嗅探。必须与 Bom.SNIFF_BYTES 相等 ——
// edit 那边用 Bom.decode 按同样长度嗅同样的头部，两边不等就会在非 UTF-8 文件上对不上
// tag。bom.test.ts 有一条测试钉住这个等式。
const SAMPLE_BYTES = Bom.SNIFF_BYTES
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])

class ReadStop extends Schema.TaggedErrorClass<ReadStop>()("ReadStop", {}) {}

// 260709 Red snippet 符号提取：正则扫描常见语言的顶层声明，返回 { name, startLine } 列表。
// 不依赖 LSP，快且普适。只提取顶层符号（行首或仅缩进 export）。
const SYMBOL_PATTERNS: Array<{ re: RegExp; exts: Set<string> }> = [
  // TS/JS: function, class, interface, type, enum, const/let/var (顶层)
  {
    re: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?\s+(\w+)|class\s+(\w+)|interface\s+(\w+)|type\s+(\w+)\s*[=<{]|enum\s+(\w+)|(?:const|let|var)\s+(\w+)\s*[=:])/,
    exts: new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]),
  },
  // Python: def, class
  {
    re: /^(?:async\s+)?(?:def\s+(\w+)|class\s+(\w+))/,
    exts: new Set([".py", ".pyi"]),
  },
  // Go: func, type
  {
    re: /^(?:func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)|type\s+(\w+)\s)/,
    exts: new Set([".go"]),
  },
  // Rust: fn, struct, enum, trait, impl
  {
    re: /^(?:pub(?:\(crate\))?\s+)?(?:async\s+)?(?:fn\s+(\w+)|struct\s+(\w+)|enum\s+(\w+)|trait\s+(\w+)|impl(?:<[^>]*>)?\s+(\w+))/,
    exts: new Set([".rs"]),
  },
]

interface ExtractedSymbol {
  name: string
  line: number // 1-indexed
}

function extractSymbols(lines: string[], ext: string): ExtractedSymbol[] {
  const results: ExtractedSymbol[] = []
  const seen = new Set<string>()
  for (const { re, exts } of SYMBOL_PATTERNS) {
    if (!exts.has(ext)) continue
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i])
      if (!m) continue
      const name = m.slice(1).find(Boolean)
      if (!name || seen.has(name)) continue
      seen.add(name)
      results.push({ name, line: i + 1 })
    }
    break // 只匹配第一个适用的语言模式
  }
  return results
}

// `offset` and `limit` were originally `z.coerce.number()` — the runtime
// coercion was useful when the tool was called from a shell but serves no
// purpose in the LLM tool-call path (the model emits typed JSON). The JSON
// Schema output is identical (`type: "number"`), so the LLM view is
// unchanged; purely CLI-facing uses must now send numbers rather than strings.
export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file or directory to read" }),
  offset: Schema.optional(NonNegativeInt).annotate({
    description: "The line number to start reading from (1-indexed)",
  }),
  limit: Schema.optional(NonNegativeInt).annotate({
    description: "The maximum number of lines to read (defaults to 2000)",
  }),
})

export const ReadTool = Tool.define(
  "read",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const instruction = yield* Instruction.Service
    const lsp = yield* LSP.Service
    const reference = yield* Reference.Service
    const snippetService = yield* SnippetService
    const scope = yield* Scope.Scope

    const miss = Effect.fn("ReadTool.miss")(function* (filepath: string) {
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)
      const items = yield* fs.readDirectory(dir).pipe(
        Effect.map((items) =>
          items
            .filter(
              (item) =>
                item.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(item.toLowerCase()),
            )
            .map((item) => path.join(dir, item))
            .slice(0, 3),
        ),
        Effect.catch(() => Effect.succeed([] as string[])),
      )

      if (items.length > 0) {
        return yield* Effect.fail(
          new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${items.join("\n")}`),
        )
      }

      return yield* Effect.fail(new Error(`File not found: ${filepath}`))
    })

    const list = Effect.fn("ReadTool.list")(function* (filepath: string) {
      const items = yield* fs.readDirectoryEntries(filepath)
      return yield* Effect.forEach(
        items,
        Effect.fnUntraced(function* (item) {
          if (item.type === "directory") return item.name + "/"
          if (item.type !== "symlink") return item.name

          const target = yield* fs.stat(path.join(filepath, item.name)).pipe(Effect.catch(() => Effect.void))
          if (target?.type === "Directory") return item.name + "/"
          return item.name
        }),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((items: string[]) => items.sort((a, b) => a.localeCompare(b))))
    })

    const warm = Effect.fn("ReadTool.warm")(function* (filepath: string) {
      yield* lsp.touchFile(filepath).pipe(Effect.ignore, Effect.forkIn(scope))
    })

    const readSample = Effect.fn("ReadTool.readSample")(function* (
      filepath: string,
      fileSize: number,
      sampleSize: number,
    ) {
      if (fileSize === 0) return new Uint8Array()

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(filepath, { flag: "r" })
          return Option.getOrElse(yield* file.readAlloc(Math.min(sampleSize, fileSize)), () => new Uint8Array())
        }),
      )
    })

    const lines = Effect.fn("ReadTool.lines")(function* (
      filepath: string,
      opts: { limit: number; offset: number; encoding: string },
    ) {
      const start = opts.offset - 1
      const raw: string[] = []
      const flags = { bytes: 0, count: 0, cut: false, more: false, done: false }

      // Note: prefer manual TextDecoder over Stream.decodeText — when the source stream
      // ends without flushing, decodeText drops the final unterminated line. We also
      // avoid Stream.runForEachWhile (it currently swallows the final unterminated
      // line of the upstream splitLines pipeline) and use a tagged error to stop the
      // upstream file stream as soon as the byte cap is reached.
      const decoder = new TextDecoder(opts.encoding)
      // 260728 Karina 顺路把文件指纹算了：只要这趟流没被 ReadStop 掐断，读到的就是全文，
      // 指纹直接可用，省掉此前为了 4 个字符的 tag 再把整个文件全量读进内存一遍那趟。
      // 被掐断时指纹只覆盖了前半截，作废，由调用方走 fingerprint() 重算。
      const hasher = Hash.fileTagStream()
      yield* fs.stream(filepath).pipe(
        Stream.map((bytes) => {
          const text = decoder.decode(bytes, { stream: true })
          hasher.update(text)
          return text
        }),
        Stream.splitLines,
        Stream.runForEach((text) =>
          Effect.gen(function* () {
            if (flags.done) return yield* new ReadStop()
            flags.count += 1
            if (flags.count <= start) return

            if (raw.length >= opts.limit) {
              flags.more = true
              return
            }

            const line = text.length > MAX_LINE_LENGTH ? text.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : text
            const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
            if (flags.bytes + size <= MAX_BYTES) {
              raw.push(line)
              flags.bytes += size
              return
            }

            flags.cut = true
            flags.more = true
            flags.done = true
            return yield* new ReadStop()
          }),
        ),
        Effect.catchTag("ReadStop", () => Effect.void),
      )

      if (!flags.done) hasher.update(decoder.decode())
      return {
        raw,
        count: flags.count,
        cut: flags.cut,
        more: flags.more,
        offset: opts.offset,
        tag: flags.done ? undefined : hasher.digest(),
      }
    })

    // 260728 Karina 流式补算文件指纹，只在 lines() 提前掐断时才用得上。
    // 此前 read 无条件走 Bom.readFile + Hash.fileTag，为了 4 个字符的 tag 把整个文件读进
    // 内存再全量解码一遍，把 lines() 的 50KB/2000 行截断白白抵消（300MB 日志照样吃满内存）。
    // tag 必须覆盖全文 —— edit 用全文算 currentHash 校验陈旧度 —— 所以这趟读省不掉，但可以不驻留。
    // TextDecoder 默认 ignoreBOM=false 会自动吃掉 BOM，与 Bom.readFile 的 split() 一致。
    const fingerprint = Effect.fn("ReadTool.fingerprint")(function* (filepath: string, encoding: string) {
      const decoder = new TextDecoder(encoding)
      const hasher = Hash.fileTagStream()
      yield* fs
        .stream(filepath)
        .pipe(Stream.runForEach((bytes) => Effect.sync(() => hasher.update(decoder.decode(bytes, { stream: true })))))
      hasher.update(decoder.decode())
      return hasher.digest()
    })

    const isBinaryFile = (filepath: string, bytes: Uint8Array) => {
      const ext = path.extname(filepath).toLowerCase()
      switch (ext) {
        case ".zip":
        case ".tar":
        case ".gz":
        case ".exe":
        case ".dll":
        case ".so":
        case ".class":
        case ".jar":
        case ".war":
        case ".7z":
        case ".doc":
        case ".docx":
        case ".xls":
        case ".xlsx":
        case ".ppt":
        case ".pptx":
        case ".odt":
        case ".ods":
        case ".odp":
        case ".bin":
        case ".dat":
        case ".obj":
        case ".o":
        case ".a":
        case ".lib":
        case ".wasm":
        case ".pyc":
        case ".pyo":
          return true
      }

      if (bytes.length === 0) return false

      let nonPrintableCount = 0
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0) return true
        if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
          nonPrintableCount++
        }
      }

      return nonPrintableCount / bytes.length > 0.3
    }

    const run = Effect.fn("ReadTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const instance = yield* InstanceState.context
      let filepath = params.filePath
      if (!path.isAbsolute(filepath)) {
        filepath = path.resolve(instance.directory, filepath)
      }
      if (process.platform === "win32") {
        filepath = AppFileSystem.normalizePath(filepath)
      }
      yield* reference.ensure(filepath)
      const title = path.relative(instance.worktree, filepath)

      const stat = yield* fs.stat(filepath).pipe(
        Effect.catchIf(
          (err) => "reason" in err && err.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      )

      yield* assertExternalDirectoryEffect(ctx, filepath, {
        bypass: Boolean(ctx.extra?.["bypassCwdCheck"]) || (yield* reference.contains(filepath)),
        kind: stat?.type === "Directory" ? "directory" : "file",
      })

      yield* ctx.ask({
        permission: "read",
        patterns: [path.relative(instance.worktree, filepath)],
        always: ["*"],
        metadata: {},
      })

      if (!stat) return yield* miss(filepath)

      if (stat.type === "Directory") {
        const items = yield* list(filepath)
        const limit = params.limit ?? DEFAULT_READ_LIMIT
        const offset = params.offset || 1
        const start = offset - 1
        const sliced = items.slice(start, start + limit)
        const truncated = start + sliced.length < items.length

        return {
          title,
          output: [
            `<path>${filepath}</path>`,
            `<type>directory</type>`,
            `<entries>`,
            sliced.join("\n"),
            truncated
              ? `\n(Showing ${sliced.length} of ${items.length} entries. Use 'offset' parameter to read beyond entry ${offset + sliced.length})`
              : `\n(${items.length} entries)`,
            `</entries>`,
          ].join("\n"),
          metadata: {
            preview: sliced.slice(0, 20).join("\n"),
            truncated,
            loaded: [] as string[],
          },
        }
      }

      const loaded = yield* instruction.resolve(ctx.messages, filepath, ctx.messageID)
      const sample = yield* readSample(filepath, Number(stat.size), SAMPLE_BYTES)

      const mime = sniffAttachmentMime(sample, AppFileSystem.mimeType(filepath))
      const isImage = SUPPORTED_IMAGE_MIMES.has(mime)

      if (isImage || isPdfAttachment(mime)) {
        const bytes = yield* fs.readFile(filepath)
        const msg = isPdfAttachment(mime) ? "PDF read successfully" : "Image read successfully"
        return {
          title,
          output: msg,
          metadata: {
            preview: msg,
            truncated: false,
            loaded: loaded.map((item) => item.filepath),
          },
          attachments: [
            {
              type: "file" as const,
              mime,
              url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
            },
          ],
        }
      }

      if (isBinaryFile(filepath, sample)) {
        return yield* Effect.fail(new Error(`Cannot read binary file: ${filepath}`))
      }

      // 260730 Karina 编码检测：拿上面那份采样嗅一次，整趟流和补算指纹都用它。
      // 判定规则与 Bom.sniff 共用 —— read 产 [path#TAG]、edit 用 Bom.decode 算
      // currentHash，两边解码方式只要不一致，非 UTF-8 文件就会次次 hash mismatch。
      const encoding = Bom.sniff(sample)
      const file = yield* lines(filepath, {
        limit: params.limit ?? DEFAULT_READ_LIMIT,
        offset: params.offset || 1,
        encoding,
      })
      if (file.count < file.offset && !(file.count === 0 && file.offset === 1)) {
        return yield* Effect.fail(
          new Error(`Offset ${file.offset} is out of range for this file (${file.count} lines)`),
        )
      }

      const fileTag = file.tag ?? (yield* fingerprint(filepath, encoding))

      let output = [`<path>${filepath}</path>`, `<type>file</type>`, `[${filepath}#${fileTag}]`, "<content>\n"].join("\n")
      output += file.raw.map((line, i) => `${i + file.offset}: ${line}`).join("\n")

      const last = file.offset + file.raw.length - 1
      const next = last + 1
      const truncated = file.more || file.cut
      if (file.cut) {
        output += `\n\n(Output capped at ${MAX_BYTES_LABEL}. Showing lines ${file.offset}-${last}. Use offset=${next} to continue.)`
      } else if (file.more) {
        output += `\n\n(Showing lines ${file.offset}-${last} of ${file.count}. Use offset=${next} to continue.)`
      } else {
        output += `\n\n(End of file - total ${file.count} lines)`
      }
      output += "\n</content>"

      // 260709 Red snippet 注册：从读到的行提取符号，注册为 snippet，附索引到输出
      const ext = path.extname(filepath).toLowerCase()
      const symbols = extractSymbols(file.raw, ext)
      if (symbols.length > 0) {
        const snippets: Snippet[] = symbols.map((sym, idx) => {
          const nextStart = idx + 1 < symbols.length ? symbols[idx + 1].line - 1 : file.raw.length
          const startLine = sym.line + (file.offset - 1)
          const endLine = nextStart + (file.offset - 1)
          return {
            id: `${sym.name}_L${startLine}`,
            name: sym.name,
            file: filepath,
            startLine,
            endLine,
          }
        })
        yield* Effect.forEach(snippets, (s) => snippetService.register(ctx.messageID, s))
        output += "\n<snippets>\n"
        output += snippets.map((s) => `  ${s.id}  L${s.startLine}-${s.endLine}  ${s.name}`).join("\n")
        output += "\n</snippets>"
      }

      yield* warm(filepath)

      if (loaded.length > 0) {
        output += `\n\n<system-reminder>\n${loaded.map((item) => item.content).join("\n\n")}\n</system-reminder>`
      }

      return {
        title,
        output,
        metadata: {
          preview: file.raw.slice(0, 20).join("\n"),
          truncated,
          loaded: loaded.map((item) => item.filepath),
        },
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
