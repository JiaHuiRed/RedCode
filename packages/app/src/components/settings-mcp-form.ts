import type { McpLocalConfig, McpRemoteConfig } from "@redcode-ai/sdk/v2/client"

export type McpDefinition = McpLocalConfig | McpRemoteConfig
export type McpFormValues = {
  name: string
  type: "local" | "remote"
  command: string
  url: string
  cwd: string
  timeout: string
  tools: string
  toolsMode: "all" | "list" | "none"
  enabled: boolean
  environment: string
  headers: string
}

const parseCommand = (value: string): string[] | undefined => {
  const text = value.trim()
  if (!text) return []
  if (!text.startsWith("[")) return /["']/.test(text) ? undefined : text.split(/\s+/)
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) && parsed.every((part) => typeof part === "string") ? parsed : undefined
  } catch {
    // Only JSON parsing can fail here; the form reports the invalid command without changing config.
    return undefined
  }
}

export function formatMcpPairs(values: Record<string, string> | undefined, separator: "=" | ":") {
  if (!values) return ""
  const entries = Object.entries(values)
  if (entries.some(([key, value]) => /[\r\n]/.test(key + value))) return JSON.stringify(values, null, 2)
  return entries.map(([key, value]) => `${key}${separator}${separator === ":" ? " " : ""}${value}`).join("\n")
}

function parsePairs(text: string, separator: "=" | ":"): Record<string, string> | undefined {
  let entries: [string, string][]
  if (text.trim().startsWith("{")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // The advanced editor also accepts a JSON string map for values containing newlines.
      return undefined
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
    const pairs = Object.entries(parsed)
    if (pairs.some(([, value]) => typeof value !== "string")) return undefined
    entries = pairs as [string, string][]
  } else {
    entries = []
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      const index = line.indexOf(separator)
      if (index <= 0) return undefined
      entries.push([
        line.slice(0, index).trim(),
        separator === ":" ? line.slice(index + 1).trim() : line.slice(index + 1),
      ])
    }
  }
  const keys = new Set<string>()
  for (const [key, value] of entries) {
    if (!key || /[\0\r\n=]/.test(key)) return undefined
    if (separator === ":" && (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n]/.test(value))) return undefined
    const normalized = separator === ":" ? key.toLowerCase() : key
    if (keys.has(normalized)) return undefined
    keys.add(normalized)
  }
  return Object.fromEntries(entries)
}

export function validateMcpForm(form: McpFormValues) {
  const id = form.name.trim()
  if (!id) return { error: "settings.desktop.mcp.nameRequired" } as const
  const command = parseCommand(form.command)
  if (form.type === "local") {
    if (!command) return { error: "settings.mcp.toast.commandInvalid" } as const
    if (!command.length || !command[0].trim()) return { error: "settings.desktop.mcp.commandRequired" } as const
  }
  const url = form.url.trim()
  if (form.type === "remote") {
    const parsed = URL.canParse(url) ? new URL(url) : undefined
    if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
      return { error: "settings.desktop.mcp.urlInvalid" } as const
    }
  }
  const timeout = form.timeout.trim() ? Number(form.timeout) : undefined
  if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout <= 0)) {
    return { error: "settings.desktop.mcp.timeoutInvalid" } as const
  }
  const tools = [
    ...new Set(
      form.tools
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ]
  if (form.toolsMode === "list" && !tools.length) return { error: "settings.mcp.toast.toolsRequired" } as const
  const pairs = parsePairs(form.type === "local" ? form.environment : form.headers, form.type === "local" ? "=" : ":")
  if (!pairs) {
    return {
      error: form.type === "local" ? "settings.desktop.mcp.environmentInvalid" : "settings.desktop.mcp.headersInvalid",
    } as const
  }
  const shared = {
    enabled: form.enabled,
    ...(timeout === undefined ? {} : { timeout }),
    ...(form.toolsMode === "all" ? {} : { tools: form.toolsMode === "none" ? [] : tools }),
  }
  const config: McpDefinition =
    form.type === "local"
      ? {
          type: "local",
          command: command!,
          environment: pairs,
          ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
          ...shared,
        }
      : { type: "remote", url, headers: pairs, ...shared }
  return { id, config }
}
