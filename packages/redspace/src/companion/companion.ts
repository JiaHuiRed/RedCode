// 261117 Red Chat companions keep a writable personal archive separate from pinned Souls and engineering memory.
// Decision: docs/notes/implemented/architecture/2026-11-17-redspace-companion-chat.md.
import { Global } from "@redcode-ai/core/global"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { Flock } from "@redcode-ai/core/util/flock"
import { Clock, Console, Context, Effect, Layer, Schema, Semaphore } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Soul } from "@/soul"
import { ID_PATTERN } from "@/soul/schema"
import { makeRuntime } from "@/effect/run-service"
import { activeFile, decode, digest, readArchive, safePath, type Archive } from "./archive"
import {
  Bootstrap,
  CompanionConflict,
  CompanionIO,
  CompanionInvalidInput,
  CompanionNotFound,
  Coverage,
  Info,
  ImportResult,
  Limits,
  ReadResult,
  RememberResult,
  SearchResult,
  type Error as CompanionError,
  type ImportInput,
  type ReadInput,
  type RememberInput,
  type SearchInput,
} from "./schema"

export * from "./schema"

export const directory = Context.Reference<string>("opencode/Companion.directory", {
  defaultValue: () => path.join(Global.Path.home, ".redcode", "companions"),
})

export interface Interface {
  readonly list: () => Effect.Effect<Info[], CompanionError>
  readonly get: (id: string) => Effect.Effect<Info | undefined, CompanionError>
  readonly importArchive: (input: ImportInput) => Effect.Effect<ImportResult, CompanionError>
  readonly bootstrap: (id: string) => Effect.Effect<Bootstrap, CompanionError>
  readonly sources: (id: string) => Effect.Effect<string[], CompanionError>
  readonly search: (input: SearchInput) => Effect.Effect<SearchResult, CompanionError>
  readonly read: (input: ReadInput) => Effect.Effect<ReadResult, CompanionError>
  readonly remember: (input: RememberInput) => Effect.Effect<RememberResult, CompanionError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Companion") {}

// A personal workspace is identified by its registered profile, not by the current tool's cwd.
export const workspaceProfile = Effect.fn("Companion.workspaceProfile")(function* (workspace: string) {
  const root = AppFileSystem.resolve(yield* directory)
  const relative = path.relative(root, AppFileSystem.resolve(workspace)).split(path.sep)
  if (relative.length !== 2 || relative[1] !== "workspace" || !ID_PATTERN.test(relative[0])) return undefined
  return yield* (yield* Service).get(relative[0])
})

const Manifest = Schema.Struct({
  profile: Info,
  digest: Schema.String,
  historyDigest: Schema.optional(Schema.String),
  // 0.19.1 审计 F-04：来源身份摘要。同一档案换了 id 再次导入时按它复用旧档案，
  // 而不是生成第二份 companion-<hash> 身份。旧档案没有这个字段，回退到 source.agentID。
  identity: Schema.optional(Schema.String),
  // 0.19.1 审计 F-05：本次导入的来源覆盖清单，供回溯与再次导入核对。旧档案没有此字段。
  coverage: Schema.optional(Coverage),
})
const Entry = Schema.Struct({ path: Schema.String, text: Schema.String, source: Schema.optional(Schema.String) })
const SearchCursor = Schema.Struct({ scope: Schema.String, offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const souls = yield* Soul.Service
    const writes = Semaphore.makeUnsafe(1)

    const get = Effect.fn("Companion.get")(function* (id: string) {
      const root = yield* directory
      return yield* io(async () => (await manifest(root, id))?.profile)
    })

    const requireProfile = Effect.fn("Companion.requireProfile")(function* (id: string) {
      const profile = yield* get(id)
      if (!profile) return yield* new CompanionNotFound({ message: `Companion "${id}" was not found.` })
      return profile
    })

    const list = Effect.fn("Companion.list")(function* () {
      const root = yield* directory
      return yield* io(async () => {
        const children = await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return []
          throw error
        })
        const profiles = await Promise.all(
          children
            .filter((child) => child.isDirectory() && ID_PATTERN.test(child.name))
            .map((child) => manifest(root, child.name)),
        )
        return profiles.flatMap((value) => (value ? [value.profile] : [])).sort((a, b) => a.createdAt - b.createdAt)
      })
    })

