// the approaches in this edit tool are sourced from
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-23-25.ts
// https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/editCorrector.ts
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-26-25.ts

import * as path from "path"
import { Effect, Schema, Semaphore } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch, diffLines } from "diff"
import DESCRIPTION from "./edit.txt"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Bus } from "../bus"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { assertExternalDirectoryEffect } from "./external-directory"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import * as Bom from "@/util/bom"

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

function convertToLineEnding(text: string, ending: "\n" | "\r\n"): string {
  if (ending === "\n") return text
  return text.replaceAll("\n", "\r\n")
}

const locks = new Map<string, Semaphore.Semaphore>()

function lock(filePath: string) {
  const resolvedFilePath = AppFileSystem.resolve(filePath)
  const hit = locks.get(resolvedFilePath)
  if (hit) return hit

  const next = Semaphore.makeUnsafe(1)
  locks.set(resolvedFilePath, next)
  return next
}

function computeFileHash(text: string): string {
  const normalized = text.replace(/[ \t\r]+(?=\n|$)/g, "")
  const hash = Bun.hash.xxHash32(normalized, 0) & 0xffff
  return hash.toString(16).padStart(4, "0").toUpperCase()
}

export const Parameters = Schema.Struct({
  filePath: Schema.optional(Schema.String).annotate({
    description: "The absolute path to the file to modify",
  }),
  oldString: Schema.optional(Schema.String).annotate({
    description: "The text to replace. Not needed when using `input` (hashline format).",
  }),
  newString: Schema.optional(Schema.String).annotate({
    description: "The replacement text. Not needed when using `input` (hashline format).",
  }),
  replaceAll: Schema.optional(Schema.Boolean).annotate({
    description: "Replace all occurrences of oldString (default false)",
  }),
  input: Schema.optional(Schema.String).annotate({
    description:
      "Hashline format — a self-contained patch string. Alternative to filePath + oldString + newString.\n\n" +
      "Format:\n" +
      "  [path/to/file#TAG]\n" +
      "  replace N..M:\n" +
      "  + new content\n" +
      "  + more content\n" +
      "  insert before N:\n" +
      "  + inserted content\n" +
      "  insert after N:\n" +
      "  + inserted content\n" +
      "  delete N..M\n" +
      "  insert tail:\n" +
      "  + content at end\n" +
      "  insert head:\n" +
      "  + content at start\n\n" +
      "Body lines start with `+ `. The TAG comes from the Read tool's output header `[path#TAG]`.",
  }),
})

