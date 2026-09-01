/**
 * 项目维度的用量聚合。
 *
 * 260901 cc 首页那块看板要的「真·累计」不能在前端算：前端只加载了最近 114 个会话
 * （home.tsx 的 statsSessions 走的是已加载的 child store），而库里有 505 个。所以这里出一份
 * 服务端聚合，口径与私仓那个用量看板（~/.redcode/usage-dashboard/server.ts）一致。
 *
 * **按天归集必须走 message 表，不能走 session 表。** session 的 tokens_* 是整个会话的累计值，
 * 按 session.time_created 归日会把「昨天开的、今天还在用」的会话全部算进昨天，日线直接失真。
 * message.data.$.tokens 是每条 assistant 消息自己的量，时间基准才对得上。这条是私仓那份
 * 260812 踩过的坑，原样搬过来。
 *
 * 币种：**不照搬私仓那份的 CNY_PROVIDERS 硬编码名单**——GUI 侧 260827 已经退役了它，改读
 * model.cost.currency（provider.ts 的 CNY_PRICING 覆盖与 config.cost.currency 两条路都会写标记）。
 * 这里只出原始 cost 与 providerID/modelID，折算交给前端，跟 session-context-metrics.ts 与
 * home-stats.tsx 同一套口径，避免第三份汇率常量。
 */
import { Database } from "@/storage/db"
import { and, desc, eq, gte, sql } from "drizzle-orm"
import { Schema } from "effect"
import { MessageTable, SessionTable } from "./session.sql"
import type { ProjectID } from "../project/schema"

export const RangeSchema = Schema.Literals(["all", "30d", "7d"])
export type Range = typeof RangeSchema.Type

const Tokens = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
})

export const Info = Schema.Struct({
  range: RangeSchema,
  sessions: Schema.Finite,
  /** assistant 消息条数 —— 对应界面上的 "Messages"，不含用户消息。 */
  messages: Schema.Finite,
  tokens: Tokens,
  /** 原始金额，币种混合。折算成 ¥ 由前端按 model.cost.currency 做，见文件头注释。 */
  cost: Schema.Finite,
  activeDays: Schema.Finite,
  currentStreak: Schema.Finite,
  longestStreak: Schema.Finite,
  /** 本地时区 0-23；没有任何消息时缺省。 */
  peakHour: Schema.optional(Schema.Finite),
  daily: Schema.Array(
    Schema.Struct({
      day: Schema.String,
      messages: Schema.Finite,
      output: Schema.Finite,
      cost: Schema.Finite,
    }),
  ),
  models: Schema.Array(
    Schema.Struct({
      providerID: Schema.String,
      modelID: Schema.String,
      messages: Schema.Finite,
      input: Schema.Finite,
      output: Schema.Finite,
      cost: Schema.Finite,
    }),
  ),
  dailyByModel: Schema.Array(
    Schema.Struct({
      day: Schema.String,
      providerID: Schema.String,
      modelID: Schema.String,
      output: Schema.Finite,
    }),
  ),
})
export type Info = typeof Info.Type

const DAY_MS = 86_400_000

function since(range: Range, now: number) {
  if (range === "7d") return now - 7 * DAY_MS
  if (range === "30d") return now - 30 * DAY_MS
  return undefined
}

