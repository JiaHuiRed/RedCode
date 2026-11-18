import { Reader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js"
import { createHash } from "node:crypto"
import fs, { type FileHandle } from "node:fs/promises"
import path from "node:path"
import { Coverage, CompanionInvalidInput, Limits } from "./schema"
import { internalTranscripts, transcript, transcriptPath } from "./transcript"

type Entry = { path: string; size: number; read: () => Promise<Uint8Array> }

// 0.19.1 audit F-05: classify every session-source path without reading file contents.
// Only `jsonl` sources are eligible for import; the rest are counted for the coverage census.
type SourceKind = "jsonl" | "trajectory" | "deleted" | "other"
type SourceCensus = Record<SourceKind, number>

function classifySource(file: string): SourceKind | undefined {
  if (!/^agents\/[^/]+\/sessions\//.test(file)) return undefined
  if (transcriptPath(file)) return "jsonl"
  if (/\.trajectory\.jsonl$|\.trajectory-path\.json$/.test(file)) return "trajectory"
  if (/\.deleted(?:\.|$)/.test(file)) return "deleted"
  if (/\.jsonl$|\.jsonl\./.test(file)) return "other"
  return undefined
}

const emptyCensus = (): SourceCensus => ({ jsonl: 0, trajectory: 0, deleted: 0, other: 0 })

class ArchiveReader extends Reader<FileHandle> {
  constructor(
    private readonly file: FileHandle,
    size: number,
  ) {
    super(file)
    this.size = size
  }

  override async readUint8Array(index: number, length: number) {
    if (index < 0 || length < 0 || index + length > this.size || length > 16 * 1024 * 1024)
      throw new CompanionInvalidInput({ message: "ZIP metadata requests an invalid or oversized data range." })
    // Read only ZIP ranges being inspected. Loading a full OpenClaw ZIP twice can otherwise exhaust the app heap.
    // A plain Uint8Array also keeps zip.js slice semantics independent from Node Buffer.slice views.
    const bytes = new Uint8Array(length)
    let offset = 0
    while (offset < length) {
      const read = await this.file.read(bytes, offset, length - offset, index + offset)
      if (read.bytesRead === 0) throw new CompanionInvalidInput({ message: "ZIP source changed while importing." })
      offset += read.bytesRead
    }
    return bytes
  }
}
export type SourceFile = {
  path: string
  // Active-workspace bytes: the faithful UTF-8 transcode for mixed-encoding sources, otherwise the original.
  bytes: Uint8Array
  // Original source bytes; set only when `bytes` is a transcode. The source/ copy and the manifest
  // hash keep these so a repeat import still matches the archive digest.
  original?: Uint8Array
  hash: string
  text: boolean
  encoding: "utf8" | "binary" | "unknown" | "transcoded"
}
export type Archive = {
  files: SourceFile[]
  digest: string
  historyDigest: string
  name?: string
  agentID?: string
  timezone: string
  preferences: { voice?: string; autoVoice?: string }
  warnings: string[]
  coverage: InstanceType<typeof Coverage>
  sourceCensus: SourceCensus
}

export function digest(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

export function decode(bytes: Uint8Array, file: string) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    // The source bytes stay intact; replacement decoding would silently rewrite old memories.
    throw new CompanionInvalidInput({ message: `${file} is not valid UTF-8; its original bytes were preserved.` })
  }
}

// 261118 Red Legacy OpenClaw diaries written on Windows mix a UTF-8 head with a GBK body (or the
// reverse, from editor round-trips). A faithful byte-level transcode makes them searchable without
// rewriting the preserved source bytes: primary runs pass through, the other encoding fills the
// gaps, and the decoded text must stay overwhelmingly CJK/ASCII or the file stays excluded. The
// manifest hash keeps the original bytes, so a re-import of the same source still matches its digest.
// Decision: docs/notes/implemented/feature/2026-11-19-companion-transcode-avatar.md
const GB18030 = new TextDecoder("gb18030", { fatal: true })

// Length of the well-formed UTF-8 sequence at `index` (overlong forms, surrogates and 0xF5+ rejected), or 0.
function utf8LengthAt(bytes: Uint8Array, index: number): number {
  const lead = bytes[index]
  if (lead < 0x80) return 1
  if (lead < 0xc2 || lead > 0xf4) return 0
  const continuation = (offset: number, low: number, high: number) =>
    index + offset < bytes.length && bytes[index + offset] >= low && bytes[index + offset] <= high
  if (lead < 0xe0) return continuation(1, 0x80, 0xbf) ? 2 : 0
  if (lead < 0xf0) {
    const low = lead === 0xe0 ? 0xa0 : lead === 0xed ? 0x80 : 0x80
    const high = lead === 0xed ? 0x9f : 0xbf
    return continuation(1, low, high) && continuation(2, 0x80, 0xbf) ? 3 : 0
  }
  const low = lead === 0xf0 ? 0x90 : lead === 0xf4 ? 0x80 : 0x80
  const high = lead === 0xf4 ? 0x8f : 0xbf
  return continuation(1, low, high) && continuation(2, 0x80, 0xbf) && continuation(3, 0x80, 0xbf) ? 4 : 0
}

// GB18030 sequence length at `index`: ASCII and the euro sign are single bytes, 0x81–0xFE starts a
// two- or four-byte run, 0x7F and 0xFF never occur.
function gbLengthAt(bytes: Uint8Array, index: number): number {
  const lead = bytes[index]
  if (lead < 0x81) return 1
  if (lead === 0xff || index + 1 >= bytes.length) return 0
  const second = bytes[index + 1]
  if (second >= 0x30 && second <= 0x39)
    return index + 3 < bytes.length &&
      bytes[index + 2] >= 0x81 &&
      bytes[index + 2] <= 0xfe &&
      bytes[index + 3] >= 0x30 &&
      bytes[index + 3] <= 0x39
      ? 4
      : 0
  return (second >= 0x40 && second <= 0x7e) || (second >= 0x80 && second <= 0xfe) ? 2 : 0
}

function classify(code: number) {
  return (
    (code >= 0x20 && code <= 0x7e) ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x2000 && code <= 0x206f) ||
    (code >= 0x2600 && code <= 0x27bf) ||
    (code >= 0x1f000 && code <= 0x1faff)
  )
}