    const importArchive = Effect.fn("Companion.importArchive")(function* (input: ImportInput) {
      const root = yield* directory
      const archive = yield* io(() => readArchive(input.source))
      const prepared = yield* io(async () => {
        const source = archive.files.find((file) => file.path === "workspace/SOUL.md")!
        const content = decode(source.bytes, source.path)
        // Growing memories must not silently create another companion on the next import.
        const identity = digest(`${archive.agentID ?? "main"}:${archive.name ?? content}`)
        const id = validID(input.id ?? `companion-${identity.slice(0, 12)}`)
        const name = (input.name ?? archive.name ?? "Companion").trim()
        if (!name || /[\r\n]/.test(name) || Buffer.byteLength(name) > 256)
          throw new CompanionInvalidInput({
            message: "Companion name must be one non-empty line of at most 256 UTF-8 bytes.",
          })
        return { id, name, content, identity }
      })
      return yield* writes.withPermits(1)(
        Effect.gen(function* () {
          // 0.19.1 审计 F-04：未显式指定 id 时，先按来源身份复用已有档案——TUI 用自定义 id
          // 导入过的档案，GUI 再导入同一来源不会生成第二份 identity。显式 id 仍以调用方为准。
          const targetID = yield* io(async () => {
            if (input.id !== undefined) return prepared.id
            const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
            for (const entry of entries) {
              if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue
              const value = await manifest(root, entry.name)
              if (!value) continue
              const stored = value.identity ?? identityOf(value.raw, value.profile)
              if (stored === prepared.identity) return entry.name
            }
            return prepared.id
          })
          const previous = yield* io(() => manifest(root, targetID))
          if (previous) {
            if (
              previous.digest !== archive.digest ||
              (input.name !== undefined && previous.profile.name !== prepared.name)
            )
              return yield* new CompanionConflict({
                message: `Companion "${targetID}" already exists with a different archive. Existing memories were not changed.`,
              })
            return yield* io(() => appendHistory(root, targetID, archive))
          }
          const existing = yield* souls.get(targetID)
          if (existing && (existing.content.trim() !== prepared.content.trim() || existing.name !== prepared.name))
            return yield* new CompanionConflict({
              message: `Soul "${targetID}" already belongs to another identity. Choose a different companion id.`,
            })
          const createdAt = yield* Clock.currentTimeMillis
          const staging = yield* io(async () => {
            await fs.mkdir(root, { recursive: true, mode: 0o700 })
            return fs.mkdtemp(path.join(root, `.import-${targetID}-`))
          })
          const profile = new Info({
            id: targetID,
            name: prepared.name,
            soulID: targetID,
            directory: path.join(AppFileSystem.resolve(root), targetID, "workspace"),
            createdAt,
            files: archive.files.length,
            warnings: archive.warnings,
            timezone: archive.timezone,
          })
          return yield* Effect.gen(function* () {
            yield* io(async () => {
              for (const file of archive.files) {
                const original = path.join(staging, "source", file.path)
                await fs.mkdir(path.dirname(original), { recursive: true, mode: 0o700 })
                await fs.writeFile(original, file.bytes, { flag: "wx", mode: 0o600 })
                // Legacy AGENTS and installed skills are sources, never automatically activated in Chat.
                if (!activeFile(file.path)) continue
                const target = path.join(staging, file.path)
                await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
                await fs.writeFile(target, file.bytes, { flag: "wx", mode: 0o600 })
              }
              await fs.writeFile(
                path.join(staging, "profile.json"),
                JSON.stringify(
                  {
                    version: 1,
                    profile,
                    digest: archive.digest,
                    historyDigest: archive.historyDigest,
                    identity: prepared.identity,
                    source: { format: "openclaw", path: input.source, agentID: archive.agentID },
                    preferences: archive.preferences,
                    coverage: archive.coverage,
                    files: archive.files.map((file) => ({
                      path: file.path,
                      bytes: file.bytes.byteLength,
                      hash: file.hash,
                      encoding: file.encoding,
                    })),
                  },
                  null,
                  2,
                ),
                { flag: "wx", mode: 0o600 },
              )
            })
            if (!existing)
              yield* souls
                .create({ id: targetID, name: prepared.name, content: prepared.content })
                .pipe(
                  Effect.mapError((error) =>
                    error._tag === "SoulConflict"
                      ? new CompanionConflict({ message: error.message })
                      : error._tag === "SoulInvalidInput"
                        ? new CompanionInvalidInput({ message: error.message })
                        : new CompanionIO({ message: error.message }),
                  ),
                )
            yield* io(() => AppFileSystem.renameWithRetry(staging, path.join(root, targetID)))
            return new ImportResult({ profile, imported: true, coverage: archive.coverage })
          }).pipe(
            Effect.ensuring(
              io(() => fs.rm(staging, { recursive: true, force: true })).pipe(
                Effect.catch((error) =>
                  Console.warn(`Companion import temporary directory cleanup failed: ${error.message}`),
                ),
              ),
            ),
          )
        }),
      )
    })