/** assistant 消息才带 cost/tokens，其余角色不进任何统计。 */
const ASSISTANT = sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`
const DAY = sql<string>`date(${MessageTable.time_created} / 1000, 'unixepoch', 'localtime')`
const HOUR = sql<number>`cast(strftime('%H', ${MessageTable.time_created} / 1000, 'unixepoch', 'localtime') as integer)`
const PROVIDER = sql<string>`coalesce(json_extract(${MessageTable.data}, '$.providerID'), 'unknown')`
const MODEL = sql<string>`coalesce(json_extract(${MessageTable.data}, '$.modelID'), 'unknown')`

const num = (path: string) => sql<number>`coalesce(sum(json_extract(${MessageTable.data}, ${path})), 0)`

const TOKENS = {
  input: num("$.tokens.input"),
  output: num("$.tokens.output"),
  reasoning: num("$.tokens.reasoning"),
  cacheRead: num("$.tokens.cache.read"),
  cacheWrite: num("$.tokens.cache.write"),
  cost: num("$.cost"),
}

function scope(projectID: ProjectID, range: Range, now: number) {
  const start = since(range, now)
  const conditions = [ASSISTANT, eq(SessionTable.project_id, projectID)]
  if (start !== undefined) conditions.push(gte(MessageTable.time_created, start))
  return and(...conditions)
}

function base(projectID: ProjectID, range: Range, now: number) {
  return Database.use((db) =>
    db
      .select({
        sessions: sql<number>`count(distinct ${MessageTable.session_id})`,
        messages: sql<number>`count(*)`,
        ...TOKENS,
      })
      .from(MessageTable)
      .innerJoin(SessionTable, eq(MessageTable.session_id, SessionTable.id))
      .where(scope(projectID, range, now))
      .get(),
  )
}

function daily(projectID: ProjectID, range: Range, now: number) {
  return Database.use((db) =>
    db
      .select({ day: DAY, messages: sql<number>`count(*)`, ...TOKENS })
      .from(MessageTable)
      .innerJoin(SessionTable, eq(MessageTable.session_id, SessionTable.id))
      .where(scope(projectID, range, now))
      .groupBy(DAY)
      .all(),
  )
}

function byModel(projectID: ProjectID, range: Range, now: number) {
  return Database.use((db) =>
    db
      .select({ providerID: PROVIDER, modelID: MODEL, messages: sql<number>`count(*)`, ...TOKENS })
      .from(MessageTable)
      .innerJoin(SessionTable, eq(MessageTable.session_id, SessionTable.id))
      .where(scope(projectID, range, now))
      .groupBy(PROVIDER, MODEL)
      .all(),
  )
}

/** 堆叠柱要的「某天某模型多少 token」。只出 output+reasoning，柱子高度对应产出量。 */
function dailyByModel(projectID: ProjectID, range: Range, now: number) {
  return Database.use((db) =>
    db
      .select({
        day: DAY,
        providerID: PROVIDER,
        modelID: MODEL,
        output: TOKENS.output,
        reasoning: TOKENS.reasoning,
      })
      .from(MessageTable)
      .innerJoin(SessionTable, eq(MessageTable.session_id, SessionTable.id))
      .where(scope(projectID, range, now))
      .groupBy(DAY, PROVIDER, MODEL)
      .all(),
  )
}

function peakHour(projectID: ProjectID, range: Range, now: number) {
  const row = Database.use((db) =>
    db
      .select({ hour: HOUR, messages: sql<number>`count(*)` })
      .from(MessageTable)
      .innerJoin(SessionTable, eq(MessageTable.session_id, SessionTable.id))
      .where(scope(projectID, range, now))
      .groupBy(HOUR)
      .orderBy(desc(sql`count(*)`))
      .limit(1)
      .get(),
  )
  return row?.hour ?? undefined
}

/**
 * 连续天数。
 *
 * 断点判定用**本地日历日**的字符串差，不是时间戳差——夏令时与跨时区会让 86400000 这个常数
 * 说谎。days 来自 SQLite 的 date(..., 'localtime')，已经是本地日历日。
 */
export function streaks(days: string[], today: string) {
  const sorted = [...new Set(days)].sort()
  if (sorted.length === 0) return { current: 0, longest: 0 }

  const step = (day: string) => {
    const next = new Date(`${day}T00:00:00Z`)
    next.setUTCDate(next.getUTCDate() + 1)
    return next.toISOString().slice(0, 10)
  }

  let longest = 1
  let run = 1
  for (let i = 1; i < sorted.length; i++) {
    if (step(sorted[i - 1]!) === sorted[i]) run++
    else run = 1
    if (run > longest) longest = run
  }

  // 当前连续：从今天往回数；今天还没用过则从昨天起算（当天没开工不该把连续清零）
  const last = sorted[sorted.length - 1]!
  const yesterday = (() => {
    const d = new Date(`${today}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - 1)
    return d.toISOString().slice(0, 10)
  })()
  if (last !== today && last !== yesterday) return { current: 0, longest }

  let current = 1
  for (let i = sorted.length - 1; i > 0; i--) {
    if (step(sorted[i - 1]!) !== sorted[i]) break
    current++
  }
  return { current, longest }
}

export function aggregate(input: { projectID: ProjectID; range: Range; now: number }) {
  const { projectID, range, now } = input
  const overview = base(projectID, range, now)
  const days = daily(projectID, range, now)
  const models = byModel(projectID, range, now)
  const perDayModel = dailyByModel(projectID, range, now)
  const today = new Date(now - new Date(now).getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
  const streak = streaks(
    days.map((d) => d.day),
    today,
  )

  return {
    range,
    sessions: Number(overview?.sessions ?? 0),
    messages: Number(overview?.messages ?? 0),
    tokens: {
      input: Number(overview?.input ?? 0),
      output: Number(overview?.output ?? 0),
      reasoning: Number(overview?.reasoning ?? 0),
      cacheRead: Number(overview?.cacheRead ?? 0),
      cacheWrite: Number(overview?.cacheWrite ?? 0),
    },
    cost: Number(overview?.cost ?? 0),
    activeDays: days.length,
    currentStreak: streak.current,
    longestStreak: streak.longest,
    peakHour: peakHour(projectID, range, now),
    daily: days.map((d) => ({
      day: d.day,
      messages: Number(d.messages),
      output: Number(d.output) + Number(d.reasoning),
      cost: Number(d.cost),
    })),
    models: models
      .map((m) => ({
        providerID: m.providerID,
        modelID: m.modelID,
        messages: Number(m.messages),
        input: Number(m.input) + Number(m.cacheRead) + Number(m.cacheWrite),
        output: Number(m.output) + Number(m.reasoning),
        cost: Number(m.cost),
      }))
      .sort((a, b) => b.output - a.output),
    dailyByModel: perDayModel
      .map((d) => ({
        day: d.day,
        providerID: d.providerID,
        modelID: d.modelID,
        output: Number(d.output) + Number(d.reasoning),
      }))
      .filter((d) => d.output > 0),
  }
}
