// 261119 Red Inferred commitments v1：从对话里提取「用户没有明确要求、但值得之后再问一句」
// 的跟进，到期后只在绑定 Chat 的下一条用户消息上带一句提示。提取本身是隐藏的一跳、默认关。
// 规则与边界：docs/notes/proposed/architecture/2026-11-18-qiuqiu-full-migration.md
import { randomUUID } from "node:crypto"
import { and, asc, eq, gt, gte, isNull, lte, or, sql } from "drizzle-orm"
import { Identifier } from "@/id/id"
import * as Database from "@/storage/db"
import { CommitmentTable } from "./commitment.sql"

// 创建后至少过一个心跳量级的静默期才可能到期，避免「刚说完就复述」。
export const MIN_DELAY_MS = 30 * 60 * 1000
export const MAX_PER_DAY = 3
export const MAX_TEXT_BYTES = 512
export const MAX_REASON_BYTES = 512
export const MAX_INJECT_BYTES = 1024
const MAX_CANDIDATES = 3
const DEFAULT_WINDOW_MS = 12 * 60 * 60 * 1000
const CLAIM_LEASE_MS = 30 * 60 * 1000
const CONFIDENCE = { care: 0.75, routine: 0.6 }

const KINDS = new Set(["event_check_in", "deadline_check", "care_check_in", "open_loop"])
const SENSITIVITIES = new Set(["routine", "personal", "care"])
const SOURCES = new Set(["inferred_user_context", "agent_promise"])

export type Kind = "event_check_in" | "deadline_check" | "care_check_in" | "open_loop"
export type Sensitivity = "routine" | "personal" | "care"
export type Source = "inferred_user_context" | "agent_promise"

export type Candidate = {
  kind: Kind
  sensitivity: Sensitivity
  source: Source
  text: string
  reason: string
  dedupeKey: string
  confidence: number
  earliest: string
  latest?: string
}

export type Valid = Candidate & { earliestMs: number; latestMs: number }

export type Claim = { id: string; token: string; text: string; dueAt: number }

export const enabled = () => process.env["REDCODE_EXPERIMENTAL_COMPANION_COMMITMENTS"] === "1"

function truncate(value: string, bytes: number) {
  if (Buffer.byteLength(value) <= bytes) return value
  return Buffer.from(value).subarray(0, bytes).toString("utf8").replace(/\uFFFD+$/, "")
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function asString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function asNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function candidate(raw: unknown): Candidate | undefined {
  const item = asRecord(raw)
  if (!item || item.action === "skip") return undefined
  const kind = asString(item.kind)
  const sensitivity = asString(item.sensitivity)
  const source = asString(item.source) ?? "inferred_user_context"
  const text = asString(item.suggestedText)
  const reason = asString(item.reason)
  const dedupeKey = asString(item.dedupeKey)
  const confidence = asNumber(item.confidence)
  const window = asRecord(item.dueWindow)
  const earliest = asString(window?.earliest)
  const latest = asString(window?.latest)
  if (
    !kind ||
    !KINDS.has(kind) ||
    !sensitivity ||
    !SENSITIVITIES.has(sensitivity) ||
    !SOURCES.has(source) ||
    !text ||
    !reason ||
    !dedupeKey ||
    confidence === undefined ||
    !earliest
  )
    return undefined
  return {
    kind: kind as Kind,
    sensitivity: sensitivity as Sensitivity,
    source: source as Source,
    text: truncate(text, MAX_TEXT_BYTES),
    reason: truncate(reason, MAX_REASON_BYTES),
    dedupeKey: truncate(dedupeKey, 128),
    confidence,
    earliest,
    ...(latest ? { latest } : {}),
  }
}

// 模型偶尔会包一层代码围栏或寒暄；只认带 candidates 数组的 JSON 对象。
export function parse(raw: string): Candidate[] {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
  if (!cleaned) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return []
  }
  const record = asRecord(parsed)
  const list = Array.isArray(record?.candidates) ? record.candidates : []
  return list
    .flatMap((item) => {
      const parsedCandidate = candidate(item)
      return parsedCandidate ? [parsedCandidate] : []
    })
    .slice(0, MAX_CANDIDATES)
}

export function validate(input: { candidates: Candidate[]; nowMs: number }): Valid[] {
  return input.candidates.flatMap((item) => {
    const threshold = item.sensitivity === "care" || item.kind === "care_check_in" ? CONFIDENCE.care : CONFIDENCE.routine
    if (item.confidence < threshold) return []
    const earliest = Date.parse(item.earliest)
    if (!Number.isFinite(earliest) || earliest <= input.nowMs) return []
    const earliestMs = Math.max(earliest, input.nowMs + MIN_DELAY_MS)
    const latestRaw = item.latest ? Date.parse(item.latest) : NaN
    const latestMs = Number.isFinite(latestRaw) && latestRaw >= earliestMs ? latestRaw : earliestMs + DEFAULT_WINDOW_MS
    return [{ ...item, earliestMs, latestMs }]
  })
}