function decodeUtf8(slice: Uint8Array) {
  return new TextDecoder("utf-8", { fatal: true }).decode(slice)
}

function decodeSlice(bytes: Uint8Array, index: number, length: number, encoding: "utf8" | "gb18030") {
  try {
    return (encoding === "utf8" ? decodeUtf8(bytes.subarray(index, index + length)) : GB18030.decode(bytes.subarray(index, index + length))) as string
  } catch {
    return undefined
  }
}

// Scan byte by byte, consuming one encoding sequence at a time. Where both encodings claim the
// bytes (GBK two-byte pairs frequently shape legal UTF-8), decode both and keep the reading that
// yields plausible CJK/ASCII text; when neither is stronger, `tieBreak` decides. This resolves the
// classic UTF-8-head/GBK-body diaries without a global guess, and the remaining weak-character
// share is capped by the caller's strength gate.
function scanMixed(
  bytes: Uint8Array,
  tieBreak: "utf8" | "gb18030",
): { text: string; strong: number; total: number } | undefined {
  const parts: string[] = []
  let strong = 0
  let total = 0
  let index = 0
  while (index < bytes.length) {
    const utf8Length = utf8LengthAt(bytes, index)
    const gbLength = gbLengthAt(bytes, index)
    let encoding: "utf8" | "gb18030" | "broken"
    if (utf8Length === 0 && gbLength === 0) encoding = "broken"
    else if (utf8Length === 0) encoding = "gb18030"
    else if (gbLength === 0 || utf8Length === 1) encoding = "utf8"
    else {
      const utf8Text = decodeSlice(bytes, index, utf8Length, "utf8")
      const gbText = decodeSlice(bytes, index, gbLength, "gb18030")
      if (gbText === undefined && utf8Text === undefined) encoding = "broken"
      else if (gbText === undefined) encoding = "utf8"
      else if (utf8Text === undefined) encoding = "gb18030"
      else {
        const utf8Strong = [...utf8Text].every((char) => classify(char.codePointAt(0)!))
        const gbStrong = [...gbText].every((char) => classify(char.codePointAt(0)!))
        encoding = utf8Strong === gbStrong ? tieBreak : utf8Strong ? "utf8" : "gb18030"
      }
    }
    // Interrupted legacy writes leave a few truncated sequences (a GB lead before a newline).
    // Mark them with U+FFFD — the standard "damaged byte" reading — instead of rejecting the
    // whole diary; the strength gate below still rejects files that are mostly damaged.
    if (encoding === "broken") {
      parts.push("\uFFFD")
      total++
      index++
      continue
    }
    const length = encoding === "utf8" ? utf8Length : gbLength
    const text = decodeSlice(bytes, index, length, encoding)
    if (text === undefined) {
      parts.push("\uFFFD")
      total++
      index += Math.max(length, 1)
      continue
    }
    for (const char of text) {
      total++
      if (classify(char.codePointAt(0)!)) strong++
    }
    parts.push(text)
    index += length
  }
  if (total === 0) return undefined
  return { text: parts.join(""), strong, total }
}

