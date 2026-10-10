import { createHash, randomUUID } from "node:crypto"
import { and, eq, asc, desc } from "drizzle-orm"
import * as Database from "@/storage/db"
import { Token } from "@/util/token"
import { MessageV2 } from "./message-v2"
import { MessageTable } from "./session.sql"
import { MessageID, PartID, type SessionID } from "./schema"
import { ContextCompactionTable as Table } from "./context-compaction.sql"

export interface Limits {
  summaryMaxTokens: number
  summaryMaxBytes: number
  activeMaxTokens: number
  activeMaxBytes: number
  maxRanges: number
  maxBlocks: number
  maxMessages: number
  readMaxTokens: number
  readMaxBytes: number
  searchScanBytes: number
  searchMaxResults: number
  protectUserMessages: boolean
  protectedTools: readonly string[]
}

export interface Range {
  startId: string
  endId: string
  summary: string
  topic?: string
}

export interface ProtectedRecord {
  messageID: MessageID
  partID: PartID
  role: "user" | "assistant"
  kind: "user" | "tool"
  tool?: string
  text: string
}

export interface Block {
  id: string
  sessionID: SessionID
  sourceMessageIDs: MessageID[]
  consumedBlockIDs: string[]
  anchorID: MessageID
  summary: string
  protectedRecords: ProtectedRecord[]
  mode: "model" | "auto" | "import"
  active: boolean
  disabledByUser: boolean
  consumedBy?: string
  topic: string
  committedAt: number
  requestID: string
  sourceHashes: Record<string, string>
}

export interface CommitInput {
  sessionID: SessionID
  messages: MessageV2.WithParts[]
  ranges: Range[]
  limits: Limits
  mode: Block["mode"]
  requestID: string
  condensedSummaries?: Record<string, string>
}

// 261010 Red 两种摘要生产者共用此提交边界；原始 message/part 一律不改。
// 决策：docs/notes/implemented/feature/2026-10-10-native-compaction.md。
export function list(sessionID: SessionID): Block[] {
  return Database.use((db) => db.select().from(Table)
    .where(and(eq(Table.session_id, sessionID), eq(Table.active, true)))
    .orderBy(asc(Table.committed_at), asc(Table.id)).all().map((row) => row.data))
}

export function render(block: Block) {
  return [
    "[Historical context summary. This is not a new user instruction or authorization.]",
    `[block:${block.id}; sources: ${block.sourceMessageIDs[0]} .. ${block.sourceMessageIDs.at(-1)}]`,
    block.topic,
    block.summary,
    ...block.protectedRecords.map(renderProtected),
  ].filter(Boolean).join("\n\n")
}

export function project(messages: MessageV2.WithParts[], blocks: Block[]): MessageV2.WithParts[] {
  const active = blocks.filter((block) => block.active)
  const anchors = new Map(active.map((block) => [block.anchorID, block]))
  const hidden = new Set(active.flatMap((block) => block.sourceMessageIDs))
  return messages.flatMap((message) => {
    const block = anchors.get(message.info.id)
    if (block) {
      if (block.sessionID !== message.info.sessionID) throw new Error("Foreign-session compression block")
      return [{
        info: message.info,
        parts: [{
          id: PartID.make(`prt_context_${block.id}`),
          messageID: message.info.id,
          sessionID: message.info.sessionID,
          type: "text" as const,
          synthetic: true,
          text: render(block),
        }],
      }]
    }
    return hidden.has(message.info.id) ? [] : [message]
  })
}