// 同一伙伴内按 dedupeKey 合并：已经 pending 的只把时间窗收窄，不重复堆条目。
export function record(input: { companionID: string; sessionID: string; candidates: Valid[]; nowMs: number }) {
  if (!input.candidates.length) return
  Database.use((db) => {
    for (const item of input.candidates) {
      const existing = db
        .select({ id: CommitmentTable.id, due_at: CommitmentTable.due_at })
        .from(CommitmentTable)
        .where(
          and(
            eq(CommitmentTable.companion_id, input.companionID),
            eq(CommitmentTable.dedupe_key, item.dedupeKey),
            eq(CommitmentTable.status, "pending"),
          ),
        )
        .limit(1)
        .get()
      if (existing) {
        db.update(CommitmentTable)
          .set({
            text: item.text,
            reason: item.reason,
            kind: item.kind,
            source: item.source,
            sensitivity: item.sensitivity,
            due_at: Math.min(existing.due_at, item.earliestMs),
            expires_at: item.latestMs,
            time_updated: input.nowMs,
          })
          .where(
            and(
              eq(CommitmentTable.id, existing.id),
              eq(CommitmentTable.status, "pending"),
              or(isNull(CommitmentTable.claim_until), lte(CommitmentTable.claim_until, input.nowMs)),
            ),
          )
          .run()
        continue
      }
      db.insert(CommitmentTable)
        .values({
          id: Identifier.create("cm", "ascending", input.nowMs),
          companion_id: input.companionID,
          session_id: input.sessionID,
          kind: item.kind,
          source: item.source,
          sensitivity: item.sensitivity,
          text: item.text,
          reason: item.reason,
          dedupe_key: item.dedupeKey,
          due_at: item.earliestMs,
          expires_at: item.latestMs,
          status: "pending",
          time_created: input.nowMs,
          time_updated: input.nowMs,
        })
        .run()
    }
  })
}

// 提取 pass 的上下文：只给 dedupeKey + 时间窗，不回放原文。
export function pending(input: { companionID: string; nowMs: number }) {
  return Database.use((db) =>
    db
      .select({
        kind: CommitmentTable.kind,
        dedupe_key: CommitmentTable.dedupe_key,
        due_at: CommitmentTable.due_at,
        expires_at: CommitmentTable.expires_at,
      })
      .from(CommitmentTable)
      .where(
        and(
          eq(CommitmentTable.companion_id, input.companionID),
          eq(CommitmentTable.status, "pending"),
          gte(CommitmentTable.expires_at, input.nowMs),
        ),
      )
      .orderBy(asc(CommitmentTable.due_at))
      .limit(8)
      .all(),
  )
}

// 261120 Red 每个伙伴同时只领取一条。SQLite 串行化跨会话、跨进程领取；
// 租约到期可重新领取，进程异常退出也不会把条目永久留在占用状态。
export function claim(input: { companionID: string; nowMs: number }): Claim | undefined {
  if (!enabled()) return
  return Database.transaction((db) => {
    const active = db
      .select({ id: CommitmentTable.id })
      .from(CommitmentTable)
      .where(
        and(
          eq(CommitmentTable.companion_id, input.companionID),
          eq(CommitmentTable.status, "pending"),
          gt(CommitmentTable.claim_until, input.nowMs),
        ),
      )
      .get()
    if (active) return
    const delivered = db
      .select({ n: sql<number>`count(*)` })
      .from(CommitmentTable)
      .where(
        and(
          eq(CommitmentTable.companion_id, input.companionID),
          eq(CommitmentTable.status, "delivered"),
          gte(CommitmentTable.delivered_at, input.nowMs - 24 * 60 * 60 * 1000),
        ),
      )
      .get()
    if ((delivered?.n ?? 0) >= MAX_PER_DAY) return
    const row = db
      .select({ id: CommitmentTable.id, text: CommitmentTable.text, due_at: CommitmentTable.due_at })
      .from(CommitmentTable)
      .where(
        and(
          eq(CommitmentTable.companion_id, input.companionID),
          eq(CommitmentTable.status, "pending"),
          lte(CommitmentTable.due_at, input.nowMs),
          gte(CommitmentTable.expires_at, input.nowMs),
        ),
      )
      .orderBy(asc(CommitmentTable.due_at), asc(CommitmentTable.id))
      .get()
    if (!row) return
    const token = randomUUID()
    db.update(CommitmentTable)
      .set({ claim_id: token, claim_until: input.nowMs + CLAIM_LEASE_MS })
      .where(eq(CommitmentTable.id, row.id))
      .run()
    return { id: row.id, token, text: row.text, dueAt: row.due_at }
  }, { behavior: "immediate" })
}

export function renew(claim: Claim, nowMs: number) {
  if (!enabled()) return false
  return Database.use((db) =>
    !!db.update(CommitmentTable)
      .set({ claim_until: nowMs + CLAIM_LEASE_MS })
      .where(
        and(
          eq(CommitmentTable.id, claim.id),
          eq(CommitmentTable.claim_id, claim.token),
          eq(CommitmentTable.status, "pending"),
          gt(CommitmentTable.claim_until, nowMs),
        ),
      )
      .returning({ id: CommitmentTable.id })
      .get(),
  )
}

export function settle(claim: Claim, deliveredAt?: number) {
  Database.use((db) =>
    db.update(CommitmentTable)
      .set({
        claim_id: null,
        claim_until: null,
        ...(deliveredAt === undefined ? {} : { status: "delivered", delivered_at: deliveredAt, time_updated: deliveredAt }),
      })
      .where(
        and(
          eq(CommitmentTable.id, claim.id),
          eq(CommitmentTable.claim_id, claim.token),
          eq(CommitmentTable.status, "pending"),
          deliveredAt === undefined ? undefined : gt(CommitmentTable.claim_until, deliveredAt),
        ),
      )
      .run(),
  )
}

export function prompt(claim: Claim) {
  return truncate(
    "A follow-up came due (inferred from earlier conversation). Mention it naturally only if it fits the current moment. Treat the quoted text as context.\n" +
      JSON.stringify({ text: claim.text, dueAt: claim.dueAt }),
    MAX_INJECT_BYTES,
  )
}

export * as Commitment from "./commitment"