export const EditTool = Tool.define(
  "edit",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* AppFileSystem.Service
    const format = yield* Format.Service
    const bus = yield* Bus.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // Hashline mode — self-contained [path#TAG] + operation format
          if (params.input) {
            return yield* executeHashline(params.input, ctx, lsp, afs, format, bus)
          }

          if (!params.filePath) {
            throw new Error("filePath is required")
          }
          if (params.oldString === undefined || params.newString === undefined) {
            throw new Error("oldString and newString are required when not using hashline `input`.")
          }

          if (params.oldString === params.newString) {
            throw new Error("No changes to apply: oldString and newString are identical.")
          }

          const instance = yield* InstanceState.context
          const filePath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          yield* assertExternalDirectoryEffect(ctx, filePath)

          // Narrow optional params for TS inside nested callbacks
          const oldString: string = params.oldString
          const newString: string = params.newString

          let diff = ""
          let contentOld = ""
          let contentNew = ""
          yield* lock(filePath).withPermits(1)(
            Effect.gen(function* () {
              if (oldString === "") {
                const existed = yield* afs.existsSafe(filePath)
                const source = existed ? yield* Bom.readFile(afs, filePath) : { bom: false, text: "" }
                const next = Bom.split(newString)
                const desiredBom = source.bom || next.bom
                contentOld = source.text
                contentNew = next.text
                diff = trimDiff(createTwoFilesPatch(filePath, filePath, contentOld, contentNew))
                yield* ctx.ask({
                  permission: "edit",
                  patterns: [path.relative(instance.worktree, filePath)],
                  always: ["*"],
                  metadata: {
                    filepath: filePath,
                    diff,
                  },
                })
                yield* afs.writeWithDirs(filePath, Bom.join(contentNew, desiredBom))
                if (yield* format.file(filePath)) {
                  contentNew = yield* Bom.syncFile(afs, filePath, desiredBom)
                }
                yield* bus.publish(File.Event.Edited, { file: filePath })
                yield* bus.publish(FileWatcher.Event.Updated, {
                  file: filePath,
                  event: existed ? "change" : "add",
                })
                return
              }

              const info = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (!info) throw new Error(`File ${filePath} not found`)
              if (info.type === "Directory") throw new Error(`Path is a directory, not a file: ${filePath}`)
              const source = yield* Bom.readFile(afs, filePath)
              contentOld = source.text

              const ending = detectLineEnding(contentOld)
              const old = convertToLineEnding(normalizeLineEndings(oldString), ending)
              const replacement = convertToLineEnding(normalizeLineEndings(newString), ending)

              let replaced: string
              try {
                replaced = replace(contentOld, old, replacement, params.replaceAll)
              } catch (err) {
                if (err instanceof Error && err.message.startsWith("Could not find oldString")) {
                  const fuzzy = fuzzyFindBestMatch(contentOld, old)
                  if (fuzzy) {
                    const pct = Math.round(fuzzy.similarity * 100)
                    throw new Error(
                      `Could not find oldString exactly (${pct}% similar match found at line ${fuzzy.startLine}-${fuzzy.endLine}).\n\n` +
                        `Best matching block:\n${fuzzy.matchedText}\n\n` +
                        `Diff between your oldString and the match:\n${fuzzy.diff}\n\n` +
                        `Re-read the file to get the exact text, or adjust oldString to match the above.`,
                    )
                  }
                }
                throw err
              }
              const next = Bom.split(replaced)
              const desiredBom = source.bom || next.bom
              contentNew = next.text

              diff = trimDiff(
                createTwoFilesPatch(
                  filePath,
                  filePath,
                  normalizeLineEndings(contentOld),
                  normalizeLineEndings(contentNew),
                ),
              )
              yield* ctx.ask({
                permission: "edit",
                patterns: [path.relative(instance.worktree, filePath)],
                always: ["*"],
                metadata: {
                  filepath: filePath,
                  diff,
                },
              })

              yield* afs.writeWithDirs(filePath, Bom.join(contentNew, desiredBom))
              if (yield* format.file(filePath)) {
                contentNew = yield* Bom.syncFile(afs, filePath, desiredBom)
              }
              yield* bus.publish(File.Event.Edited, { file: filePath })
              yield* bus.publish(FileWatcher.Event.Updated, {
                file: filePath,
                event: "change",
              })
              diff = trimDiff(
                createTwoFilesPatch(
                  filePath,
                  filePath,
                  normalizeLineEndings(contentOld),
                  normalizeLineEndings(contentNew),
                ),
              )
            }).pipe(Effect.orDie),
          )

          let additions = 0
          let deletions = 0
          for (const change of diffLines(contentOld, contentNew)) {
            if (change.added) additions += change.count || 0
            if (change.removed) deletions += change.count || 0
          }
          const filediff: Snapshot.FileDiff = {
            file: filePath,
            patch: diff,
            additions,
            deletions,
          }

          yield* ctx.metadata({
            metadata: {
              diff,
              filediff,
              diagnostics: {},
            },
          })

          let output = "Edit applied successfully."
          yield* lsp.touchFile(filePath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilePath = AppFileSystem.normalizePath(filePath)
          const block = LSP.Diagnostic.report(filePath, diagnostics[normalizedFilePath] ?? [])
          if (block) output += `\n\nLSP errors detected in this file, please fix:\n${block}`

          return {
            metadata: {
              diagnostics,
              diff,
              filediff,
            },
            title: `${path.relative(instance.worktree, filePath)}`,
            output,
          }
        }),
    }
  }),
)

// --- Hashline types ---

interface HashlineOp {
  type: "replace" | "insertBefore" | "insertAfter" | "delete" | "insertHead" | "insertTail"
  startLine: number
  endLine?: number
  body: string[]
}

interface HashlinePatch {
  filePath: string
  expectedHash: string
  ops: HashlineOp[]
}

// --- Hashline parser ---

