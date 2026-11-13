// 261007 Red Soul System V2：Soul Registry —— 发现并解析 ~/.redcode/souls/*.md。
// "Soul is the sole source of truth for assistant identity"（设计 §56）：凡是回答
// 「当前 AI 是谁」（注入正文 / 显示名 / commit 前缀）的地方都从这里取，禁止 client→身份推导。
// 设计与实现记录：docs/notes/implemented/architecture/2026-10-07-soul-system-v2-design.md、
// docs/notes/implemented/architecture/2026-10-07-soul-system-v2.md。
import { Global } from "@redcode-ai/core/global"
import { Context, Effect, Layer, Schema } from "effect"
import fs from "node:fs"
import path from "node:path"
import matter from "gray-matter"
import { ConfigMarkdown } from "@/config/markdown"
import {
  ID_PATTERN,
  MAX_SOUL_BYTES,
  MAX_SOUL_DESCRIPTION_BYTES,
  type Info,
  type Issue,
  type Summary,
  type Details,
  type MetadataSource,
} from "./schema"
import { readLegacyDefaults, writeSoulIfAbsent } from "./migration"

export * from "./schema"

export type CreateStructuredInput = {
  id: string
  name: string
  displayName?: string
  commitPrefix?: string
  avatar?: string
  description?: string
  content: string
}

export type CreateMarkdownInput = {
  markdown: string
}

export type CreateInput = CreateStructuredInput | CreateMarkdownInput

// 261113 Red 创建失败分三类：无效输入（400）、ID/文件冲突（409）、落盘失败（IO），由 HTTP 层映射。
export class SoulInvalidInput extends Schema.TaggedError<SoulInvalidInput>()("SoulInvalidInput", {
  message: Schema.String,
  field: Schema.optional(Schema.String),
}) {}

export class SoulConflict extends Schema.TaggedError<SoulConflict>()("SoulConflict", {
  message: Schema.String,
  path: Schema.optional(Schema.String),
}) {}

export class SoulIO extends Schema.TaggedError<SoulIO>()("SoulIO", {
  message: Schema.String,
}) {}

// 目录走 Context.Reference（包规范：配置路径可测）：测试用 Layer.succeed 覆盖。
export const directory = Context.Reference<string>("opencode/Soul.directory", {
  defaultValue: () => path.join(Global.Path.home, ".redcode", "souls"),
})

export interface Interface {
  readonly list: () => Effect.Effect<Summary[]>
  readonly issues: () => Effect.Effect<Issue[]>
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly details: (id: string) => Effect.Effect<Details | undefined>
  readonly defaultForClient: (client: string) => Effect.Effect<string>
  readonly create: (input: CreateInput) => Effect.Effect<Summary, SoulInvalidInput | SoulConflict | SoulIO>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Soul") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // 每次调用取目录（不在 layer 构造期捕获）：测试可用 provideService 覆盖。
    const list = Effect.fn("Soul.list")(function* () {
      const dir = yield* directory
      return scan(dir).items.map((item) => item.summary)
    })

    const issues = Effect.fn("Soul.issues")(function* () {
      const dir = yield* directory
      return scan(dir).issues
    })

    const get = Effect.fn("Soul.get")(function* (id: string) {
      const dir = yield* directory
      const found = scan(dir).items.find((item) => item.summary.id === id)
      if (!found) return undefined
      return { ...found.summary, path: found.path, content: found.content }
    })

    const details = Effect.fn("Soul.details")(function* (id: string) {
      const dir = yield* directory
      const found = scan(dir).items.find((item) => item.summary.id === id)
      if (!found) return undefined
      return { ...found.summary, path: found.path, content: found.content, sources: found.sources }
    })

    const defaultForClient = Effect.fn("Soul.defaultForClient")(function* (client: string) {
      // 迁移期默认映射（设计 §13）：只作「新会话缺省偏好」，不是身份推理。
      if (client !== "tui" && client !== "desktop") return ""
      const dir = yield* directory
      const state = scan(dir)
      const marker = readLegacyDefaults(dir)
      const marked = marker.valid ? marker.defaults[client] : undefined
      if (marked && state.items.some((item) => item.summary.id === marked)) return marked
      const alias = client === "desktop" ? "gsoul.md" : "tsoul.md"
      return (
        state.items.find((item) => path.basename(item.path).toLowerCase() === alias)?.summary.id ??
        (client === "desktop" ? "yuqi" : "karina")
      )
    })