    const bootstrap = Effect.fn("Companion.bootstrap")(function* (id: string) {
      const profile = yield* requireProfile(id)
      return yield* io(async () => {
        const notes = await memoryFiles(profile.directory)
        const recent = notes
          .filter((file) => file.startsWith("memory/"))
          .sort()
          .reverse()
          .slice(0, 2)
        const sources: string[] = []
        const warnings: string[] = []
        const sections: string[] = []
        for (const file of ["MEMORY.md", "USER.md", "IDENTITY.md", ...recent]) {
          const text = await optionalText(profile.directory, file, warnings)
          if (text === undefined) continue
          const cap =
            file === "MEMORY.md" ? Limits.longTerm : file.startsWith("memory/") ? Limits.recent : Limits.identity
          sources.push(file)
          const excerpt = file.startsWith("memory/")
            ? tail(text, cap)
            : bounded(text, cap, "\n[Excerpt truncated; use companion memory read for the source.]")
          sections.push(`### ${file}\n${excerpt}`)
        }
        return new Bootstrap({
          text: bounded(sections.join("\n\n"), Limits.bootstrap, "\n[Personal context truncated.]"),
          sources,
          warnings,
        })
      })
    })

    const sources = Effect.fn("Companion.sources")(function* (id: string) {
      const profile = yield* requireProfile(id)
      return yield* io(() => memoryFiles(profile.directory))
    })