function parseHashline(input: string): HashlinePatch {
  const lines = input.replace(/\r\n/g, "\n").split("\n")
  if (lines.length === 0) throw new Error("Invalid hashline format: expected [path#TAG] on first line")

  const headerMatch = lines[0].match(/^\[(.+)#([0-9A-F]{4})\]$/)
  if (!headerMatch) throw new Error("Invalid hashline format: expected [path#TAG] on first line")

  const filePath = headerMatch[1]
  const expectedHash = headerMatch[2]
  const ops: HashlineOp[] = []

  let i = 1
  while (i < lines.length) {
    const line = lines[i].trimEnd()
    i++

    if (line === "" || line.startsWith("***")) continue

    const replaceMatch = line.match(/^replace\s+(\d+)\.\.(\d+):$/)
    const insertBeforeMatch = line.match(/^insert\s+before\s+(\d+):$/)
    const insertAfterMatch = line.match(/^insert\s+after\s+(\d+):$/)
    const deleteMatch = line.match(/^delete\s+(\d+)\.\.(\d+)$/)
    const insertHeadMatch = line.match(/^insert\s+head:$/)
    const insertTailMatch = line.match(/^insert\s+tail:$/)

    if (replaceMatch) {
      const start = parseInt(replaceMatch[1], 10)
      const end = parseInt(replaceMatch[2], 10)
      if (start > end) throw new Error(`Invalid replace range: ${start}..${end}`)
      const body = readBody(lines, i)
      i += body.length
      ops.push({ type: "replace", startLine: start, endLine: end, body })
    } else if (insertBeforeMatch) {
      const lineNum = parseInt(insertBeforeMatch[1], 10)
      const body = readBody(lines, i)
      i += body.length
      ops.push({ type: "insertBefore", startLine: lineNum, body })
    } else if (insertAfterMatch) {
      const lineNum = parseInt(insertAfterMatch[1], 10)
      const body = readBody(lines, i)
      i += body.length
      ops.push({ type: "insertAfter", startLine: lineNum, body })
    } else if (deleteMatch) {
      const start = parseInt(deleteMatch[1], 10)
      const end = parseInt(deleteMatch[2], 10)
      ops.push({ type: "delete", startLine: start, endLine: end, body: [] })
    } else if (insertHeadMatch) {
      const body = readBody(lines, i)
      i += body.length
      ops.push({ type: "insertHead", startLine: 1, body })
    } else if (insertTailMatch) {
      const body = readBody(lines, i)
      i += body.length
      ops.push({ type: "insertTail", startLine: 1, body })
    }
  }

  if (ops.length === 0) throw new Error("Invalid hashline format: no operations found")
  return { filePath, expectedHash, ops }
}

function readBody(lines: string[], fromIndex: number): string[] {
  const body: string[] = []
  for (let j = fromIndex; j < lines.length; j++) {
    if (lines[j].startsWith("+")) {
      body.push(lines[j].slice(1))
    } else if (lines[j] === "") {
      continue
    } else {
      break
    }
  }
  return body
}

// --- Hashline applier ---

function applyHashlineOps(text: string, ops: HashlineOp[]): string {
  const lines = text.split("\n")
  const total = lines.length

  // Sort by anchor line descending so edits don't shift each other's positions
  const sorted = [...ops].sort((a, b) => {
    const aIdx = opSortIndex(a, total)
    const bIdx = opSortIndex(b, total)
    if (bIdx !== aIdx) return bIdx - aIdx
    return a.type === "delete" ? 0 : 1
  })

  for (const op of sorted) {
    const count = lines.length

    switch (op.type) {
      case "replace": {
        const idx = op.startLine - 1
        if (idx < 0 || op.endLine! > count)
          throw new Error(`Replace ${op.startLine}..${op.endLine} out of range: file has ${count} lines`)
        lines.splice(idx, op.endLine! - op.startLine + 1, ...op.body)
        break
      }
      case "delete": {
        const idx = op.startLine - 1
        if (idx < 0 || op.endLine! > count)
          throw new Error(`Delete ${op.startLine}..${op.endLine} out of range: file has ${count} lines`)
        lines.splice(idx, op.endLine! - op.startLine + 1)
        break
      }
      case "insertBefore": {
        const idx = op.startLine - 1
        if (idx < 0 || idx > count)
          throw new Error(`Insert before ${op.startLine} out of range: file has ${count} lines`)
        lines.splice(idx, 0, ...op.body)
        break
      }
      case "insertAfter": {
        const idx = op.startLine
        if (idx < 0 || idx > count)
          throw new Error(`Insert after ${op.startLine} out of range: file has ${count} lines`)
        lines.splice(idx, 0, ...op.body)
        break
      }
      case "insertHead":
        lines.unshift(...op.body)
        break
      case "insertTail":
        lines.push(...op.body)
        break
    }
  }

  return lines.join("\n")
}

function opSortIndex(op: HashlineOp, totalLines: number): number {
  switch (op.type) {
    case "replace": return op.startLine
    case "delete": return op.startLine
    case "insertBefore": return op.startLine
    case "insertAfter": return op.startLine + 1
    case "insertHead": return 0
    case "insertTail": return totalLines + 1
  }
}

// --- Hashline executor ---

const executeHashline = (
  input: string,
  ctx: Tool.Context,
  lsp: LSP.Interface,
  afs: AppFileSystem.Interface,
  format: Format.Interface,
  bus: Bus.Interface,
) =>
  Effect.gen(function* () {
    const instance = yield* InstanceState.context

    const { filePath, expectedHash, ops } = parseHashline(input)
    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(instance.directory, filePath)
    yield* assertExternalDirectoryEffect(ctx, resolvedPath)

    let contentOld = ""
    let contentNew = ""
    let diff = ""
    yield* lock(resolvedPath).withPermits(1)(
      Effect.gen(function* () {
        const info = yield* afs.stat(resolvedPath).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!info) throw new Error(`File ${resolvedPath} not found`)
        if (info.type === "Directory") throw new Error(`Path is a directory, not a file: ${resolvedPath}`)

        const source = yield* Bom.readFile(afs, resolvedPath)
        contentOld = source.text

        const currentHash = computeFileHash(contentOld)
        if (currentHash !== expectedHash) {
          throw new Error(
            `Hash mismatch: expected [${filePath}#${expectedHash}] but current is [${filePath}#${currentHash}]. Re-read the file to get the current hash.`,
          )
        }

        const ending = detectLineEnding(contentOld)
        contentNew = convertToLineEnding(applyHashlineOps(contentOld, ops), ending)

        const next = Bom.split(contentNew)
        const desiredBom = source.bom || next.bom
        contentNew = next.text

        diff = trimDiff(
          createTwoFilesPatch(
            resolvedPath,
            resolvedPath,
            normalizeLineEndings(contentOld),
            normalizeLineEndings(contentNew),
          ),
        )

        yield* ctx.ask({
          permission: "edit",
          patterns: [path.relative(instance.worktree, resolvedPath)],
          always: ["*"],
          metadata: { filepath: resolvedPath, diff },
        })

        yield* afs.writeWithDirs(resolvedPath, Bom.join(contentNew, desiredBom))
        if (yield* format.file(resolvedPath)) {
          contentNew = yield* Bom.syncFile(afs, resolvedPath, desiredBom)
        }
        yield* bus.publish(File.Event.Edited, { file: resolvedPath })
        yield* bus.publish(FileWatcher.Event.Updated, { file: resolvedPath, event: "change" })

        diff = trimDiff(
          createTwoFilesPatch(
            resolvedPath,
            resolvedPath,
            normalizeLineEndings(contentOld),
            normalizeLineEndings(contentNew),
          ),
        )
      }).pipe(Effect.orDie),
    )

    let additions = 0
    let deletions = 0
    for (const change of diffLines(contentOld, contentNew)) {
      if (change.added) additions += change.count || 0
      if (change.removed) deletions += change.count || 0
    }
    const filediff: Snapshot.FileDiff = { file: resolvedPath, patch: diff, additions, deletions }

    yield* ctx.metadata({
      metadata: { diff, filediff, diagnostics: {} },
    })

    let output = "Edit applied successfully."
    yield* lsp.touchFile(resolvedPath, "document")
    const diagnostics = yield* lsp.diagnostics()
    const normalizedFilePath = AppFileSystem.normalizePath(resolvedPath)
    const block = LSP.Diagnostic.report(resolvedPath, diagnostics[normalizedFilePath] ?? [])
    if (block) output += `\n\nLSP errors detected in this file, please fix:\n${block}`

    return {
      metadata: { diagnostics, diff, filediff },
      title: `${path.relative(instance.worktree, resolvedPath)}`,
      output,
    }
  })

export type Replacer = (content: string, find: string) => Generator<string, void, unknown>

// Similarity thresholds for block anchor fallback matching
const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.0
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.3

/**
 * Levenshtein distance algorithm implementation
 */
function levenshtein(a: string, b: string): number {
  // Handle empty strings
  if (a === "" || b === "") {
    return Math.max(a.length, b.length)
  }
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost)
    }
  }
  return matrix[a.length][b.length]
}