    const create = Effect.fn("Soul.create")(function* (input: CreateInput) {
      const dir = yield* directory
      const prepared = prepareCreate(input)
      if (prepared instanceof SoulInvalidInput) return yield* prepared
      const target = path.join(dir, `${prepared.id}.md`)
      const ioError = (error: unknown) =>
        new SoulIO({ message: `could not create Soul "${prepared.id}": ${errorMessage(error)}` })
      // 261113 Red 唯一性以 metadata.id 为准：同 ID 换了文件名也算冲突。
      const existing = yield* Effect.try({
        try: () => {
          fs.mkdirSync(dir, { recursive: true })
          return scan(dir).items.find((item) => item.summary.id === prepared.id)
        },
        catch: ioError,
      })
      if (existing)
        return yield* new SoulConflict({ message: `Soul "${prepared.id}" already exists`, path: existing.path })
      const written = yield* Effect.try({ try: () => writeSoulIfAbsent(target, prepared.markdown), catch: ioError })
      if (!written) return yield* new SoulConflict({ message: `Soul "${prepared.id}" already exists`, path: target })
      return prepared.summary
    })

    return Service.of({ list, issues, get, details, defaultForClient, create })
  }),
)

export const defaultLayer = layer

// --- helpers：主流程在 layer 里，扫描细节都放这里 ---

type Scanned = { summary: Summary; path: string; content: string; sources: Details["sources"] }

