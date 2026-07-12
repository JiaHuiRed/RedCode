import { Schema } from "effect"

// Raw profile parsed from YAML
export const RawProfile = Schema.Struct({
  name: Schema.String,
  extends: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.Literals(["primary", "subagent", "all"])),
  tools: Schema.optional(Schema.Array(Schema.String)),
  permission: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export type RawProfile = Schema.Schema.Type<typeof RawProfile>

// Resolved profile after extends merge
export interface ResolvedProfile {
  name: string
  description?: string
  prompt?: string
  mode: "primary" | "subagent" | "all"
  tools: string[]
  permission?: Record<string, unknown>
}

// YAML tool name → Permission config key
export const toolPermissionMap: Record<string, string> = {
  Read: "read",
  Write: "edit",
  Edit: "edit",
  Glob: "glob",
  Grep: "grep",
  List: "list",
  Bash: "bash",
  Task: "task",
  WebSearch: "websearch",
  WebFetch: "webfetch",
  Skill: "skill",
  LSP: "lsp",
  RepoClone: "repo_clone",
  RepoOverview: "repo_overview",
  ExternalDirectory: "external_directory",
}

type PermissionRule = "ask" | "allow" | "deny" | Record<string, "ask" | "allow" | "deny">

/** Convert a resolved profile's tools list + mode into a Permission config object */
export function toolsToPermissionConfig(
  tools: string[],
  mode: "primary" | "subagent" | "all",
  extraPermission?: Record<string, unknown>,
): Record<string, PermissionRule> {
  const config: Record<string, PermissionRule> = {}

  // Subagents deny unlisted tools by default
  if (mode === "subagent") {
    config["*"] = "deny"
    config.question = "deny"
    config.doom_loop = "deny"
  }

  for (const tool of tools) {
    const key = toolPermissionMap[tool]
    if (key) config[key] = "allow"
  }

  if (extraPermission) Object.assign(config, extraPermission)
  return config
}

export * as ProfileTypes from "./types"