/**
 * Compute similarity ratio between two strings (0-1, higher = more similar).
 */
function similarityRatio(a: string, b: string): number {
  if (a === b) return 1
  if (a === "" || b === "") return 0
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  return 1 - levenshtein(a, b) / maxLen
}

/**
 * Character-level diff between two strings. Returns a compact representation
 * showing removed and added segments with surrounding context.
 */
function charDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split("\n")
  const newLines = newText.split("\n")
  const result: string[] = []
  const maxLines = Math.max(oldLines.length, newLines.length)

  for (let i = 0; i < maxLines; i++) {
    const oldLine = oldLines[i]
    const newLine = newLines[i]
    if (oldLine === newLine) {
      result.push(`  ${oldLine}`)
    } else {
      if (oldLine !== undefined) result.push(`- ${oldLine}`)
      if (newLine !== undefined) result.push(`+ ${newLine}`)
    }
  }
  return result.join("\n")
}

export interface FuzzyMatch {
  /** The matched text from the file */
  matchedText: string
  /** Similarity ratio 0-1 */
  similarity: number
  /** 1-based start line in file */
  startLine: number
  /** 1-based end line in file */
  endLine: number
  /** Character-level diff between search and match */
  diff: string
}

/**
 * Find the closest matching block in content using sliding window + Levenshtein.
 * Returns the best match above a minimum similarity threshold, or undefined.
 */