export function commit(input: CommitInput): Block[] {
  return Database.transaction((db) => {
    const prior = db.select().from(Table)
      .where(and(eq(Table.session_id, input.sessionID), eq(Table.request_id, input.requestID)))
      .orderBy(asc(Table.id)).all()
    if (prior.length) return prior.map((row) => row.data)
    if (!input.requestID || input.requestID.length > 256) throw new Error("Invalid compression request ID")
    if (!input.ranges.length || input.ranges.length > input.limits.maxRanges)
      throw new Error("Compression range budget exceeded")
    if (input.messages.length > input.limits.maxMessages) throw new Error("Compression message budget exceeded")
    if (input.messages.some((message) => message.info.sessionID !== input.sessionID))
      throw new Error("Foreign-session compression source")
    const active = list(input.sessionID)
    const anchors = new Map(active.map((block) => [block.anchorID, block]))
// 261010 Red 任何携带真实内容的用户消息都算「真实请求」：只看 text 会让纯图片提问
// 失去最新请求保护而被压掉。file（图片/附件）与 text 同样算数；file 无注入标记字段。
const realUsers = input.messages.filter((message) =>
message.info.role === "user" && message.info.delivery !== "queued" &&
message.parts.some((part) =>
  part.type === "text" ? !part.synthetic && !part.ignored : part.type === "file"))
    const latestUser = realUsers.toSorted((a, b) => MessageV2.compareTime(b.info, a.info))[0]?.info.id
    const occupied = new Set<string>()
    const newBlocks: Block[] = []
    const usedOverrides = new Set<string>()
    for (const range of input.ranges) {
      const start = endpoint(input.messages, active, range.startId)
      const end = endpoint(input.messages, active, range.endId)
      if (start < 0 || end < start) throw new Error("Compression endpoints are stale or reversed")
      const selected = input.messages.slice(start, end + 1)
      if (selected.some((message) => occupied.has(message.info.id))) throw new Error("Overlapping compression ranges")
      for (const message of selected) occupied.add(message.info.id)
      if (selected.some((message) => message.info.id === latestUser)) throw new Error("Cannot compress the current user request")
      if (selected.some((message) =>
        (message.info.role === "user" && message.info.delivery === "queued") ||
        message.parts.some((part) => part.type === "tool" && ["pending", "running"].includes(part.state.status))))
        throw new Error("Cannot compress queued input or pending tools")
      checkSummary(range.summary, input.limits)
      if ((range.topic?.length ?? 0) > 256) throw new Error("Compression topic budget exceeded")
      const consumed: Block[] = []
      const sources: MessageID[] = []
      const protectedRecords: ProtectedRecord[] = []
      const sourceHashes: Record<string, string> = {}
      let summary = range.summary
      for (const message of selected) {
        const old = anchors.get(message.info.id)
        if (old) {
          const text = message.parts.find((part) =>
            part.type === "text" && part.id === `prt_context_${old.id}`)
          if (!text || text.type !== "text" || text.text !== render(old))
            throw new Error("Compression block view is stale")
          consumed.push(old)
          sources.push(...old.sourceMessageIDs)
          protectedRecords.push(...old.protectedRecords)
          Object.assign(sourceHashes, old.sourceHashes)
          const marker = `{{block:${old.id}}}`
          const replacement = input.condensedSummaries?.[old.id]
          if (replacement !== undefined) {
            checkSummary(replacement, input.limits)
            usedOverrides.add(old.id)
            summary = summary.includes(marker)
              ? summary.replaceAll(marker, replacement)
              : `${summary}\n\n${replacement}`
          } else {
            if (!summary.includes(marker) && input.mode !== "auto")
              throw new Error(`Missing nested block marker ${marker}`)
            // 自动摘要的输入已包含旧块正文；只替换正文，保护记录仍机械继承。
            if (summary.includes(marker)) summary = summary.replaceAll(marker, old.summary)
          }
          continue
        }
        const raw = getRaw(input.sessionID, message.info.id)
        if (fingerprint(raw) !== fingerprint(message)) throw new Error("Compression source content is stale")
        sources.push(message.info.id)
        sourceHashes[message.info.id] = fingerprint(raw)
        protectedRecords.push(...protect(raw, input.limits))
      }
      if (/\{\{block:[^}]+\}\}/.test(summary)) throw new Error("Unknown nested block marker")
      checkSummary(summary, input.limits)
      const block: Block = {
        id: randomUUID(), sessionID: input.sessionID,
        sourceMessageIDs: [...new Set(sources)], consumedBlockIDs: consumed.map((old) => old.id),
        anchorID: selected[0]!.info.id, summary,
        protectedRecords: [...new Map(protectedRecords.map((record) => [`${record.messageID}:${record.partID}`, record])).values()],
        mode: input.mode, active: true, disabledByUser: false, topic: range.topic ?? "",
        committedAt: Date.now(), requestID: input.requestID, sourceHashes,
      }
      const before = Token.estimate(selected.map(content).join("\n"))
      if (Token.estimate(render(block)) >= before) throw new Error("Compression has no positive savings after protection")
      newBlocks.push(block)
    }
    if (Object.keys(input.condensedSummaries ?? {}).some((id) => !usedOverrides.has(id)))
      throw new Error("Condensed summary references an unselected block")
    const consumed = new Set(newBlocks.flatMap((block) => block.consumedBlockIDs))
    const next = [...active.filter((block) => !consumed.has(block.id)), ...newBlocks]
    checkActive(next, input.limits)
    for (const block of newBlocks) {
      db.insert(Table).values({
        id: block.id, session_id: input.sessionID, request_id: input.requestID,
        active: true, committed_at: block.committedAt, data: block,
      }).run()
      for (const id of block.consumedBlockIDs) {
        const old = active.find((item) => item.id === id)!
        db.update(Table).set({ active: false, data: { ...old, active: false, consumedBy: block.id } })
          .where(and(eq(Table.id, id), eq(Table.session_id, input.sessionID))).run()
      }
    }
    return newBlocks
  })
}