function readSafe(file: string): string | undefined {
  try {
    const fd = fs.openSync(file, "r")
    try {
      const size = fs.fstatSync(fd).size
      if (size > MAX_SOUL_BYTES) return undefined
      const buffer = Buffer.alloc(MAX_SOUL_BYTES + 1)
      const bytes = fs.readSync(fd, buffer, 0, MAX_SOUL_BYTES + 1, 0)
      if (bytes > MAX_SOUL_BYTES) return undefined
      return buffer.toString("utf8", 0, bytes)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    // 文件不存在 / 不可读：registry 不因单个文件失败而崩（设计 §39 的「坏 Soul 不炸 Registry」）
    return undefined
  }
}

// gray-matter 标准解析 + 宽容回退（与 config/markdown.ts 同策略）；两级都失败返回 undefined。
function parseText(raw: string): ReturnType<typeof matter> | undefined {
  try {
    return matter(raw)
  } catch {
    try {
      return matter(ConfigMarkdown.fallbackSanitization(raw))
    } catch {
      return undefined
    }
  }
}

// 无有效 frontmatter 的旧文件（如 Tsoul.md）：文件名做稳定 id，正文首个标题行取名字。
// 不猜测身份归属——「Tsoul.md = 柳智敏」这类映射只允许发生在一次性迁移里（设计 §36）。
function legacySummary(file: string, content: string): Summary | undefined {
  const id = path.basename(file, ".md").toLowerCase()
  if (!ID_PATTERN.test(id)) return undefined
  const heading = content.split(/\r?\n/).find((line) => line.startsWith("# "))
  const name = heading?.slice(2).split("·")[0]?.trim() || id
  return { id, name, displayName: name, commitPrefix: name }
}

function scan(dir: string): { items: Scanned[]; issues: Issue[] } {
  const entries = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((entry) => entry.endsWith(".md"))
        .sort()
    : []
  const items: Scanned[] = []
  const issues: Issue[] = []

  for (const entry of entries) {
    const file = path.join(dir, entry)
    try {
      if (fs.statSync(file).size > MAX_SOUL_BYTES) {
        issues.push({ path: file, message: `exceeds ${MAX_SOUL_BYTES} bytes` })
        continue
      }
    } catch {
      // File vanished between directory enumeration and inspection; report it as unreadable below.
    }
    const raw = readSafe(file)
    if (raw === undefined) {
      issues.push({ path: file, message: "unreadable" })
      continue
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_SOUL_BYTES) {
      issues.push({ path: file, message: `exceeds ${MAX_SOUL_BYTES} bytes` })
      continue
    }
    const parsed = validateDocument(raw)
    if (parsed.kind === "invalid") {
      issues.push({ path: file, message: parsed.message })
      continue
    }
    const metadata = parsed.kind === "valid" ? parsed.metadata : undefined
    const summary = metadata ? summaryFrom(metadata) : legacySummary(file, parsed.content)
    if (!summary) {
      issues.push({ path: file, message: "invalid frontmatter: missing id" })
      continue
    }
    const frontmatter = (present: boolean): MetadataSource =>
      metadata ? (present ? "frontmatter" : "fallback") : "fallback"
    items.push({
      summary,
      path: file,
      content: parsed.content.trim(),
      sources: {
        id: frontmatter(!!metadata),
        name: frontmatter(!!metadata),
        displayName: frontmatter(!!metadata?.display_name),
        commitPrefix: frontmatter(!!metadata?.commit_prefix),
        avatar: metadata?.avatar ? "frontmatter" : "absent",
        description: metadata?.description ? "frontmatter" : "absent",
      },
    })
  }

  const marker = readLegacyDefaults(dir)
  if (marker.issue) issues.push({ path: path.join(dir, ".legacy-defaults.json"), message: marker.issue })
  // 261008 Red 先剥离有迁移凭证的旧副本，再按稳定顺序判重；同 id 冲突不能静默换正文。
  const seen = new Set<string>()
  const visible = items.filter((item) => {
    const filename = path.basename(item.path).toLowerCase()
    const client = filename === "tsoul.md" ? "tui" : filename === "gsoul.md" ? "desktop" : undefined
    const targetID = client && marker.valid ? marker.defaults[client] : undefined
    if (
      targetID &&
      items.some(
        (entry) =>
          entry.path !== item.path &&
          entry.summary.id === targetID &&
          entry.path === path.join(dir, `${targetID}.md`) &&
          (entry.summary.id !== item.summary.id || (client !== undefined && marker.copies[client] === targetID)),
      )
    )
      return false
    return true
  })
  return {
    items: visible.filter((item) => {
      if (seen.has(item.summary.id)) {
        issues.push({ path: item.path, message: `duplicate soul id "${item.summary.id}"` })
        return false
      }
      seen.add(item.summary.id)
      return true
    }),
    issues,
  }
}

function hasMetadata(data: unknown): boolean {
  return typeof data === "object" && data !== null && Object.keys(data).length > 0
}

type FileMetadata = {
  id: string
  name: string
  display_name?: string
  commit_prefix?: string
  avatar?: string
  description?: string
}

type Prepared = { id: string; summary: Summary; markdown: string }

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function invalid(message: string, field?: string) {
  return new SoulInvalidInput({ message, ...(field === undefined ? {} : { field }) })
}

function prepareCreate(input: CreateInput): Prepared | SoulInvalidInput {
  return "markdown" in input ? prepareMarkdown(input.markdown) : prepareStructured(input)
}

function prepareMarkdown(markdown: string): Prepared | SoulInvalidInput {
  if (typeof markdown !== "string" || markdown.trim() === "") return invalid("markdown must not be empty", "markdown")
  if (Buffer.byteLength(markdown, "utf8") > MAX_SOUL_BYTES)
    return invalid(`Soul file exceeds ${MAX_SOUL_BYTES} bytes`, "markdown")
  const parsed = validateDocument(markdown)
  if (parsed.kind === "invalid") return invalid(parsed.message, "markdown")
  // 无 frontmatter 的旧格式只能靠文件名取 id；一次粘贴没有文件名，必须显式给出 id/name。
  if (parsed.kind === "legacy") return invalid("frontmatter with id and name is required", "markdown")
  return { id: parsed.metadata.id, summary: summaryFrom(parsed.metadata), markdown }
}

function prepareStructured(input: CreateStructuredInput): Prepared | SoulInvalidInput {
  if (!ID_PATTERN.test(input.id)) return invalid(`invalid id "${input.id}"`, "id")
  if (typeof input.name !== "string") return invalid("name must not be empty", "name")
  const name = singleLine(input.name, "name")
  if (name instanceof SoulInvalidInput) return name
  const displayName = optionalSingleLine(input.displayName, "displayName")
  if (displayName instanceof SoulInvalidInput) return displayName
  const commitPrefix = optionalSingleLine(input.commitPrefix, "commitPrefix")
  if (commitPrefix instanceof SoulInvalidInput) return commitPrefix
  const avatar = optionalSingleLine(input.avatar, "avatar")
  if (avatar instanceof SoulInvalidInput) return avatar
  const description = optionalSingleLine(input.description, "description")
  if (description instanceof SoulInvalidInput) return description
  if (description !== undefined && Buffer.byteLength(description, "utf8") > MAX_SOUL_DESCRIPTION_BYTES)
    return invalid(`description exceeds ${MAX_SOUL_DESCRIPTION_BYTES} UTF-8 bytes`, "description")
  if (typeof input.content !== "string" || input.content.trim() === "")
    return invalid("content must not be empty", "content")

  const metadata: Array<[string, string | undefined]> = [
    ["id", input.id],
    ["name", name],
    ["display_name", displayName],
    ["commit_prefix", commitPrefix],
    ["avatar", avatar],
    ["description", description],
  ]
  // JSON 字符串字面量同时是合法的 YAML 双引号标量：冒号、井号、引号、反斜杠都不会破坏 frontmatter。
  const lines = metadata.flatMap(([key, value]) => (value === undefined ? [] : [`${key}: ${JSON.stringify(value)}`]))
  const body = input.content.endsWith("\n") ? input.content : `${input.content}\n`
  const markdown = `---\n${lines.join("\n")}\n---\n\n${body}`
  if (Buffer.byteLength(markdown, "utf8") > MAX_SOUL_BYTES)
    return invalid(`Soul file exceeds ${MAX_SOUL_BYTES} bytes`, "content")
  return {
    id: input.id,
    markdown,
    summary: summaryFrom({
      id: input.id,
      name,
      display_name: displayName,
      commit_prefix: commitPrefix,
      avatar,
      description,
    }),
  }
}

function singleLine(value: string, field: string): string | SoulInvalidInput {
  const trimmed = value.trim()
  if (trimmed === "") return invalid(`${field} must not be empty`, field)
  if (/[\r\n]/.test(trimmed)) return invalid(`${field} must be a single line`, field)
  return trimmed
}

function optionalSingleLine(value: string | undefined, field: string): string | undefined | SoulInvalidInput {
  return value === undefined ? undefined : singleLine(value, field)
}

// 创建与 registry 共用同一套解析/校验：粘贴的 Markdown 必须能被 registry 原样识别。
function validateDocument(raw: string):
  | { kind: "valid"; metadata: FileMetadata; content: string }
  | { kind: "legacy"; content: string }
  | { kind: "invalid"; message: string } {
  const parsed = parseText(raw)
  if (!parsed) return { kind: "invalid", message: "failed to parse frontmatter" }
  if (raw.startsWith("---") && !hasMetadata(parsed.data))
    return { kind: "invalid", message: "invalid or incomplete metadata" }
  const description =
    typeof parsed.data === "object" && parsed.data !== null
      ? (parsed.data as Record<string, unknown>).description
      : undefined
  if (typeof description === "string") {
    const trimmed = description.trim()
    if (/[\r\n]/.test(trimmed)) return { kind: "invalid", message: "description must be a single line" }
    if (Buffer.byteLength(trimmed, "utf8") > MAX_SOUL_DESCRIPTION_BYTES)
      return { kind: "invalid", message: `description exceeds ${MAX_SOUL_DESCRIPTION_BYTES} UTF-8 bytes` }
  }
  if (parsed.content.trim() === "") return { kind: "invalid", message: "empty content" }
  // 有完整 metadata 但 id 不合法：明示错误（设计 §39 的 invalid id），不走文件名兼容。
  if (hasMetadata(parsed.data) && !isMetadata(parsed.data))
    return { kind: "invalid", message: "invalid or incomplete metadata" }
  if (isMetadata(parsed.data) && !ID_PATTERN.test(parsed.data.id))
    return { kind: "invalid", message: `invalid id "${parsed.data.id}"` }
  if (!isMetadata(parsed.data)) return { kind: "legacy", content: parsed.content }
  return { kind: "valid", metadata: parsed.data, content: parsed.content }
}

function summaryFrom(metadata: FileMetadata): Summary {
  return {
    id: metadata.id,
    name: metadata.name,
    displayName: metadata.display_name ?? metadata.name,
    commitPrefix: metadata.commit_prefix ?? metadata.display_name ?? metadata.name,
    avatar: metadata.avatar,
    ...(metadata.description ? { description: metadata.description.trim() } : {}),
  }
}

function isMetadata(data: unknown): data is FileMetadata {
  if (typeof data !== "object" || data === null) return false
  const value = data as Record<string, unknown>
  if (
    Object.keys(value).some(
      (key) => !["id", "name", "display_name", "commit_prefix", "avatar", "description"].includes(key),
    )
  )
    return false
  if (typeof value.description === "string" && /[\r\n]/.test(value.description.trim()))
    return false
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    value.name.trim() !== "" &&
    ["display_name", "commit_prefix", "avatar", "description"].every(
      (key) => value[key] === undefined || (typeof value[key] === "string" && value[key].trim() !== ""),
    )
  )
}

export * as Soul from "."
