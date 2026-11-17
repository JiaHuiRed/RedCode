import { createHash } from "node:crypto"
import { MessageV2 } from "./message-v2"
import * as Ledger from "./context-compaction"
import type { SessionID } from "./schema"

// 261010 Red 旧 DCP 状态导入：只认当前持久化格式（persistence.ts 的 PersistedSessionState），
// 只导活跃块，范围端点必须能在目标会话原始消息中证实；歧义/版本不匹配/缺源一律显式拒绝，
// 不静默跳过。原始消息与 DCP 状态文件本身零写入。决策：docs/notes/implemented/feature/2026-10-10-native-compaction.md。

interface DecodedDcpBlock {
  blockId: number
  active: boolean
  startId: string
  endId: string
  anchorMessageId: string
  summary: string
  topic: string
}

interface DecodedDcp {
  activeBlockIds: number[]
  blocksById: Map<number, DecodedDcpBlock>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`DCP state field ${field} must be a non-empty string`)
  return value
}

function decodeBlock(key: string, value: unknown): DecodedDcpBlock {
  if (!isRecord(value)) throw new Error(`DCP block ${key} is not an object`)
  const blockId = Number(key)
  if (!Number.isSafeInteger(blockId) || blockId <= 0) throw new Error(`DCP block key ${key} is not a positive integer`)
  if (typeof value.active !== "boolean") throw new Error(`DCP block ${key} has no boolean active flag`)
  const ids = value.effectiveMessageIds
  if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")))
    throw new Error(`DCP block ${key} has malformed effectiveMessageIds`)
  return {
    blockId,
    active: value.active,
    startId: string(value.startId, `blocksById.${key}.startId`),
    endId: string(value.endId, `blocksById.${key}.endId`),
    anchorMessageId: string(value.anchorMessageId, `blocksById.${key}.anchorMessageId`),
    summary: string(value.summary, `blocksById.${key}.summary`),
    topic: typeof value.topic === "string" ? value.topic : "",
  }
}

export function decodeDcpState(state: unknown): DecodedDcp {
  if (!isRecord(state)) throw new Error("DCP state is not an object")
  const prune = state.prune
  if (!isRecord(prune) || !isRecord(prune.messages))
    throw new Error("DCP state predates message compression (legacy format); nothing to import")
  const blocksById = prune.messages.blocksById
  const activeBlockIds = prune.messages.activeBlockIds
  if (!isRecord(blocksById)) throw new Error("DCP state has no blocksById record")
  if (!Array.isArray(activeBlockIds) || activeBlockIds.some((id) => !Number.isSafeInteger(id)))
    throw new Error("DCP state has a malformed activeBlockIds array")
  const blocks = new Map<number, DecodedDcpBlock>()
  for (const [key, value] of Object.entries(blocksById)) blocks.set(Number(key), decodeBlock(key, value))
  const active = activeBlockIds as number[]
  for (const id of active) {
    const block = blocks.get(id)
    if (!block) throw new Error(`DCP active block ${id} is missing from blocksById`)
    if (!block.active) throw new Error(`DCP block ${id} is listed active but flagged inactive; state is ambiguous`)
  }
  const listed = new Set(active)
  for (const [id, block] of blocks) {
    if (block.active && !listed.has(id))
      throw new Error(`DCP block ${id} is flagged active but missing from activeBlockIds; state is ambiguous`)
  }
  return { activeBlockIds: active, blocksById: blocks }
}

function fingerprint(state: DecodedDcp) {
  const canonical = state.activeBlockIds.toSorted((a, b) => a - b).map((id) => {
    const block = state.blocksById.get(id)!
    return { blockId: block.blockId, startId: block.startId, endId: block.endId, summary: block.summary, topic: block.topic }
  })
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
}

export interface ImportResult {
  requestID: string
  blocks: Ledger.Block[]
  imported: number
  skipped: number
}

export function importDcp(sessionID: SessionID, state: unknown, limits: Ledger.Limits): ImportResult {
  const decoded = decodeDcpState(state)
  const active = decoded.activeBlockIds.map((id) => decoded.blocksById.get(id)!)
  const requestID = `import:dcp:${fingerprint(decoded)}`
  const existing = Ledger.list(sessionID)
  if (existing.length && existing.some((block) => block.requestID !== requestID))
    throw new Error("Native compaction ledger already owns this session; refusing to merge an import")
  if (existing.length)
    return { requestID, blocks: existing, imported: 0, skipped: decoded.blocksById.size - active.length }
  if (!active.length) throw new Error("DCP state has no active blocks to import")
  if (active.length > limits.maxRanges) throw new Error("DCP import exceeds the configured range budget")

  // stream() 是逆序，Ordered 转回正序并应用既有 legacy 压缩边界；导入范围必须落在
  // 当前可见历史内，端点在此之前的原始消息按「陈旧端点」拒绝。
  const messages = MessageV2.filterCompactedOrdered(MessageV2.stream(sessionID))
  const known = new Set(messages.map((message) => message.info.id))
  for (const block of active) {
    const referenced = [block.startId, block.endId, block.anchorMessageId]
    const missing = referenced.filter((id) => !known.has(id as never))
    if (missing.length)
      throw new Error(`DCP block ${block.blockId} references messages missing from this session: ${missing.join(", ")}`)
  }
  const blocks = Ledger.commit({
    sessionID,
    messages,
    limits,
    mode: "import",
    requestID,
    ranges: active.map((block) => ({ startId: block.startId, endId: block.endId, summary: block.summary, topic: block.topic })),
  })
  return { requestID, blocks, imported: blocks.length, skipped: decoded.blocksById.size - active.length }
}

export * as ContextImport from "./context-import"