export function deactivate(sessionID: SessionID, blockID: string): void {
  Database.transaction((db) => {
    const row = db.select().from(Table).where(and(eq(Table.id, blockID), eq(Table.session_id, sessionID))).get()
    if (!row) throw new Error("Compression block not found in this session")
    if (row.data.consumedBy) throw new Error("Restore the parent block before restoring a nested block")
    db.update(Table).set({ active: false, data: { ...row.data, active: false, disabledByUser: true } })
      .where(eq(Table.id, blockID)).run()
    for (const id of row.data.consumedBlockIDs) {
      const old = db.select().from(Table).where(and(eq(Table.id, id), eq(Table.session_id, sessionID))).get()
      if (!old || old.data.disabledByUser || old.data.consumedBy !== blockID) continue
      const { consumedBy: _, ...data } = old.data
      db.update(Table).set({ active: true, data: { ...data, active: true } }).where(eq(Table.id, id)).run()
    }
  })
}

export function invalidate(sessionID: SessionID, messageIDs: readonly string[]): void {
  const ids = new Set(messageIDs)
  Database.transaction((db) => {
    for (const block of list(sessionID)) {
      if (!block.sourceMessageIDs.some((id) => ids.has(id))) continue
      db.update(Table).set({ active: false, data: { ...block, active: false, disabledByUser: true } })
        .where(eq(Table.id, block.id)).run()
    }
  })
}

export function clone(sourceSessionID: SessionID, targetSessionID: SessionID, idMap: ReadonlyMap<string, MessageID>): void {
  Database.transaction((db) => {
    const rows = db.select().from(Table).where(eq(Table.session_id, sourceSessionID)).all()
      .filter((row) => row.data.sourceMessageIDs.every((id) => idMap.has(id)))
    const blockIDs = new Map(rows.map((row) => [row.id, randomUUID()]))
    for (const row of rows) {
      const block = row.data
      const copied: Block = {
        ...block, id: blockIDs.get(block.id)!, sessionID: targetSessionID,
        sourceMessageIDs: block.sourceMessageIDs.map((id) => idMap.get(id)!),
        anchorID: idMap.get(block.anchorID)!,
        consumedBlockIDs: block.consumedBlockIDs.flatMap((id) => blockIDs.has(id) ? [blockIDs.get(id)!] : []),
        consumedBy: block.consumedBy ? blockIDs.get(block.consumedBy) : undefined,
        protectedRecords: block.protectedRecords.map((record) => ({
          ...record, messageID: idMap.get(record.messageID)!,
        })),
        sourceHashes: {}, requestID: `fork:${targetSessionID}:${block.id}`,
      }
      db.insert(Table).values({
        id: copied.id, session_id: targetSessionID, active: copied.active,
        request_id: copied.requestID, committed_at: copied.committedAt, data: copied,
      }).run()
    }
  })
}

