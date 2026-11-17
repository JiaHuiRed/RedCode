import { Database } from "@/storage/db"
import { and, asc, eq, lt, lte, sql } from "drizzle-orm"
import { Schema } from "effect"
import { PositiveInt } from "@redcode-ai/core/schema"
import { SessionChangeTable } from "./changes.sql"
import { SessionTable } from "./session.sql"
import type { MessageID, SessionID } from "./schema"
import { EventSequenceTable } from "@/sync/event.sql"
import { createHash } from "node:crypto"

// 261009 Red 只保留有界失效标记；不复制事件正文，也不重跑投影。
// docs/notes/implemented/feature/2026-10-09-session-change-catchup.md

export const Spec = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  max_events_per_session: Schema.optional(PositiveInt),
  max_total_events: Schema.optional(PositiveInt),
  retention_ms: Schema.optional(PositiveInt),
  page_size: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(256))),
})

export type Spec = typeof Spec.Type
export type Resolved = {
  enabled: boolean
  max_events_per_session: number
  max_total_events: number
  retention_ms: number
  page_size: number
}

export function resolve(input?: Spec): Resolved {
  const result = {
    enabled: input?.enabled ?? true,
    max_events_per_session: input?.max_events_per_session ?? 256,
    max_total_events: input?.max_total_events ?? 10_000,
    retention_ms: input?.retention_ms ?? 24 * 60 * 60 * 1000,
    page_size: input?.page_size ?? 64,
  }
  if (result.page_size > 256) throw new Error("session_changes.page_size must be <= 256")
  return result
}

export function record(input: {
  tx: Database.TxOrDb
  sessionID: string
  seq: number
  id: string
  kind: "session" | "message"
  messageID?: string
  time: number
  config: Resolved
}) {
  if (!input.config.enabled || !boundedID(input.sessionID)) return
  // 261009 Red 已删除会话不复活；无法定位的消息退化为会话快照刷新。
  if (
    !input.tx
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.id, input.sessionID as SessionID))
      .get()
  )
    return
  input.tx
    .insert(SessionChangeTable)
    .values({
      session_id: input.sessionID as SessionID,
      seq: input.seq,
      id: boundedID(input.id) ? input.id : createHash("sha256").update(input.id).digest("hex"),
      kind: input.messageID && !boundedID(input.messageID) ? "session" : input.kind,
      message_id: input.messageID && boundedID(input.messageID) ? (input.messageID as MessageID) : undefined,
      time_created: input.time,
    })
    .onConflictDoNothing()
    .run()
  input.tx
    .delete(SessionChangeTable)
    .where(
      and(
        eq(SessionChangeTable.session_id, input.sessionID as SessionID),
        sql`${SessionChangeTable.seq} NOT IN (
          SELECT seq FROM ${SessionChangeTable}
          WHERE session_id = ${input.sessionID}
          ORDER BY seq DESC LIMIT ${input.config.max_events_per_session}
        )`,
      ),
    )
    .run()
  input.tx
    .delete(SessionChangeTable)
    .where(lt(SessionChangeTable.time_created, input.time - input.config.retention_ms))
    .run()
  input.tx
    .delete(SessionChangeTable)
    .where(
      sql`(${SessionChangeTable.session_id}, ${SessionChangeTable.seq}) IN (
        SELECT session_id, seq FROM ${SessionChangeTable}
        ORDER BY time_created DESC, id DESC, session_id DESC, seq DESC
        LIMIT -1 OFFSET ${input.config.max_total_events}
      )`,
    )
    .run()
}

export function page(input: {
  sessionID: SessionID
  after: number
  until?: number
  limit: number
  now: number
  config: Resolved
}) {
  return Database.transaction((tx) => {
    const latest =
      tx
        .select({ seq: EventSequenceTable.seq })
        .from(EventSequenceTable)
        .where(eq(EventSequenceTable.aggregate_id, input.sessionID))
        .get()?.seq ?? -1
    const oldestRow = tx
      .select({ seq: SessionChangeTable.seq, time: SessionChangeTable.time_created })
      .from(SessionChangeTable)
      .where(
        and(
          eq(SessionChangeTable.session_id, input.sessionID),
          sql`${SessionChangeTable.time_created} >= ${input.now - input.config.retention_ms}`,
        ),
      )
      .orderBy(asc(SessionChangeTable.seq))
      .limit(1)
      .get()
    const oldest = oldestRow?.seq ?? null
    const target = Math.min(input.until ?? latest, latest)
    const reset =
      !input.config.enabled ||
      input.after > latest ||
      input.after > target ||
      (oldest !== null && input.after < oldest - 1) ||
      (oldest === null && target > input.after)
    if (reset) return { latest, oldest, cursor: target, hasMore: false, reset: true, changes: [] }
    const rows = tx
      .select({
        id: SessionChangeTable.id,
        seq: SessionChangeTable.seq,
        kind: SessionChangeTable.kind,
        messageID: SessionChangeTable.message_id,
      })
      .from(SessionChangeTable)
      .where(
        and(
          eq(SessionChangeTable.session_id, input.sessionID),
          sql`${SessionChangeTable.seq} > ${input.after}`,
          lte(SessionChangeTable.seq, target),
          sql`${SessionChangeTable.time_created} >= ${input.now - input.config.retention_ms}`,
        ),
      )
      .orderBy(asc(SessionChangeTable.seq))
      .limit(Math.min(input.limit, input.config.page_size) + 1)
      .all()
    // 261009 Red 关闭后重开、时间回拨或全局裁剪都可能留下内部缺口；不能假装补齐。
    if (
      rows.some((row, index) => row.seq !== (index === 0 ? input.after : rows[index - 1].seq) + 1) ||
      (rows.length <= Math.min(input.limit, input.config.page_size) && (rows.at(-1)?.seq ?? input.after) < target)
    )
      return { latest, oldest, cursor: target, hasMore: false, reset: true, changes: [] }
    const changes = rows.slice(0, Math.min(input.limit, input.config.page_size)).map((row) => ({
      id: row.id,
      seq: row.seq,
      kind: row.kind as "session" | "message",
      ...(row.messageID ? { messageID: row.messageID } : {}),
    }))
    const cursor = changes.at(-1)?.seq ?? input.after
    return {
      latest,
      oldest,
      cursor,
      hasMore: rows.length > changes.length && cursor < target,
      reset: false,
      changes,
    }
  })
}

function boundedID(value: string) {
  return value.length > 0 && value.length <= 256 && [...value].length <= 128 && Buffer.byteLength(value, "utf8") <= 512
}

export * as SessionChanges from "./changes"
