import crypto from "crypto"
import type { SessionID } from "./schema"
import { Token } from "@/util/token"
import { MAX_SESSIONS, SESSION_TTL_MS, sessionEvictor } from "@/util/session-evictor"

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

// 260819 cc audit：原来是**全局单槽** `{ sessionID, shape }`，两个毛病，跟 5670d86 在
// 前缀探针那边刚修掉的是同一对：
//
//   1) 不带 modelKey。system 提示词本来就按模型分发（system.ts 是 15 分支的
//      BEAST/CODEX/GEMINI/ANTHROPIC/DEEPSEEK/QWEN/GLM… 路由，_caches.system 也按
//      modelKey 分桶），同会话切模型 systemHash 必变 → 每次切模型报一次假的
//      「prefix cache changed: system」。
//   2) 单槽被并发会话/子代理互顶。子代理跑的是独立 sessionID、走同一套 runLoop，
//      主会话与子代理交替 diagnose 时 prev 恒取不到 → 该报的不报（漏报比误报更难发现）。
//
// 改成按 `sessionID|modelKey` 分桶的 Map，并接上与 prompt-caches/file-time 同一套回收
// （纯诊断状态，每条只有两个短 hash + 两个数，回收代价为零，接上只为不再无界）。
const pfx = ((globalThis as any).__rc_prefix_shape ??= {
  shapes: new Map<string, PrefixShape>(),
}) as { shapes: Map<string, PrefixShape> }

const evictor = sessionEvictor({
  ttlMs: SESSION_TTL_MS,
  max: MAX_SESSIONS,
  drop: (key) => (pfx.shapes.delete(key) ? 1 : 0),
})

/** 测试钩子：清空进程内指纹，避免用例之间互相污染 */
export function reset() {
  pfx.shapes.clear()
  evictor.clear()
}

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
  /** providerID/modelID —— 与 _caches.system 的分桶键同粒度，见上面 pfx 的注释 */
  modelKey: string,
  tools?: Record<string, unknown>,
): PrefixDiagnostic {
  const key = `${sessionID}|${modelKey}`
  const prev = pfx.shapes.get(key)
  pfx.shapes.set(key, shape)
  evictor.touch(key)

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