export function fuzzyFindBestMatch(content: string, search: string): FuzzyMatch | undefined {
  const contentLines = content.split("\n")
  const searchLines = search.split("\n")

  // Drop trailing empty line if present (common in paste)
  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop()
  }
  if (searchLines.length === 0) return undefined

  const searchBlock = searchLines.join("\n")
  const searchLen = searchLines.length

  let best: FuzzyMatch | undefined
  let bestScore = 0
  const MIN_SIMILARITY = 0.4

  // Sliding window: try every possible start position
  for (let i = 0; i <= contentLines.length - searchLen; i++) {
    const window = contentLines.slice(i, i + searchLen).join("\n")
    const score = similarityRatio(searchBlock, window)

    if (score > bestScore && score >= MIN_SIMILARITY) {
      bestScore = score
      best = {
        matchedText: window,
        similarity: score,
        startLine: i + 1,
        endLine: i + searchLen,
        diff: charDiff(searchBlock, window),
      }
    }
  }

  // Also try single-line fuzzy for short searches (1-3 lines)
  if (!best && searchLen <= 3) {
    for (let i = 0; i < contentLines.length; i++) {
      for (let j = 0; j < searchLines.length; j++) {
        const score = similarityRatio(searchLines[j], contentLines[i])
        if (score > bestScore && score >= MIN_SIMILARITY) {
          bestScore = score
          best = {
            matchedText: contentLines[i],
            similarity: score,
            startLine: i + 1,
            endLine: i + 1,
            diff: charDiff(searchLines[j], contentLines[i]),
          }
        }
      }
    }
  }

  return best
}

export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find
}

export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")

  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop()
  }

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true

    for (let j = 0; j < searchLines.length; j++) {
      const originalTrimmed = originalLines[i + j].trim()
      const searchTrimmed = searchLines[j].trim()

      if (originalTrimmed !== searchTrimmed) {
        matches = false
        break
      }
    }

    if (matches) {
      let matchStartIndex = 0
      for (let k = 0; k < i; k++) {
        matchStartIndex += originalLines[k].length + 1
      }

      let matchEndIndex = matchStartIndex
      for (let k = 0; k < searchLines.length; k++) {
        matchEndIndex += originalLines[i + k].length
        if (k < searchLines.length - 1) {
          matchEndIndex += 1 // Add newline character except for the last line
        }
      }

      yield content.substring(matchStartIndex, matchEndIndex)
    }
  }
}