export function transcodeMixed(bytes: Uint8Array): Uint8Array | undefined {
  const candidates = [scanMixed(bytes, "utf8"), scanMixed(bytes, "gb18030")].filter(
    (value): value is { text: string; strong: number; total: number } => value !== undefined,
  )
  // 95% strong characters: real diaries decode almost entirely into plausible text, while a wrong
  // encoding choice floods the output with Latin/Greek mojibake. Prefer the UTF-8 head on ties.
  const best = candidates
    .filter((value) => value.strong / value.total >= 0.95)
    .sort((a, b) => b.strong / b.total - a.strong / a.total)[0]
  if (!best) return undefined
  return new TextEncoder().encode(best.text)
}

export function safePath(value: string) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "")
  if (
    normalized.startsWith("/") ||
    /^[a-z]:/i.test(normalized) ||
    /[\u0000-\u001f]/.test(normalized) ||
    normalized
      .split("/")
      .some(
        (part) =>
          part === ".." ||
          part.includes(":") ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new CompanionInvalidInput({ message: "Archive contains an unsafe file path." })
  return normalized.replace(/\/$/, "")
}

export function activeFile(file: string) {
  if (!file.startsWith("workspace/")) return false
  const relative = file.slice("workspace/".length)
  return (
    /^(SOUL|MEMORY|USER|IDENTITY|TOOLS|HEARTBEAT|DREAMS)\.md$/i.test(relative) ||
    /^memory\/\d{4}-\d{2}-\d{2}[^/]*\.md$/.test(relative) ||
    /^\.learnings\/[^/]+\.md$/.test(relative) ||
    /^history\/openclaw-[a-f0-9]+\.md$/.test(relative) ||
    /^(?:avatars\/)?[^/]*avatar[^/]*\.(png|jpe?g|webp)$/i.test(relative)
  )
}

function personalFile(file: string) {
  if (file.split("/").some((part) => part === ".git" || part === "node_modules")) return false
  return (
    (file.startsWith("workspace/") && /\.(md|png|jpe?g|webp)$/i.test(file)) ||
    /^workspace\/memory\/\.dreams\/session-corpus\/[^/]+\.txt$/.test(file) ||
    /^workspace\/memories\/[^/]+\.json$/.test(file) ||
    /^oldmemory\/IDENTITY\.md[^/]*$/.test(file) ||
    /^workspace-backup-[^/]+\/[^/]+\.md$/.test(file) ||
    /^profiles\/[^/]+\/canvas\/documents\/[^/]+\.(html|png|jpe?g|webp)$/i.test(file) ||
    /^media\/(inbound|tool-image-generation)\/[^/]+\.(png|jpe?g|webp)$/i.test(file)
  )
}

function property(value: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>(
    (current, key) =>
      current !== null && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined,
    value,
  )
}

function string(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

async function metadata(entries: Entry[], warnings: string[]) {
  const file = entries.find((entry) => entry.path === "openclaw.json")
  if (!file || file.size > 1024 * 1024) return { timezone: "UTC", preferences: {} }
  const raw = await file.read()
  let config: unknown
  try {
    config = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw))
  } catch {
    // Metadata is optional. Credentials and unparsed configuration are never copied to the profile.
    warnings.push("OpenClaw identity metadata could not be read; the personal files were still imported.")
    return { timezone: "UTC", preferences: {} }
  }
  const agents = property(config, "agents", "list")
  const agent = Array.isArray(agents)
    ? (agents.find((value) => property(value, "id") === "main") ?? agents[0])
    : undefined
  const zone =
    string(property(config, "agents", "defaults", "userTimezone")) ??
    string(property(config, "plugins", "entries", "memory-core", "config", "dreaming", "timezone")) ??
    "UTC"
  let timezone = zone
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format()
  } catch {
    warnings.push("OpenClaw timezone was invalid; the imported profile uses UTC.")
    timezone = "UTC"
  }
  return {
    name: string(property(agent, "identity", "name")),
    agentID: string(property(agent, "id")),
    timezone,
    preferences: {
      voice: string(property(config, "messages", "tts", "providers", "openai", "voice")),
      autoVoice: string(property(config, "messages", "tts", "auto")),
    },
  }
}

