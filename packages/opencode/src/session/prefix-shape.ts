import crypto from "crypto"
import type { SessionID } from "./schema"
import { Token } from "@/util/token"

// 260721 Red Prefix Shape Diagnostic
// Captures system prompt + tool schema hashes before each API call,
// compares with the previous turn, and reports the reason if the
// provider-cache prefix changed (system / tools). Modeled after
// Reasonix's cache_shape.go — purely diagnostic, zero behavioral impact.

export interface PrefixShape {
  systemHash: string
  toolsHash: string
  // 260729 Red 前缀里工具 schema 占的估算 token 数。它每轮都要付，而且是 prefix cache
  // 的一部分——某个 MCP server 挂上来就可能悄悄吃掉几千 token，之前完全不可见。
  toolSchemaTokens: number
  toolCount: number
}

export interface PrefixDiagnostic {
  changed: boolean
  reasons: string[] // "system" | "tools"
  toolSchemaTokens: number
  toolCount: number
  /** tools 变化时给出的最贵几个工具，便于一眼看出是谁在吃前缀预算 */
  topCosts?: ToolSchemaCost[]
}

export interface ToolSchemaCost {
  name: string
  tokens: number
}

/**
 * 逐工具估算 schema 的 token 成本，从贵到便宜排序。取自 Reasonix 的 SchemaTokenCosts。
 * 纯诊断用途，不参与任何判定。
 */
export function schemaCosts(tools: Record<string, unknown>): ToolSchemaCost[] {
  return Object.keys(tools)
    .map((name) => ({ name, tokens: Token.estimate(JSON.stringify({ name, def: tools[name] }) ?? "") }))
    .sort((a, b) => b.tokens - a.tokens)
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
    toolSchemaTokens: Token.estimate(JSON.stringify(toolDefs) ?? ""),
    toolCount: sortedKeys.length,
  }
}

const TOP_COSTS = 5

export function diagnose(
  shape: PrefixShape,
  sessionID: SessionID,
  tools?: Record<string, unknown>,
): PrefixDiagnostic {
  const prev = pfx.shape?.sessionID === sessionID ? pfx.shape.shape : undefined
  pfx.shape = { sessionID, shape }

  const base = { toolSchemaTokens: shape.toolSchemaTokens, toolCount: shape.toolCount }
  if (!prev) return { changed: false, reasons: [], ...base }

  const reasons: string[] = []
  if (prev.systemHash !== shape.systemHash) reasons.push("system")
  if (prev.toolsHash !== shape.toolsHash) reasons.push("tools")
  // 只在 tools 真的变了时才算逐工具成本 —— 这一步要序列化全部 schema，不必每轮都做
  const topCosts = reasons.includes("tools") && tools ? schemaCosts(tools).slice(0, TOP_COSTS) : undefined
  return { changed: reasons.length > 0, reasons, ...base, ...(topCosts ? { topCosts } : {}) }
}

export * as PrefixShape from "./prefix-shape"