export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")

  if (searchLines.length < 3) {
    return
  }

  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop()
  }

  const firstLineSearch = searchLines[0].trim()
  const lastLineSearch = searchLines[searchLines.length - 1].trim()
  const searchBlockSize = searchLines.length

  // Collect all candidate positions where both anchors match
  const candidates: Array<{ startLine: number; endLine: number }> = []
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) {
      continue
    }

    // Look for the matching last line after this first line
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        candidates.push({ startLine: i, endLine: j })
        break // Only match the first occurrence of the last line
      }
    }
  }

  // Return immediately if no candidates
  if (candidates.length === 0) {
    return
  }

  // Handle single candidate scenario (using relaxed threshold)
  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0]
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    let linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2) // Middle lines only

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          continue
        }
        const distance = levenshtein(originalLine, searchLine)
        similarity += (1 - distance / maxLen) / linesToCheck

        // Exit early when threshold is reached
        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
          break
        }
      }
    } else {
      // No middle lines to compare, just accept based on anchors
      similarity = 1.0
    }

    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      let matchStartIndex = 0
      for (let k = 0; k < startLine; k++) {
        matchStartIndex += originalLines[k].length + 1
      }
      let matchEndIndex = matchStartIndex
      for (let k = startLine; k <= endLine; k++) {
        matchEndIndex += originalLines[k].length
        if (k < endLine) {
          matchEndIndex += 1 // Add newline character except for the last line
        }
      }
      yield content.substring(matchStartIndex, matchEndIndex)
    }
    return
  }

  // Calculate similarity for multiple candidates
  let bestMatch: { startLine: number; endLine: number } | null = null
  let maxSimilarity = -1

  for (const candidate of candidates) {
    const { startLine, endLine } = candidate
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    let linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2) // Middle lines only

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          continue
        }
        const distance = levenshtein(originalLine, searchLine)
        similarity += 1 - distance / maxLen
      }
      similarity /= linesToCheck // Average similarity
    } else {
      // No middle lines to compare, just accept based on anchors
      similarity = 1.0
    }

    if (similarity > maxSimilarity) {
      maxSimilarity = similarity
      bestMatch = candidate
    }
  }

  // Threshold judgment
  if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
    const { startLine, endLine } = bestMatch
    let matchStartIndex = 0
    for (let k = 0; k < startLine; k++) {
      matchStartIndex += originalLines[k].length + 1
    }
    let matchEndIndex = matchStartIndex
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k].length
      if (k < endLine) {
        matchEndIndex += 1
      }
    }
    yield content.substring(matchStartIndex, matchEndIndex)
  }
}

export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ").trim()
  const normalizedFind = normalizeWhitespace(find)

  // Handle single line matches
  const lines = content.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line
    } else {
      // Only check for substring matches if the full line doesn't match
      const normalizedLine = normalizeWhitespace(line)
      if (normalizedLine.includes(normalizedFind)) {
        // Find the actual substring in the original line that matches
        const words = find.trim().split(/\s+/)
        if (words.length > 0) {
          const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")
          try {
            const regex = new RegExp(pattern)
            const match = line.match(regex)
            if (match) {
              yield match[0]
            }
          } catch {
            // Invalid regex pattern, skip
          }
        }
      }
    }
  }

  // Handle multi-line matches
  const findLines = find.split("\n")
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length)
      if (normalizeWhitespace(block.join("\n")) === normalizedFind) {
        yield block.join("\n")
      }
    }
  }
}

export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split("\n")
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0)
    if (nonEmptyLines.length === 0) return text

    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => {
        const match = line.match(/^(\s*)/)
        return match ? match[1].length : 0
      }),
    )

    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join("\n")
  }

  const normalizedFind = removeIndentation(find)
  const contentLines = content.split("\n")
  const findLines = find.split("\n")

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join("\n")
    if (removeIndentation(block) === normalizedFind) {
      yield block
    }
  }
}

