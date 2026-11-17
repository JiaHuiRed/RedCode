import { Reader, Uint8ArrayWriter, ZipReader } from "@zip.js/zip.js"
import { createHash } from "node:crypto"
import fs, { type FileHandle } from "node:fs/promises"
import path from "node:path"
import { CompanionInvalidInput, Limits } from "./schema"
import { internalTranscripts, transcript, transcriptPath } from "./transcript"

type Entry = { path: string; size: number; read: () => Promise<Uint8Array> }

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
  bytes: Uint8Array
  hash: string
  text: boolean
  encoding: "utf8" | "binary" | "unknown"
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

async function collect(entries: Entry[]): Promise<Archive> {
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
    if (text) {
      try {
        decode(bytes, entry.path)
        verified = "utf8"
      } catch {
        warnings.push(`Non-UTF-8 source preserved; excluded from automatic recall until repaired: ${entry.path}`)
        verified = "unknown"
      }
    }
    files.push({ path: entry.path, bytes, hash: digest(bytes), text, encoding: verified })
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
  for (const entry of histories) {
    if (internal.has(path.posix.basename(entry.path).split(".jsonl")[0])) continue
    if (entry.size > Limits.sourceFile)
      throw new CompanionInvalidInput({ message: `Conversation source exceeds 8 MiB: ${entry.path}` })
    const raw = await entry.read()
    if (raw.byteLength !== entry.size)
      throw new CompanionInvalidInput({ message: `Conversation source size changed while reading: ${entry.path}` })
    const result = await transcript(decode(raw, entry.path), entry.path, digest(raw))
    invalidRecords += result.invalid
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
  return {
    files: [...files, ...derived],
    digest: originalDigest,
    historyDigest: digest(JSON.stringify(derived.map((file) => [file.path, file.hash]))),
    ...details,
    warnings,
  }
}

async function directoryEntries(root: string): Promise<Entry[]> {
  const entries: Entry[] = []
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
      if (
        !child.isFile() ||
        (!personalFile(key) &&
          key !== "openclaw.json" &&
          !transcriptPath(key) &&
          !/^agents\/[^/]+\/sessions\/sessions\.json$/.test(key))
      )
        continue
      const full = path.join(root, source)
      const stat = await fs.stat(full)
      entries.push({ path: safePath(key), size: stat.size, read: () => fs.readFile(full) })
    }
  }
  await walk("")
  return entries
}

export async function readArchive(source: string) {
  if (!path.isAbsolute(source)) throw new CompanionInvalidInput({ message: "Archive source must be an absolute path." })
  const stat = await fs.lstat(source)
  if (stat.isDirectory()) return collect(await directoryEntries(source))
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
    return await collect(entries)
  } finally {
    await reader.close()
  }
}
