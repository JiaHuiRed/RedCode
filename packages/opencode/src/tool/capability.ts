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
  explore: new Set(["read", "search"]),
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
  if (tool === "read") return "read"
  if (
    ["grep", "glob", "list", "webfetch", "websearch"].includes(tool) ||
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