async function collect(entries: Entry[], census: SourceCensus = emptyCensus()): Promise<Archive> {
  const warnings: string[] = []
  const selected = entries.filter((entry) => personalFile(entry.path)).sort((a, b) => a.path.localeCompare(b.path))
  if (!selected.some((entry) => entry.path === "workspace/SOUL.md"))
    throw new CompanionInvalidInput({
      message: "No workspace/SOUL.md found. Select an OpenClaw home, workspace, or ZIP.",
    })
  if (selected.length > Limits.importFiles || selected.reduce((sum, entry) => sum + entry.size, 0) > Limits.importBytes)
    throw new CompanionInvalidInput({ message: "Personal archive exceeds the import limit (4096 files / 64 MiB)." })
  const seen = new Set<string>()
  const files: SourceFile[] = []
  for (const entry of selected) {
    if (seen.has(entry.path.toLowerCase()))
      throw new CompanionInvalidInput({ message: `Archive has duplicate personal paths: ${entry.path}` })
    seen.add(entry.path.toLowerCase())
    if (entry.size > Limits.sourceFile)
      throw new CompanionInvalidInput({ message: `Personal source exceeds 8 MiB: ${entry.path}` })
    const bytes = await entry.read()
    if (bytes.byteLength !== entry.size || bytes.byteLength > Limits.sourceFile)
      throw new CompanionInvalidInput({ message: `Personal source size changed while reading: ${entry.path}` })
    const text = /\.(md|txt|json|html)(?:\.[^/]*)?$/i.test(entry.path)
    let verified: SourceFile["encoding"] = text ? "utf8" : "binary"
    let stored: Uint8Array = bytes
    let original: Uint8Array | undefined
    if (text) {
      try {
        decode(bytes, entry.path)
        verified = "utf8"
      } catch {
        const repaired = transcodeMixed(bytes)
        if (repaired) {
          // The active copy becomes a faithful UTF-8 transcode; source bytes and the manifest hash
          // keep the original so repeat imports of the same archive still match.
          warnings.push(`Mixed-encoding source transcoded to UTF-8 for recall; original bytes preserved: ${entry.path}`)
          verified = "transcoded"
          stored = repaired
          original = bytes
        } else {
          warnings.push(`Non-UTF-8 source preserved; excluded from automatic recall until repaired: ${entry.path}`)
          verified = "unknown"
        }
      }
    }
    files.push({ path: entry.path, bytes: stored, original, hash: digest(bytes), text, encoding: verified })
  }
  warnings.push(
    "Legacy AGENTS.md and skills are preserved as sources only. Heartbeat, scheduled tasks, channels and voice are not activated by importing.",
  )
  if (!files.some((file) => file.path === "workspace/MEMORY.md"))
    warnings.push("No MEMORY.md was found; only the available personal files were imported.")
  const details = await metadata(entries, warnings)
  // Keep the original personal-file digest stable so a repeat import can add history
  // to an existing profile without replacing its independently updated diary or Soul.
  const originalDigest = digest(JSON.stringify({ files: files.map((file) => [file.path, file.hash]), ...details }))
  const agent = details.agentID ?? "main"
  if (!/^[a-zA-Z0-9_-]+$/.test(agent))
    throw new CompanionInvalidInput({ message: "OpenClaw agent id is not a safe transcript directory name." })
  const index = entries.find((entry) => entry.path === `agents/${agent}/sessions/sessions.json`)
  let internal = new Set<string>()
  if (index && index.size <= 1024 * 1024) {
    try {
      internal = internalTranscripts(decode(await index.read(), index.path))
    } catch {
      // The index is optional; record-level provenance still applies to every transcript.
      warnings.push("Session index could not be read; historical conversations use record-level provenance only.")
    }
  }
  const histories = entries
    .filter((entry) => transcriptPath(entry.path, agent))
    .sort((a, b) => a.path.localeCompare(b.path))
  if (
    histories.reduce((sum, entry) => sum + entry.size, 0) > Limits.importBytes ||
    histories.length > Limits.importFiles
  )
    throw new CompanionInvalidInput({ message: "Conversation sources exceed 4096 transcripts / 64 MiB." })
  const derived: SourceFile[] = []
  let invalidRecords = 0
  let extracted = 0
  let humanTurns = 0
  let internalExcluded = 0
  let noUsableText = 0
  for (const entry of histories) {
    if (internal.has(path.posix.basename(entry.path).split(".jsonl")[0])) {
      internalExcluded++
      continue
    }
    if (entry.size > Limits.sourceFile)
      throw new CompanionInvalidInput({ message: `Conversation source exceeds 8 MiB: ${entry.path}` })
    const raw = await entry.read()
    if (raw.byteLength !== entry.size)
      throw new CompanionInvalidInput({ message: `Conversation source size changed while reading: ${entry.path}` })
    const result = await transcript(decode(raw, entry.path), entry.path, digest(raw))
    invalidRecords += result.invalid
    extracted += result.extracted
    humanTurns += result.humanTurns
    if (result.internal) internalExcluded++
    else if (!result.text) noUsableText++
    if (!result.text) continue
    const bytes = Buffer.from(result.text)
    if (bytes.byteLength > Limits.textFile)
      throw new CompanionInvalidInput({ message: `Readable conversation exceeds 4 MiB: ${entry.path}` })
    derived.push({
      path: `workspace/history/openclaw-${digest(entry.path).slice(0, 24)}.md`,
      bytes,
      hash: digest(bytes),
      text: true,
      encoding: "utf8",
    })
  }
  if (invalidRecords)
    warnings.push(
      `${invalidRecords} invalid historical conversation records were skipped; intact records were retained.`,
    )
  if (histories.length)
    warnings.push(
      `Imported ${derived.length} historical conversation text files. Internal tasks, trajectories, deleted sessions and tool payloads remain outside personal recall.`,
    )
  if (
    files.length + derived.length > Limits.importFiles ||
    [...files, ...derived].reduce((sum, file) => sum + file.bytes.byteLength, 0) > Limits.importBytes
  )
    throw new CompanionInvalidInput({
      message: "Personal files and readable conversations exceed 4096 files / 64 MiB.",
    })
  const trajectorySkipped = census.trajectory
  const coverage = new Coverage({
    jsonl: {
      scanned: census.jsonl,
      extracted,
      internalExcluded,
      noUsableText,
      parseFailedRecords: invalidRecords,
    },
    trajectory: {
      scanned: trajectorySkipped,
      notImported: trajectorySkipped,
      reason: "Runtime traces and cron/heartbeat sessions are not reliable personal conversations; kept at source.",
    },
    deleted: { found: census.deleted, excluded: census.deleted },
    other: {
      deduplicated: 0,
      conflicts: 0,
    },
    final: {
      searchableFiles: derived.length,
      humanTurns,
      uncoveredSources: census.trajectory + census.deleted + census.other + internalExcluded + noUsableText,
    },
  })
  return {
    files: [...files, ...derived],
    digest: originalDigest,
    historyDigest: digest(JSON.stringify(derived.map((file) => [file.path, file.hash]))),
    ...details,
    warnings,
    coverage,
    sourceCensus: census,
  }
}

