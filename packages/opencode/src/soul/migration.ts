import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import matter from "gray-matter"
import { ConfigMarkdown } from "@/config/markdown"
import { ID_PATTERN, MAX_SOUL_BYTES } from "./schema"

export type LegacySoulMigration = {
  issues: string[]
  defaults: Partial<Record<"tui" | "desktop", string>>
}

export const MAX_LEGACY_DEFAULTS_BYTES = 1024
const markerName = ".legacy-defaults.json"
type Defaults = Partial<Record<"tui" | "desktop", string>>
type Marker = { version: 1; defaults: Defaults; copies?: Defaults }
type FileMetadata = {
  id: string
  name: string
  display_name?: string
  commit_prefix?: string
  avatar?: string
}

export function writeSoulIfAbsent(file: string, content: string): boolean {
  try {
    const fd = fs.openSync(file, "wx")
    try {
      fs.writeFileSync(fd, content)
    } finally {
      fs.closeSync(fd)
    }
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false
    throw error
  }
}

const sourceFiles = [
  { file: "Tsoul.md", client: "tui" },
  { file: "Gsoul.md", client: "desktop" },
] as const

export function readLegacyDefaults(directory: string): {
  defaults: Defaults
  copies: Defaults
  issue?: string
  valid: boolean
} {
  const file = path.join(directory, markerName)
  if (!fs.existsSync(file)) return { defaults: {}, copies: {}, valid: false }
  try {
    const fd = fs.openSync(file, "r")
    let raw: string | undefined
    try {
      const size = fs.fstatSync(fd).size
      if (size > MAX_LEGACY_DEFAULTS_BYTES) throw new Error(`exceeds ${MAX_LEGACY_DEFAULTS_BYTES} bytes`)
      const buffer = Buffer.alloc(MAX_LEGACY_DEFAULTS_BYTES + 1)
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0)
      if (bytes > MAX_LEGACY_DEFAULTS_BYTES) throw new Error(`exceeds ${MAX_LEGACY_DEFAULTS_BYTES} bytes`)
      raw = buffer.toString("utf8", 0, bytes)
    } finally {
      fs.closeSync(fd)
    }
    const value: unknown = JSON.parse(raw)
    if (!isMarker(value)) throw new Error("invalid marker shape")
    return { defaults: value.defaults, copies: value.copies ?? {}, valid: true }
  } catch (error) {
    return {
      defaults: {},
      copies: {},
      valid: false,
      issue: `${markerName} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export function migrateLegacySouls(directory: string): LegacySoulMigration {
  const result: LegacySoulMigration = { issues: [], defaults: {} }
  const prior = readLegacyDefaults(directory)
  const copies: Defaults = { ...prior.copies }
  let hasSource = false
  if (prior.issue) result.issues.push(prior.issue)
  for (const source of sourceFiles) {
    const sourcePath = path.join(directory, source.file)
    if (!fs.existsSync(sourcePath)) {
      // 261008 Red 旧文件缺失时旧运行时使用内嵌人格；仅在一次性历史迁移边界回填。
      result.defaults[source.client] = prior.defaults[source.client] ?? (source.client === "tui" ? "karina" : "yuqi")
      continue
    }
    hasSource = true
    let raw: string | undefined
    try {
      raw = readBounded(sourcePath, MAX_SOUL_BYTES)
      if (raw === undefined) {
        result.issues.push(`${source.file} exceeds ${MAX_SOUL_BYTES} bytes; migration skipped`)
        continue
      }
    } catch (error) {
      result.issues.push(`${source.file} could not be read: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    const parsed = parse(raw)
    if (!parsed) {
      result.issues.push(`${source.file} has malformed metadata; migration skipped`)
      continue
    }
    const heading = parsed.content
      .split(/\r?\n/)
      .find((line) => line.startsWith("# "))
      ?.slice(2)
      .split("·")[0]
      ?.trim()
    const meta = parsed.data
    const officialName = source.client === "tui" ? "柳智敏" : "宋雨琦"
    const official = meta?.name === officialName || (!meta?.name && heading === officialName)
    const id =
      validId(meta?.id) ?? (official ? (source.client === "tui" ? "karina" : "yuqi") : `legacy-${source.client}`)
    const targetPath = path.join(directory, `${id}.md`)
    const name = meta?.name?.trim() || heading || id
    const metadata: Record<string, string> = {
      id,
      name,
      display_name: meta?.display_name ?? (official ? (source.client === "tui" ? "敏敏" : "雨琦") : name),
      commit_prefix:
        meta?.commit_prefix ??
        (official ? (source.client === "tui" ? "Karina" : "YuQi") : (meta?.display_name ?? name)),
      ...(meta?.avatar ? { avatar: meta.avatar } : {}),
    }
    const content = `---\n${Object.entries(metadata)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join("\n")}\n---\n${parsed.content}`
    if (Buffer.byteLength(content, "utf8") > MAX_SOUL_BYTES) {
      result.issues.push(`${source.file} migration would exceed ${MAX_SOUL_BYTES} bytes; source preserved`)
      continue
    }
    if (fs.existsSync(targetPath)) {
      let existing: ReturnType<typeof parse>
      try {
        const targetRaw = readBounded(targetPath, MAX_SOUL_BYTES)
        if (targetRaw === undefined) {
          result.issues.push(`${path.basename(targetPath)} exceeds ${MAX_SOUL_BYTES} bytes; conflict not inspected`)
          continue
        }
        existing = parse(targetRaw)
      } catch (error) {
        result.issues.push(
          `${path.basename(targetPath)} could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
        )
        continue
      }
      if (
        existing &&
        isMetadata(existing.data) &&
        existing.data.id === id &&
        existing.data.name.trim() === metadata.name &&
        (existing.data.display_name ?? existing.data.name) === metadata.display_name &&
        (existing.data.commit_prefix ?? existing.data.display_name ?? existing.data.name) === metadata.commit_prefix &&
        existing.data.avatar === metadata.avatar &&
        existing.content === parsed.content
      ) {
        result.defaults[source.client] = id
        copies[source.client] = id
      } else {
        result.defaults[source.client] = validId(meta?.id) ?? path.basename(source.file, ".md").toLowerCase()
        result.issues.push(`${source.file} was not migrated because ${path.basename(targetPath)} already exists`)
      }
      continue
    }
    try {
      const fd = fs.openSync(targetPath, "wx")
      try {
        fs.writeFileSync(fd, content)
      } finally {
        fs.closeSync(fd)
      }
      result.defaults[source.client] = id
      copies[source.client] = id
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        // The destination won a concurrent create; never replace its contents.
        result.issues.push(`${source.file} was not migrated because ${path.basename(targetPath)} already exists`)
        continue
      }
      result.issues.push(`${source.file} migration failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (hasSource && Object.keys(result.defaults).length && !prior.issue) {
    const defaults = { ...prior.defaults, ...result.defaults }
    try {
      writeNoClobber(
        path.join(directory, markerName),
        JSON.stringify({ version: 1, defaults, copies } satisfies Marker),
      )
    } catch (error) {
      result.issues.push(`${markerName} could not be saved: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const validated = readLegacyDefaults(directory)
  if (validated.issue) result.issues.push(validated.issue)
  if (validated.valid) result.defaults = validated.defaults
  return result
}

function writeNoClobber(file: string, content: string): boolean {
  if (Buffer.byteLength(content, "utf8") > MAX_LEGACY_DEFAULTS_BYTES)
    throw new Error("legacy defaults marker exceeds byte limit")
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, content, { flag: "wx" })
    try {
      fs.linkSync(temporary, file)
      return true
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") return false
      throw error
    }
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function validId(value: unknown): string | undefined {
  return typeof value === "string" && ID_PATTERN.test(value) ? value : undefined
}

function readBounded(file: string, maxBytes: number): string | undefined {
  const fd = fs.openSync(file, "r")
  try {
    if (fs.fstatSync(fd).size > maxBytes) return undefined
    const buffer = Buffer.alloc(maxBytes + 1)
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0)
    return bytes > maxBytes ? undefined : buffer.toString("utf8", 0, bytes)
  } finally {
    fs.closeSync(fd)
  }
}

function parse(raw: string): { data?: FileMetadata; content: string } | undefined {
  try {
    const result = matter(raw)
    const hasFrontmatter = raw.startsWith("---")
    if (!hasFrontmatter) return { content: result.content }
    if (!isMetadata(result.data)) return undefined
    return { data: result.data, content: result.content }
  } catch {
    // gray-matter can reject malformed fences; retry with the shared sanitizer.
    try {
      const result = matter(ConfigMarkdown.fallbackSanitization(raw))
      if (!raw.startsWith("---")) return { content: result.content }
      if (!isMetadata(result.data)) return undefined
      return { data: result.data, content: result.content }
    } catch {
      // Both parsers rejected the metadata; the caller reports a migration issue.
      return undefined
    }
  }
}

function isMetadata(value: unknown): value is FileMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const data = value as Record<string, unknown>
  if (Object.keys(data).some((key) => !["id", "name", "display_name", "commit_prefix", "avatar"].includes(key)))
    return false
  return (
    validId(data.id) !== undefined &&
    typeof data.name === "string" &&
    data.name.trim() !== "" &&
    ["display_name", "commit_prefix", "avatar"].every(
      (key) => data[key] === undefined || (typeof data[key] === "string" && data[key].trim() !== ""),
    )
  )
}

function isMarker(value: unknown): value is Marker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const marker = value as Record<string, unknown>
  if (Object.keys(marker).some((key) => !["version", "defaults", "copies"].includes(key)) || marker.version !== 1)
    return false
  if (typeof marker.defaults !== "object" || marker.defaults === null || Array.isArray(marker.defaults)) return false
  const defaults = marker.defaults as Record<string, unknown>
  if (
    !Object.keys(defaults).every((key) => ["tui", "desktop"].includes(key)) ||
    !Object.values(defaults).every((id) => typeof id === "string" && ID_PATTERN.test(id))
  )
    return false
  if (marker.copies === undefined) return true
  if (typeof marker.copies !== "object" || marker.copies === null || Array.isArray(marker.copies)) return false
  const copies = marker.copies as Record<string, unknown>
  return (
    Object.keys(copies).every((key) => ["tui", "desktop"].includes(key)) &&
    Object.values(copies).every((id) => typeof id === "string" && ID_PATTERN.test(id))
  )
}