export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescapeString = (str: string): string => {
    return str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, capturedChar) => {
      switch (capturedChar) {
        case "n":
          return "\n"
        case "t":
          return "\t"
        case "r":
          return "\r"
        case "'":
          return "'"
        case '"':
          return '"'
        case "`":
          return "`"
        case "\\":
          return "\\"
        case "\n":
          return "\n"
        case "$":
          return "$"
        default:
          return match
      }
    })
  }

  const unescapedFind = unescapeString(find)

  // Try direct match with unescaped find string
  if (content.includes(unescapedFind)) {
    yield unescapedFind
  }

  // Also try finding escaped versions in content that match unescaped find
  const lines = content.split("\n")
  const findLines = unescapedFind.split("\n")

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")
    const unescapedBlock = unescapeString(block)

    if (unescapedBlock === unescapedFind) {
      yield block
    }
  }
}

export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  // This replacer yields all exact matches, allowing the replace function
  // to handle multiple occurrences based on replaceAll parameter
  let startIndex = 0

  while (true) {
    const index = content.indexOf(find, startIndex)
    if (index === -1) break

    yield find
    startIndex = index + find.length
  }
}

export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim()

  if (trimmedFind === find) {
    // Already trimmed, no point in trying
    return
  }

  // Try to find the trimmed version
  if (content.includes(trimmedFind)) {
    yield trimmedFind
  }

  // Also try finding blocks where trimmed content matches
  const lines = content.split("\n")
  const findLines = find.split("\n")

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")

    if (block.trim() === trimmedFind) {
      yield block
    }
  }
}

export const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split("\n")
  if (findLines.length < 3) {
    // Need at least 3 lines to have meaningful context
    return
  }

  // Remove trailing empty line if present
  if (findLines[findLines.length - 1] === "") {
    findLines.pop()
  }

  const contentLines = content.split("\n")

  // Extract first and last lines as context anchors
  const firstLine = findLines[0].trim()
  const lastLine = findLines[findLines.length - 1].trim()

  // Find blocks that start and end with the context anchors
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue

    // Look for the matching last line
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() === lastLine) {
        // Found a potential context block
        const blockLines = contentLines.slice(i, j + 1)
        const block = blockLines.join("\n")

        // Check if the middle content has reasonable similarity
        // (simple heuristic: at least 50% of non-empty lines should match when trimmed)
        if (blockLines.length === findLines.length) {
          let matchingLines = 0
          let totalNonEmptyLines = 0

          for (let k = 1; k < blockLines.length - 1; k++) {
            const blockLine = blockLines[k].trim()
            const findLine = findLines[k].trim()

            if (blockLine.length > 0 || findLine.length > 0) {
              totalNonEmptyLines++
              if (blockLine === findLine) {
                matchingLines++
              }
            }
          }

          if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
            yield block
            break // Only match the first occurrence
          }
        }
        break
      }
    }
  }
}

export function trimDiff(diff: string): string {
  const lines = diff.split("\n")
  const contentLines = lines.filter(
    (line) =>
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++"),
  )

  if (contentLines.length === 0) return diff

  let min = Infinity
  for (const line of contentLines) {
    const content = line.slice(1)
    if (content.trim().length > 0) {
      const match = content.match(/^(\s*)/)
      if (match) min = Math.min(min, match[1].length)
    }
  }
  if (min === Infinity || min === 0) return diff
  const trimmedLines = lines.map((line) => {
    if (
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++")
    ) {
      const prefix = line[0]
      const content = line.slice(1)
      return prefix + content.slice(min)
    }
    return line
  })

  return trimmedLines.join("\n")
}

export function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (oldString === newString) {
    throw new Error("No changes to apply: oldString and newString are identical.")
  }

  let notFound = true

  for (const replacer of [
    SimpleReplacer,
    LineTrimmedReplacer,
    BlockAnchorReplacer,
    WhitespaceNormalizedReplacer,
    IndentationFlexibleReplacer,
    EscapeNormalizedReplacer,
    TrimmedBoundaryReplacer,
    ContextAwareReplacer,
    MultiOccurrenceReplacer,
  ]) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search)
      if (index === -1) continue
      notFound = false
      if (replaceAll) {
        return content.replaceAll(search, newString)
      }
      const lastIndex = content.lastIndexOf(search)
      if (index !== lastIndex) continue
      return content.substring(0, index) + newString + content.substring(index + search.length)
    }
  }

  if (notFound) {
    throw new Error(
      "Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.",
    )
  }
  throw new Error("Found multiple matches for oldString. Provide more surrounding context to make the match unique.")
}
