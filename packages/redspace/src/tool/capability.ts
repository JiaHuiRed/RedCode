export const ChildCapability = {
  read: "read",
  search: "search",
  write: "write",
  shell: "shell",
  task: "task",
  commit: "commit",
  push: "push",
} as const

export type ChildCapability = (typeof ChildCapability)[keyof typeof ChildCapability]

export type ChildProfile = "explore" | "execute"

const profileCapabilities: Record<ChildProfile, ReadonlySet<ChildCapability>> = {
  // 261011 Red explore 含 shell：bash 工具靠 capabilitySet 注入工具表（session/tools.ts），
  // 这里不给 shell，explore.md 的 git 只读白名单写得再全也到不了模型——B1 落地时只通了
  // md 白名单与 permission guard 两层，capability 层漏加即假门票二犯（443c92b1 一犯）。
  // 命令面仍由白名单 + guard 收口，本层只是粗粒度开关。
  explore: new Set(["read", "search", "shell"]),
  execute: new Set(["read", "search", "write", "shell"]),
}

export function capabilitySet(values: Iterable<ChildCapability>): Set<ChildCapability> {
  return new Set(values)
}

export function profileCapabilitySet(profile: ChildProfile): ReadonlySet<ChildCapability> {
  return profileCapabilities[profile]
}

export function effectiveCapabilities(input: {
  parent: ReadonlySet<ChildCapability>
  profile: ChildProfile
  requested: ReadonlySet<ChildCapability>
  hardDeny?: ReadonlySet<ChildCapability>
}): ReadonlySet<ChildCapability> {
  const profileAllowed = profileCapabilities[input.profile]
  const hardDeny = input.hardDeny ?? new Set<ChildCapability>()
  return new Set(
    [...input.requested].filter(
      (capability) => input.parent.has(capability) && profileAllowed.has(capability) && !hardDeny.has(capability),
    ),
  )
}

export function isCapabilityAllowed(capabilities: ReadonlySet<ChildCapability>, capability: ChildCapability): boolean {
  return capabilities.has(capability)
}

export function capabilityForTool(tool: string): ChildCapability | undefined {
  // 261010 Red 管理自己的会话投影不授予仓库写权限。
  if (["read", "context_read", "compress", "context_restore"].includes(tool)) return "read"
  if (
    ["grep", "glob", "list", "webfetch", "websearch", "context_search"].includes(tool) ||
    tool.startsWith("jcodemunch_") ||
    tool.startsWith("typegraph_") ||
    tool.startsWith("indexgraph_") ||
    tool.startsWith("web-search_")
  )
    return "search"
  if (["edit", "write", "apply_patch"].includes(tool)) return "write"
  if (tool === "bash") return "shell"
  if (tool === "task") return "task"
  if (tool === "commit") return "commit"
  if (tool === "push") return "push"
  return undefined
}

export function capabilityDenied(profile: ChildProfile, tool: string): string | undefined {
  const capability = capabilityForTool(tool)
  if (capability && isCapabilityAllowed(new Set(profileCapabilities[profile]), capability)) return undefined
  return `Tool "${tool}" is not available to the ${profile} child profile.`
}

export function capabilityDeniedForSet(capabilities: ReadonlySet<ChildCapability>, tool: string): string | undefined {
  const capability = capabilityForTool(tool)
  if (capability && isCapabilityAllowed(capabilities, capability)) return undefined
  return `Tool "${tool}" is not available to the child capability set.`
}