    const search = Effect.fn("Companion.search")(function* (input: SearchInput) {
      const profile = yield* requireProfile(input.id)
      return yield* io(async () => {
        const query = input.query.trim().toLowerCase()
        if (!query || Buffer.byteLength(query) > 512)
          throw new CompanionInvalidInput({ message: "Memory query must be non-empty and at most 512 UTF-8 bytes." })
        const limit = integer(input.limit ?? 5, 1, 10, "limit")
        const available = await memoryFiles(profile.directory)
        const files = input.paths === undefined ? available : [...new Set(input.paths.map(safePath))]
        if (input.paths !== undefined) {
          const allowed = new Set(available)
          if (files.some((file) => !allowed.has(file)))
            throw new CompanionInvalidInput({
              message: "Search paths must be existing recall sources from this companion.",
            })
        }
        files.sort().reverse()
        const scope = digest(JSON.stringify({ id: profile.id, query, files }))
        if (input.cursor && Buffer.byteLength(input.cursor) > 1024)
          throw new CompanionInvalidInput({ message: "Memory search cursor exceeds 1024 bytes." })
        const cursor = input.cursor
          ? Schema.decodeUnknownSync(SearchCursor)(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")))
          : undefined
        if (cursor && (cursor.scope !== scope || cursor.offset > files.length))
          throw new CompanionInvalidInput({
            message: "Memory search sources or filters changed; restart the search without a cursor.",
          })
        const warnings: string[] = []
        const matches: Array<{
          path: string
          startLine: number
          endLine: number
          text: string
          byteOffset?: number
          score: number
        }> = []
        const terms = [...new Set(query.match(/[a-z0-9][a-z0-9_-]+|[\p{Script=Han}]+/gu) ?? [query])]
        const fragments = [
          ...new Set(
            terms.flatMap((term) =>
              /^[\p{Script=Han}]{3,}$/u.test(term)
                ? Array.from({ length: term.length - 1 }, (_, index) => term.slice(index, index + 2))
                : [],
            ),
          ),
        ]
        let scanned = 0
        let nextCursor: string | undefined
        for (let index = cursor?.offset ?? 0; index < files.length; index++) {
          const file = files[index]
          const text = await optionalText(profile.directory, file, warnings)
          if (text === undefined) continue
          if (scanned + Buffer.byteLength(text) > Limits.scan) {
            nextCursor = Buffer.from(JSON.stringify({ scope, offset: index })).toString("base64url")
            warnings.push(
              "Memory search reached its 8 MiB page limit; continue with nextCursor and the same query, even if this page has no matches.",
            )
            break
          }
          scanned += Buffer.byteLength(text)
          const lines = text.split(/\r?\n/)
          const ranked: Array<{ index: number; score: number }> = []
          for (let index = 0; index < lines.length; index++) {
            const value = lines[index].toLowerCase()
            let score = value.includes(query) ? 12 : 0
            for (const term of terms) if (value.includes(term)) score += 4
            for (const term of fragments) if (value.includes(term)) score++
            if (score === 0) continue
            // Only two excerpts are used per file. Strict comparison preserves earlier lines on ties.
            const position = ranked.findIndex((item) => score > item.score)
            if (position === -1 && ranked.length === 2) continue
            ranked.splice(position === -1 ? ranked.length : position, 0, { index, score })
            if (ranked.length > 2) ranked.pop()
          }
          for (const item of ranked) {
            const start = Math.max(0, item.index - 1)
            const end = Math.min(lines.length, item.index + 3)
            const excerpt = lines.slice(start, end).join("\n")
            if (Buffer.byteLength(excerpt) > 1400) {
              // A long preceding line must not consume the whole excerpt and hide the hit.
              // Anchor inside the matching line and return a byte cursor for exact UTF-8 readback.
              const line = lines[item.index]
              const lower = line.toLowerCase()
              const term = [query, ...terms, ...fragments].find((term) => lower.includes(term))!
              let position = Math.max(0, lower.indexOf(term) - 60)
              if (position && /[\uDC00-\uDFFF]/.test(line[position])) position--
              let lineStart = 0
              for (let index = 0; index < item.index; index++) lineStart = text.indexOf("\n", lineStart) + 1
              matches.push({
                path: file,
                startLine: item.index + 1,
                endLine: item.index + 1,
                byteOffset: Buffer.byteLength(text.slice(0, lineStart + position)),
                text: bounded(line.slice(position), 1400, "\n[Excerpt truncated.]"),
                score: item.score,
              })
              continue
            }
            matches.push({
              path: file,
              startLine: start + 1,
              endLine: end,
              text: excerpt,
              score: item.score,
            })
          }
        }
        const visibleWarnings = warnings.slice(0, 8).map((warning) => bounded(warning, 384, "…"))
        if (warnings.length > visibleWarnings.length)
          visibleWarnings.push(`${warnings.length - visibleWarnings.length} additional sources could not be searched.`)
        let remaining =
          Limits.search -
          Buffer.byteLength(JSON.stringify({ results: [], warnings: visibleWarnings, nextCursor })) -
          limit
        const results = matches
          .sort((a, b) => b.score - a.score || b.path.localeCompare(a.path))
          .slice(0, limit)
          .flatMap(({ score: _score, ...result }) => {
            const size = Buffer.byteLength(JSON.stringify(result))
            if (size > remaining) return []
            remaining -= size
            return [result]
          })
        return new SearchResult({ results, warnings: visibleWarnings, ...(nextCursor ? { nextCursor } : {}) })
      })
    })

    const read = Effect.fn("Companion.read")(function* (input: ReadInput) {
      const profile = yield* requireProfile(input.id)
      return yield* io(async () => {
        const file = safePath(input.path)
        if (!readableFile(file))
          throw new CompanionInvalidInput({
            message: "Read a personal Markdown memory path relative to the companion workspace.",
          })
        if (input.byteOffset !== undefined && input.offset !== undefined)
          throw new CompanionInvalidInput({
            message: "Use either a one-based line offset or a returned byteOffset cursor.",
          })
        const offset = integer(input.offset ?? 1, 1, Number.MAX_SAFE_INTEGER, "offset")
        const limit = integer(input.limit ?? 100, 1, 200, "limit")
        const data = await personalBytes(profile.directory, file)
        decode(data, file)
        const lines = [0]
        for (let index = data.indexOf(10); index !== -1; index = data.indexOf(10, index + 1)) lines.push(index + 1)
        const start =
          input.byteOffset === undefined
            ? (lines[Math.min(offset - 1, lines.length)] ?? data.byteLength)
            : integer(input.byteOffset, 0, data.byteLength, "byteOffset")
        if (start < data.byteLength && (data[start] & 0xc0) === 0x80)
          throw new CompanionInvalidInput({
            message: "byteOffset must be a UTF-8 character boundary; use nextByteOffset from the previous read.",
          })
        const line = lines.findLastIndex((position) => position <= start)
        let end = Math.min(lines[line + limit] ?? data.byteLength, start + Limits.read)
        while (end > start && end < data.byteLength && (data[end] & 0xc0) === 0x80) end--
        // Keep original line endings and an exact byte cursor, including when one line exceeds the page budget.
        const output = data.subarray(start, end).toString("utf8")
        return new ReadResult({
          path: file,
          text: output,
          startLine: line + 1,
          endLine: end > start ? lines.findLastIndex((position) => position <= end - 1) + 1 : line,
          totalLines: lines.length,
          truncated: end < data.byteLength,
          byteOffset: start,
          ...(end < data.byteLength ? { nextByteOffset: end } : {}),
        })
      })
    })

    const remember = Effect.fn("Companion.remember")(function* (input: RememberInput) {
      const profile = yield* requireProfile(input.id)
      const now = input.time ?? (yield* Clock.currentTimeMillis)
      return yield* writes.withPermits(1)(
        io(async () => {
          // TUI and GUI can write the same profile from separate processes. The shared lock also protects retry deduplication.
          await using lease = await Flock.acquire("memory", {
            dir: path.join(profile.directory, "..", ".locks"),
            timeoutMs: 10_000,
          })
          const text = input.text.trim()
          if (!text || Buffer.byteLength(text) > Limits.remember)
            throw new CompanionInvalidInput({ message: "Memory entry must be non-empty and at most 8192 UTF-8 bytes." })
          if (input.source !== undefined && (/[\r\n]/.test(input.source) || Buffer.byteLength(input.source) > 256))
            throw new CompanionInvalidInput({ message: "Memory source must be one line of at most 256 UTF-8 bytes." })
          if (
            input.idempotencyKey !== undefined &&
            (!input.idempotencyKey || Buffer.byteLength(input.idempotencyKey) > 256)
          )
            throw new CompanionInvalidInput({
              message: "Memory idempotency key must be non-empty and at most 256 UTF-8 bytes.",
            })
          const key = digest(input.idempotencyKey ?? randomUUID())
          const entryPath = path.join(profile.directory, "..", "entries", `${key}.json`)
          const entry = {
            path: diaryPath(profile.timezone, now),
            text,
            ...(input.source === undefined ? {} : { source: input.source }),
          }
          await fs.mkdir(path.dirname(entryPath), { recursive: true, mode: 0o700 })
          const existing = await readJSON(entryPath)
          const saved = existing === undefined ? entry : Schema.decodeUnknownSync(Entry)(existing)
          if (saved.text !== text || saved.source !== input.source)
            throw new CompanionConflict({ message: "This memory idempotency key already refers to a different entry." })
          if (existing === undefined) {
            const pending = `${entryPath}.${randomUUID()}.tmp`
            await fs.writeFile(pending, JSON.stringify(entry), { flag: "wx", mode: 0o600 })
            await AppFileSystem.renameWithRetry(pending, entryPath)
          }
          if (!/^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(saved.path))
            throw new CompanionInvalidInput({ message: "Stored memory entry has an invalid diary path." })
          await fs.mkdir(path.join(profile.directory, "memory"), { recursive: true, mode: 0o700 })
          const parent = await containedPath(profile.directory, path.join(profile.directory, "memory"))
          const target = path.join(parent, path.basename(saved.path))
          const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined
            throw error
          })
          if (stat && (!stat.isFile() || stat.size > Limits.diary))
            throw new CompanionInvalidInput({
              message: "The diary must be a regular file of at most 4 MiB; symbolic links are not writable.",
            })
          if (stat) await containedPath(profile.directory, target)
          const marker = `<!-- companion-entry:${key} -->`
          const current = await fs.readFile(target).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return new Uint8Array()
            throw error
          })
          const decoded = decode(current, saved.path)
          if (!decoded.includes(marker)) {
            const addition = `\n\n${saved.source ? `Source: ${saved.source}\n\n` : ""}${saved.text}\n${marker}\n`
            if (current.byteLength + Buffer.byteLength(addition) > Limits.diary)
              throw new CompanionInvalidInput({
                message: "Today's diary exceeds 4 MiB. The entry is preserved; consolidate the diary before retrying.",
              })
            await fs.appendFile(target, addition, { mode: 0o600 })
          }
          return new RememberResult({ path: saved.path, created: existing === undefined })
        }),
      )
    })

    return Service.of({ list, get, importArchive, bootstrap, sources, search, read, remember })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Soul.defaultLayer))
