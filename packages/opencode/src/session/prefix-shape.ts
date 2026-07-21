import crypto from "crypto"
import type { SessionID } from "./schema"

// 260721 Red Prefix Shape Diagnostic
// Captures system prompt + tool schema hashes before each API call,
// compares with the previous turn, and reports the reason if the
// provider-cache prefix changed (system / tools). Modeled after
// Reasonix's cache_shape.go — purely diagnostic, zero behavioral impact.

export interface PrefixShape {
  systemHash: string
  toolsHash: string
}

export interface PrefixDiagnostic {
  changed: boolean
  reasons: string[] // "system" | "tools"
}

const pfx = ((globalThis as any).__rc_prefix_shape ??= {
  shape: undefined as { sessionID: string; shape: PrefixShape } | undefined,
})

function hash(data: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 16)
}

export function capture(system: string[], tools: Record<string, unknown>): PrefixShape {
  const sortedKeys = Object.keys(tools).sort()
  const toolDefs = sortedKeys.map((k) => ({ name: k, def: tools[k] }))
  return {
    systemHash: hash(system),
    toolsHash: hash(toolDefs),
  }
}

export function diagnose(shape: PrefixShape, sessionID: SessionID): PrefixDiagnostic {
  const prev = pfx.shape?.sessionID === sessionID ? pfx.shape.shape : undefined
  pfx.shape = { sessionID, shape }

  if (!prev) return { changed: false, reasons: [] }

  const reasons: string[] = []
  if (prev.systemHash !== shape.systemHash) reasons.push("system")
  if (prev.toolsHash !== shape.toolsHash) reasons.push("tools")
  return { changed: reasons.length > 0, reasons }
}

export * as PrefixShape from "./prefix-shape"
