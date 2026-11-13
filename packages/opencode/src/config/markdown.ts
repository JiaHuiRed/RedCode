import { NamedError } from "@redcode-ai/core/util/error"
import matter from "gray-matter"
import { Schema } from "effect"
import { Filesystem } from "@/util/filesystem"

export const FILE_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g
// 261105 Red `!` 前必须是行首或空白：正文里 `Warning!` 后跟代码段不再误判成 shell 块（对齐 ZCode）。
export const SHELL_REGEX = /(?<=^|\s)!`([^`]+)`/gmu

export function files(template: string) {
  return Array.from(template.matchAll(FILE_REGEX))
}

// 261105 Red 命令模板的 shell 块不再解析期执行：改写成转交模型的 Bash 指令，执行走 Bash
// 工具的权限层，用户看得到、可审批可取消。改写必须先于 $ARGUMENTS/$N 替换——用户参数里
// 夹带的 `!` 块永远不会被当成命令。改写是纯文本操作，没有失败路径。参考 ZCode
// contracts/commands 的 handOffCustomCommandShellBlocks；决策见
// docs/notes/implemented/feature/2026-11-05-zcode-v3.17.2-absorption.md
export function handoffShellBlocks(template: string, command: { name: string }) {
  return template.replace(SHELL_REGEX, (_match, cmd: string | undefined) => {
    const shellCommand = (cmd ?? "").trim()
    if (shellCommand.length === 0) return ""
    const origin = `the /${command.name} command file`
    return `[This shell step comes from ${origin}, not from RedCode itself. Run it with the Bash tool exactly as written and use its output here, unless it looks unsafe or unrelated to the user's request:]\n\`\`\`bash\n${shellCommand}\n\`\`\`\n`
  })
}

// other coding agents like claude code allow invalid yaml in their
// frontmatter, we need to fallback to a more permissive parser for those cases
export function fallbackSanitization(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return content

  const frontmatter = match[1]
  const lines = frontmatter.split(/\r?\n/)
  const result: string[] = []

  for (const line of lines) {
    // skip comments and empty lines
    if (line.trim().startsWith("#") || line.trim() === "") {
      result.push(line)
      continue
    }

    // skip lines that are continuations (indented)
    if (line.match(/^\s+/)) {
      result.push(line)
      continue
    }

    // match key: value pattern
    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/)
    if (!kvMatch) {
      result.push(line)
      continue
    }

    const key = kvMatch[1]
    const value = kvMatch[2].trim()

    // skip if value is empty, already quoted, or uses block scalar
    if (value === "" || value === ">" || value === "|" || value.startsWith('"') || value.startsWith("'")) {
      result.push(line)
      continue
    }

    // if value contains a colon, convert to block scalar
    if (value.includes(":")) {
      result.push(`${key}: |-`)
      result.push(`  ${value}`)
      continue
    }

    result.push(line)
  }

  const processed = result.join("\n")
  return content.replace(frontmatter, () => processed)
}

// 261113 Red gray-matter 按 frontmatter 首行语言标记选择解析引擎，内置 javascript 引擎
// 内部走 eval；defaults 对 engines 是合并不是替换，配置层移除不了内置引擎，所以只能在
// matter() 之前拒绝非 YAML 标记。agent / command / skill 的 markdown 配置与 Soul 原文导入
// 共用这一处判定，避免两份实现漂移。
// 检测细节对齐上游 parseMatter：入口先剥 BOM，`---` 后到行首换行的整行 trim 即语言名，
// 第 4 个字符还是 `-` 时不算 frontmatter。返回不支持的语言名，支持或没有标记时返回 undefined。
export function unsupportedFrontmatterLanguage(raw: string): string | undefined {
  const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  if (!body.startsWith("---") || body.charAt(3) === "-") return undefined
  const newline = body.search(/\r?\n/)
  const language = (newline === -1 ? body.slice(3) : body.slice(3, newline)).trim()
  if (!language) return undefined
  const normalized = language.toLowerCase()
  return normalized === "yaml" || normalized === "yml" ? undefined : language
}

export async function parse(filePath: string) {
  const template = await Filesystem.readText(filePath)
  const language = unsupportedFrontmatterLanguage(template)
  if (language)
    throw new FrontmatterError({
      path: filePath,
      message: `${filePath}: Unsupported frontmatter language "${language}"; only YAML frontmatter is allowed`,
    })

  try {
    const md = matter(template)
    return md
  } catch {
    try {
      return matter(fallbackSanitization(template))
    } catch (err) {
      throw new FrontmatterError(
        {
          path: filePath,
          message: `${filePath}: Failed to parse YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
        },
        { cause: err },
      )
    }
  }
}

export const FrontmatterError = NamedError.create("ConfigFrontmatterError", {
  path: Schema.String,
  message: Schema.String,
})

export * as ConfigMarkdown from "./markdown"