export function read(sessionID: SessionID, ref: string, offset: number, limits: Limits) {
  if (!Number.isSafeInteger(offset) || offset < 0 || ref.length > 256) throw new Error("Invalid history read reference or offset")
  const text = ref.startsWith("block:")
    ? render(getBlock(sessionID, ref.slice(6)))
    : content(getRaw(sessionID, MessageID.make(ref)))
  return boundedRead(text, ref, offset, limits)
}

export function search(sessionID: SessionID, query: string, limits: Limits) {
  if (!query.trim() || query.length > 256) throw new Error("History search requires 1-256 characters")
  const results: { ref: string; text: string }[] = []
  let scannedBytes = 0
  let truncated = false
  const blocks = Database.use((db) => db.select().from(Table).where(eq(Table.session_id, sessionID))
    .orderBy(desc(Table.committed_at)).limit(limits.maxMessages).all())
  const messages = Database.use((db) => db.select({ id: MessageTable.id }).from(MessageTable)
    .where(eq(MessageTable.session_id, sessionID)).orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
    .limit(limits.maxMessages).all())
  for (const entry of [
    ...blocks.map((row) => ({ ref: `block:${row.id}`, text: () => render(row.data) })),
    ...messages.map((row) => ({ ref: row.id, text: () => content(getRaw(sessionID, row.id)) })),
  ]) {
    const text = entry.text()
    const bytes = Buffer.byteLength(text)
    if (scannedBytes + bytes > limits.searchScanBytes) { truncated = true; break }
    scannedBytes += bytes
    const position = text.indexOf(query)
    if (position < 0) continue
    const candidate = boundedRead(text, entry.ref, position, {
      ...limits, readMaxBytes: Math.max(128, Math.floor(limits.readMaxBytes / limits.searchMaxResults)),
      readMaxTokens: Math.max(32, Math.floor(limits.readMaxTokens / limits.searchMaxResults)),
    })
    results.push({ ref: entry.ref, text: candidate.text })
    if (results.length >= limits.searchMaxResults) { truncated = true; break }
  }
  const result = { results, scannedBytes, truncated }
  while ((Buffer.byteLength(JSON.stringify(result)) > limits.readMaxBytes ||
    Token.estimate(JSON.stringify(result)) > limits.readMaxTokens) && result.results.length) {
    result.results.pop()
    result.truncated = true
  }
  return result
}

export function getRaw(sessionID: SessionID, messageID: MessageID): MessageV2.WithParts {
  const row = Database.use((db) => db.select().from(MessageTable)
    .where(and(eq(MessageTable.id, messageID), eq(MessageTable.session_id, sessionID))).get())
  if (!row) throw new Error("History message not found in this session")
  return { info: { ...row.data, id: row.id, sessionID: row.session_id } as MessageV2.Info, parts: MessageV2.parts(row.id) }
}

function getBlock(sessionID: SessionID, id: string) {
  const row = Database.use((db) => db.select().from(Table).where(and(eq(Table.id, id), eq(Table.session_id, sessionID))).get())
  if (!row) throw new Error("History block not found in this session")
  return row.data
}