async function directoryEntries(root: string): Promise<{ entries: Entry[]; census: SourceCensus }> {
  const entries: Entry[] = []
  const census = emptyCensus()
  const workspaceOnly = await fs.lstat(path.join(root, "SOUL.md")).then(
    (stat) => stat.isFile(),
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false
      throw error
    },
  )
  async function walk(relative: string) {
    const children = await fs.readdir(path.join(root, relative), { withFileTypes: true })
    for (const child of children) {
      if (child.isSymbolicLink()) continue
      if (child.name === ".git" || child.name === "node_modules") continue
      const source = path.posix.join(relative, child.name)
      const key = workspaceOnly ? `workspace/${source}` : source
      if (child.isDirectory()) {
        if (
          workspaceOnly ||
          /^(workspace(?:\/|$)|oldmemory$|workspace-backup-[^/]+$|profiles(?:\/|$)|media(?:\/|$)|agents$|agents\/[^/]+(?:\/sessions)?$)/.test(
            source,
          )
        )
          await walk(source)
        continue
      }
      if (!child.isFile()) continue
      // Census every session source (including skipped ones) before the import filter.
      const kind = classifySource(key)
      if (kind) census[kind]++
      if (
        !personalFile(key) &&
        key !== "openclaw.json" &&
        !transcriptPath(key) &&
        !/^agents\/[^/]+\/sessions\/sessions\.json$/.test(key)
      )
        continue
      const full = path.join(root, source)
      const stat = await fs.stat(full)
      entries.push({ path: safePath(key), size: stat.size, read: () => fs.readFile(full) })
    }
  }
  await walk("")
  return { entries, census }
}