export const { runPromise } = makeRuntime(Service, defaultLayer)

function asError(error: unknown): CompanionError {
  if (
    error instanceof CompanionInvalidInput ||
    error instanceof CompanionConflict ||
    error instanceof CompanionNotFound ||
    error instanceof CompanionIO
  )
    return error
  return new CompanionIO({ message: error instanceof Error ? error.message : "Companion archive operation failed." })
}

function io<A>(operation: () => Promise<A>) {
  return Effect.tryPromise({ try: operation, catch: asError })
}

function validID(id: string) {
  if (!ID_PATTERN.test(id) || id.length > 64)
    throw new CompanionInvalidInput({
      message: "Companion id must contain 1–64 lowercase letters, digits, hyphens or underscores.",
    })
  return id
}

async function readJSON(file: string): Promise<unknown | undefined> {
  const bytes = await fs.readFile(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  return bytes === undefined ? undefined : JSON.parse(decode(bytes, path.basename(file)))
}

async function manifest(root: string, id: string) {
  validID(id)
  const stored = await readJSON(path.join(root, id, "profile.json"))
  if (stored === undefined) return undefined
  const result = Schema.decodeUnknownSync(Manifest)(stored)
  if (result.profile.id !== id || result.profile.soulID !== id)
    throw new CompanionIO({ message: `Companion "${id}" has an inconsistent profile identity.` })
  // Resolve the private workspace from the current home so moving the profile directory remains possible.
  return {
    ...result,
    raw: stored as Record<string, unknown>,
    profile: new Info({ ...result.profile, directory: AppFileSystem.resolve(path.join(root, id, "workspace")) }),
  }
}

// 0.19.1 审计 F-04：旧档案没有 identity 字段时，从 profile.json 的来源信息重建同一摘要。
// 只认 agentID（来源身份的一部分），缺失就返回 undefined —— 宁可不复用，也不误合并两个身份。
function identityOf(raw: Record<string, unknown>, profile: Info) {
  const source = raw.source as { agentID?: unknown } | undefined
  const agentID = typeof source?.agentID === "string" ? source.agentID : undefined
  if (!agentID) return undefined
  return digest(`${agentID}:${profile.name}`)
}

// Re-import adds derived transcripts, never replaces a living diary or pinned identity.
// docs/notes/implemented/feature/2026-11-17-companion-transcript-import.md
async function appendHistory(root: string, id: string, archive: Archive) {
  const target = path.join(root, id)
  await using lease = await Flock.acquire("history-import", { dir: path.join(target, ".locks"), timeoutMs: 10_000 })
  const previous = (await manifest(root, id))!
  if (previous.digest !== archive.digest)
    throw new CompanionConflict({
      message: "The personal archive changed during history import. Existing memories were not replaced.",
    })
  const histories = archive.files.filter((file) => file.path.startsWith("workspace/history/openclaw-"))
  if (previous.historyDigest === archive.historyDigest || !histories.length)
    return new ImportResult({ profile: previous.profile, imported: false, coverage: archive.coverage })
  const files = Schema.decodeUnknownSync(Schema.Array(Schema.Record(Schema.String, Schema.Unknown)))(
    previous.raw.files ?? [],
  )
  const known = new Set(files.map((file) => file.path))
  for (const file of histories) {
    for (const destination of [path.join(target, "source", file.path), path.join(target, file.path)]) {
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
      await containedPath(target, path.dirname(destination))
      const saved = await fs.readFile(destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (saved !== undefined && digest(saved) !== file.hash)
        throw new CompanionConflict({
          message: `Existing imported conversation differs: ${file.path}. It was not overwritten.`,
        })
      if (saved === undefined) await fs.writeFile(destination, file.bytes, { flag: "wx", mode: 0o600 })
    }
  }
  const added = histories.filter((file) => !known.has(file.path))
  const profile = new Info({
    ...previous.profile,
    files: previous.profile.files + added.length,
    warnings: archive.warnings,
  })
  const pending = path.join(target, `profile.${randomUUID()}.tmp`)
  await fs.writeFile(
    pending,
    JSON.stringify(
      {
        ...previous.raw,
        profile,
        historyDigest: archive.historyDigest,
        coverage: archive.coverage,
        files: [
          ...files,
          ...added.map((file) => ({
            path: file.path,
            bytes: file.bytes.byteLength,
            hash: file.hash,
            encoding: file.encoding,
          })),
        ],
      },
      null,
      2,
    ),
    { flag: "wx", mode: 0o600 },
  )
  await AppFileSystem.renameWithRetry(pending, path.join(target, "profile.json"))
  return new ImportResult({ profile, imported: true, coverage: archive.coverage })
}

function integer(value: number, min: number, max: number, label: string) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new CompanionInvalidInput({ message: `${label} must be an integer between ${min} and ${max}.` })
  return value
}

export function diaryPath(timezone: string, timestamp: number) {
  integer(timestamp, -8_640_000_000_000_000, 8_640_000_000_000_000, "time")
  try {
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(timestamp)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new CompanionInvalidInput({ message: "Memory time must produce a four-digit calendar year." })
    return `memory/${date}.md`
  } catch (error) {
    if (error instanceof CompanionInvalidInput) throw error
    throw new CompanionInvalidInput({ message: "Memory timezone or time is invalid." })
  }
}

export function bounded(value: string, bytes: number, marker = "") {
  if (Buffer.byteLength(value) <= bytes) return value
  const data = Buffer.from(value)
  let end = Math.max(0, bytes - Buffer.byteLength(marker))
  while (end > 0 && (data[end] & 0xc0) === 0x80) end--
  return `${data.subarray(0, end).toString("utf8")}${marker}`
}

function tail(value: string, bytes: number) {
  if (Buffer.byteLength(value) <= bytes) return value
  const marker = "[Earlier diary entries omitted; read the source for full history.]\n"
  const data = Buffer.from(value)
  let start = data.length - bytes + Buffer.byteLength(marker)
  while (start < data.length && (data[start] & 0xc0) === 0x80) start++
  return `${marker}${data.subarray(start).toString("utf8")}`
}

function recallFile(file: string) {
  return (
    /^(MEMORY|USER|IDENTITY)\.md$/.test(file) ||
    /^memory\/\d{4}-\d{2}-\d{2}[^/]*\.md$/.test(file) ||
    /^history\/openclaw-[a-f0-9]+\.md$/.test(file) ||
    /^\.learnings\/[^/]+\.md$/.test(file)
  )
}

function readableFile(file: string) {
  return recallFile(file) || /^(SOUL|USER|IDENTITY|TOOLS|HEARTBEAT|DREAMS)\.md$/.test(file)
}

async function memoryFiles(root: string) {
  const entries = await fs.readdir(root, { withFileTypes: true })
  const result = entries.filter((entry) => entry.isFile() && recallFile(entry.name)).map((entry) => entry.name)
  for (const dir of entries.filter(
    (entry) => entry.isDirectory() && ["memory", ".learnings", "history"].includes(entry.name),
  )) {
    const children = await fs.readdir(path.join(root, dir.name), { withFileTypes: true })
    result.push(
      ...children
        .filter((child) => child.isFile())
        .map((child) => `${dir.name}/${child.name}`)
        .filter(recallFile),
    )
  }
  return result.sort()
}

async function containedPath(root: string, target: string) {
  const resolved = await fs.realpath(target)
  const relative = path.relative(await fs.realpath(root), resolved)
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))
    throw new CompanionInvalidInput({ message: "Memory source resolves outside its companion workspace." })
  return resolved
}

async function personalBytes(root: string, file: string) {
  const resolved = await containedPath(root, path.join(root, file)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new CompanionNotFound({ message: `Memory source not found: ${file}` })
    throw error
  })
  const stat = await fs.stat(resolved)
  if (!stat.isFile() || stat.size > Limits.textFile)
    throw new CompanionInvalidInput({ message: `Memory source exceeds the 4 MiB text limit: ${file}` })
  return fs.readFile(resolved)
}

async function personalText(root: string, file: string) {
  return decode(await personalBytes(root, file), file)
}

async function optionalText(root: string, file: string, warnings: string[]) {
  try {
    return await personalText(root, file)
  } catch (error) {
    if (error instanceof CompanionNotFound) return undefined
    if (error instanceof CompanionInvalidInput) {
      warnings.push(error.message)
      return undefined
    }
    throw error
  }
}

export * as Companion from "./companion"