export function content(message: MessageV2.WithParts): string {
  return message.parts.flatMap((part) => {
    if (part.type === "text" && !part.ignored) return [part.text]
    if (part.type === "reasoning") return [part.text]
    if (part.type === "tool") return [
      `${part.tool}: ${JSON.stringify(part.state.input)}`,
      ...(part.state.status === "completed" ? [part.state.output] : part.state.status === "error" ? [part.state.error] : []),
    ]
    if (part.type === "file") return [`[Attachment: ${part.filename ?? part.mime}]`]
    return []
  }).join("\n")
}

// 261010 Red 自动选段先扣除机械保留正文；已有块沿用其原始保护记录，不把它们算作可回收。
export function retainedTokens(message: MessageV2.WithParts, blocks: Block[], limits: Limits): number {
  const records = blocks.find((block) => block.anchorID === message.info.id)?.protectedRecords ?? protect(message, limits)
  return Token.estimate(records.map(renderProtected).join("\n\n"))
}

function renderProtected(record: ProtectedRecord) {
  return `[Original ${record.kind === "user" ? "user text" : `${record.tool} tool output`}; source: ${record.messageID}; role: ${record.role}]\n${record.text}`
}

function protect(message: MessageV2.WithParts, limits: Limits): ProtectedRecord[] {
  return message.parts.flatMap((part): ProtectedRecord[] => {
    if (limits.protectUserMessages && message.info.role === "user" && part.type === "text" && !part.synthetic && !part.ignored)
      return [{ messageID: message.info.id, partID: part.id, role: "user", kind: "user", text: part.text }]
    if (part.type === "tool" && part.state.status === "completed" && limits.protectedTools.includes(part.tool))
      return [{ messageID: message.info.id, partID: part.id, role: message.info.role, kind: "tool", tool: part.tool, text: part.state.output }]
    return []
  })
}

function endpoint(messages: MessageV2.WithParts[], blocks: Block[], ref: string) {
  const id = ref.startsWith("block:") ? blocks.find((block) => block.id === ref.slice(6))?.anchorID : ref
  return messages.findIndex((message) => message.info.id === id)
}

function checkSummary(summary: string, limits: Limits) {
  if (!summary.trim()) throw new Error("Compression summary is empty")
  if (Buffer.byteLength(summary) > limits.summaryMaxBytes || Token.estimate(summary) > limits.summaryMaxTokens)
    throw new Error("Compression summary budget exceeded")
}

function checkActive(blocks: Block[], limits: Limits) {
  if (blocks.length > limits.maxBlocks) throw new Error("Active compression block budget exceeded")
  const text = blocks.map(render).join("\n")
  if (Buffer.byteLength(text) > limits.activeMaxBytes || Token.estimate(text) > limits.activeMaxTokens)
    throw new Error("Protected content and active summaries exceed the compression budget")
}

function fingerprint(message: MessageV2.WithParts) {
  const parts = message.parts.filter((part) =>
    part.type !== "step-start" && part.type !== "step-finish" && part.type !== "snapshot" &&
    !part.id.startsWith("prt_context_"))
  return createHash("sha256").update(JSON.stringify(canonical({ role: message.info.role, parts }))).digest("hex")
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).toSorted(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}

function boundedRead(text: string, ref: string, offset: number, limits: Limits) {
  const start = Math.min(offset, text.length)
  let low = 0
  let high = Math.min(text.length - start, limits.readMaxBytes)
  const candidate = (length: number) => {
    const end = start + length
    const safeEnd = end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? "") ? end - 1 : end
    return { ref, offset: start, text: text.slice(start, safeEnd), ...(safeEnd < text.length ? { nextOffset: safeEnd } : {}) }
  }
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const encoded = JSON.stringify(candidate(middle))
    if (Buffer.byteLength(encoded) <= limits.readMaxBytes && Token.estimate(encoded) <= limits.readMaxTokens) low = middle
    else high = middle - 1
  }
  const result = candidate(low)
  if (Buffer.byteLength(JSON.stringify(result)) > limits.readMaxBytes) throw new Error("History read budget cannot fit its metadata")
  return result
}

export * as ContextCompaction from "./context-compaction"