export async function readArchive(source: string) {
  if (!path.isAbsolute(source)) throw new CompanionInvalidInput({ message: "Archive source must be an absolute path." })
  const stat = await fs.lstat(source)
  if (stat.isDirectory()) {
    const { entries, census } = await directoryEntries(source)
    return collect(entries, census)
  }
  if (!stat.isFile() || !/\.zip$/i.test(source))
    throw new CompanionInvalidInput({ message: "Select a directory or a ZIP archive." })
  if (stat.size > Limits.archive)
    throw new CompanionInvalidInput({ message: "ZIP archive exceeds the 512 MiB import limit." })
  await using file = await fs.open(source, "r")
  const reader = new ZipReader(new ArchiveReader(file, stat.size), { useWebWorkers: false })
  try {
    const zipped = await reader.getEntries()
    const names = zipped.map((entry) => safePath(entry.filename))
    const prefix = names.some((name) => name === "workspace/SOUL.md")
      ? ""
      : (names.find((name) => name.endsWith("/workspace/SOUL.md"))?.slice(0, -"workspace/SOUL.md".length) ?? "")
    const workspaceOnly = !prefix && !names.includes("workspace/SOUL.md") && names.includes("SOUL.md")
    const entries = zipped.flatMap((entry, index): Entry[] => {
      const name = names[index]
      if (entry.directory || (prefix && !name.startsWith(prefix))) return []
      const relative = name.slice(prefix.length)
      const key = workspaceOnly ? `workspace/${relative}` : relative
      if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000)
        throw new CompanionInvalidInput({ message: "Symbolic links in ZIP archives are not supported." })
      if (!entry.getData) throw new CompanionInvalidInput({ message: "ZIP entry has no readable data." })
      const getData = entry.getData.bind(entry)
      return [
        {
          path: key,
          size: entry.uncompressedSize,
          read: () => getData(new Uint8ArrayWriter(), { checkSignature: true }),
        },
      ]
    })
    const census = emptyCensus()
    for (const name of names) {
      const kind = classifySource(name)
      if (kind) census[kind]++
    }
    return await collect(entries, census)
  } finally {
    await reader.close()
  }
}
