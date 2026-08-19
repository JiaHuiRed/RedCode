import type { RawProfile, ResolvedProfile } from "./types"
import { ProfileTypes } from "./types"

/** Resolve raw profiles into merged profiles. Handles extends inheritance. */
export function resolve(raw: Map<string, RawProfile>): Map<string, ResolvedProfile> {
  const cache = new Map<string, ResolvedProfile>()
  const visiting = new Set<string>()

  for (const name of raw.keys()) {
    resolveOne(name, raw, cache, visiting)
  }

  return cache
}

function resolveOne(
  name: string,
  raw: Map<string, RawProfile>,
  cache: Map<string, ResolvedProfile>,
  visiting: Set<string>,
): ResolvedProfile {
  const cached = cache.get(name)
  if (cached) return cached

  const profile = raw.get(name)
  if (!profile) throw new Error(`YAML profile "${name}" extends unknown profile`)

  // Cycle detection
  if (visiting.has(name)) throw new Error(`Circular extends in YAML profile: ${name}`)
  visiting.add(name)

  let result: ResolvedProfile

  if (profile.extends) {
    const parent = resolveOne(profile.extends, raw, cache, visiting)
    result = merge(parent, profile)
  } else {
    result = {
      name: profile.name,
      description: profile.description,
      prompt: profile.prompt,
      mode: profile.mode ?? "all",
      tools: [...(profile.tools ?? [])],
      permission: profile.permission as Record<string, unknown> | undefined,
    }
  }

  visiting.delete(name)
  cache.set(name, result)
  return result
}

function merge(parent: ResolvedProfile, child: RawProfile): ResolvedProfile {
  return {
    name: child.name,
    description: child.description ?? parent.description,
    prompt: child.prompt ?? parent.prompt,
    mode: child.mode ?? parent.mode,
    tools: [...(child.tools ?? parent.tools)],
    permission: (child.permission as Record<string, unknown> | undefined) ?? parent.permission,
  }
}

export * as ProfileResolve from "./resolve"
