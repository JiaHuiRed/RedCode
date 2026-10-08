// 261007 Red Soul System V2：Soul Registry —— 发现并解析 ~/.redcode/souls/*.md。
// "Soul is the sole source of truth for assistant identity"（设计 §56）：凡是回答
// 「当前 AI 是谁」（注入正文 / 显示名 / commit 前缀）的地方都从这里取，禁止 client→身份推导。
// 设计与实现记录：docs/notes/implemented/architecture/2026-10-07-soul-system-v2-design.md、
// docs/notes/implemented/architecture/2026-10-07-soul-system-v2.md。
import { Global } from "@redcode-ai/core/global"
import { Context, Effect, Layer } from "effect"
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
} from "./schema"
import { readLegacyDefaults } from "./migration"

export * from "./schema"

// 目录走 Context.Reference（包规范：配置路径可测）：测试用 Layer.succeed 覆盖。
export const directory = Context.Reference<string>("opencode/Soul.directory", {
  defaultValue: () => path.join(Global.Path.home, ".redcode", "souls"),
})

export interface Interface {
  readonly list: () => Effect.Effect<Summary[]>
  readonly issues: () => Effect.Effect<Issue[]>
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly defaultForClient: (client: string) => Effect.Effect<string>
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

    return Service.of({ list, issues, get, defaultForClient })
  }),
)

export const defaultLayer = layer

// --- helpers：主流程在 layer 里，扫描细节都放这里 ---

type Scanned = { summary: Summary; path: string; content: string }

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
    const parsed = parseText(raw)
    if (!parsed) {
      issues.push({ path: file, message: "failed to parse frontmatter" })
      continue
    }
    if (raw.startsWith("---") && !hasMetadata(parsed.data)) {
      issues.push({ path: file, message: "invalid or incomplete metadata" })
      continue
    }
    const description =
      typeof parsed.data === "object" && parsed.data !== null
        ? (parsed.data as Record<string, unknown>).description
        : undefined
    if (
      typeof description === "string" &&
      (Buffer.byteLength(description.trim(), "utf8") > MAX_SOUL_DESCRIPTION_BYTES || /[\r\n]/.test(description.trim()))
    ) {
      issues.push({
        path: file,
        message: /[\r\n]/.test(description.trim())
          ? "description must be a single line"
          : `description exceeds ${MAX_SOUL_DESCRIPTION_BYTES} UTF-8 bytes`,
      })
      continue
    }
    if (parsed.content.trim() === "") {
      issues.push({ path: file, message: "empty content" })
      continue
    }

    // 有完整 metadata 但 id 不合法：明示错误（设计 §39 的 invalid id），不走文件名兼容。
    if (hasMetadata(parsed.data) && !isMetadata(parsed.data)) {
      issues.push({ path: file, message: "invalid or incomplete metadata" })
      continue
    }
    if (isMetadata(parsed.data) && !ID_PATTERN.test(parsed.data.id)) {
      issues.push({ path: file, message: `invalid id "${parsed.data.id}"` })
      continue
    }
    const summary = isMetadata(parsed.data)
      ? {
          id: parsed.data.id,
          name: parsed.data.name,
          displayName: parsed.data.display_name ?? parsed.data.name,
          commitPrefix: parsed.data.commit_prefix ?? parsed.data.display_name ?? parsed.data.name,
          avatar: parsed.data.avatar,
          ...(parsed.data.description ? { description: parsed.data.description.trim() } : {}),
        }
      : legacySummary(file, parsed.content)
    if (!summary) {
      issues.push({ path: file, message: "invalid frontmatter: missing id" })
      continue
    }
    items.push({ summary, path: file, content: parsed.content.trim() })
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

function isMetadata(data: unknown): data is {
  id: string
  name: string
  display_name?: string
  commit_prefix?: string
  avatar?: string
  description?: string
} {
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
