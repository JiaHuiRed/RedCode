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
import { and, eq, gte, sql } from "drizzle-orm"
import { Schema } from "effect"
import { MessageTable, SessionTable } from "./session.sql"
import type { ProjectID } from "../project/schema"
import type { Assistant } from "./message-v2"

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

function scope(projectID: ProjectID, range: Range, now: number) {
  const start = since(range, now)
  const conditions = [ASSISTANT, eq(SessionTable.project_id, projectID)]
  if (start !== undefined) conditions.push(gte(MessageTable.time_created, start))
  return and(...conditions)
}

function localDay(timestamp: number) {
  const date = new Date(timestamp)
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((value, index) => (index === 0 ? String(value) : String(value).padStart(2, "0")))
    .join("-")
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

/**
 * 260904 cc 指纹短路（黄档 A2）。
 *
 * 五个聚合查询的 WHERE 完全相同，各自把同一批 message 行扫一遍，而**每一条都要读
 * `message.data`**——本机副本实测该列合计 171MB，光把它读出来就要 1462ms。逐项冷态：
 *     base 1664ms / daily 292 / byModel 296 / dailyByModel 310 / peakHour 204 = 2766ms
 * （热态 1307ms）。瓶颈是读 blob，不是 `json_extract` 本身：同一批行不碰 data 只 count 是 6ms，
 * 一加 role 过滤就跳到 172ms。所以加索引救不了——`sum` 无论如何都要把行读出来。
 *
 * 指纹**刻意不碰 data、不带 role 过滤、不带 range 过滤**：只数该项目的 message 行数与最大
 * 时间戳，实测 5ms。任何新消息都会让两者之一变化，于是宁可过度失效也不会漏。
 */
function fingerprint(projectID: ProjectID) {
  return Database.use((db) =>
    db
      .select({
        rows: sql<number>`count(*)`,
        latest: sql<number>`coalesce(max(${MessageTable.time_created}), 0)`,
      })
      .from(MessageTable)
      .innerJoin(SessionTable, eq(MessageTable.session_id, SessionTable.id))
      .where(eq(SessionTable.project_id, projectID))
      .get(),
  )
}

// 只缓存 range="all"。7d/30d 的窗口是**相对当前时间滑动**的，message 一行没变、时间往前走
// 结果照样该变，指纹管不住这一维。而 "all" 正好是服务端的默认值（handlers/session.ts），
// 也是最贵的那条（没有时间过滤 = 全表）。
// 有界：一个进程同时开的项目数很小，16 个足够，超了按 LRU 淘汰。
const CACHE_LIMIT = 16
const cache = new Map<ProjectID, { rows: number; latest: number; value: ReturnType<typeof compute> }>()

/** 供测试与 revert 之类的写入路径手动作废；正常路径靠指纹自己失效。 */
export function invalidate(projectID?: ProjectID) {
  if (projectID === undefined) cache.clear()
  else cache.delete(projectID)
}

export function aggregate(input: { projectID: ProjectID; range: Range; now: number }) {
  if (input.range !== "all") return compute(input)

  const print = fingerprint(input.projectID)
  const rows = Number(print?.rows ?? 0)
  const latest = Number(print?.latest ?? 0)
  const hit = cache.get(input.projectID)
  if (hit && hit.rows === rows && hit.latest === latest) {
    // 命中顺带刷新 LRU 位置
    cache.delete(input.projectID)
    cache.set(input.projectID, hit)
    return hit.value
  }

  const value = compute(input)
  cache.delete(input.projectID)
  cache.set(input.projectID, { rows, latest, value })
  while (cache.size > CACHE_LIMIT) {
    for (const oldest of cache.keys()) {
      cache.delete(oldest)
      break
    }
  }
  return value
}

function compute(input: { projectID: ProjectID; range: Range; now: number }) {
  const { projectID, range, now } = input
  // 260920 Red 五个 SQL 聚合原本各自读取同一批 message.data；冷缓存时 blob 重读占掉
  //   绝大部分时间。一次只取必要列，再在内存里复用同一份已解码消息，保持原有统计口径。
  const rows = Database.use((db) =>
    db
      .select({
        sessionID: MessageTable.session_id,
        timeCreated: MessageTable.time_created,
        data: MessageTable.data,
      })
      .from(MessageTable)
      .innerJoin(SessionTable, eq(MessageTable.session_id, SessionTable.id))
      .where(scope(projectID, range, now))
      .all(),
  )
  const sessions = new Set<string>()
  const totals = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    messages: 0,
  }
  const daily = new Map<string, { messages: number; output: number; cost: number }>()
  const models = new Map<
    string,
    { providerID: string; modelID: string; messages: number; input: number; output: number; cost: number }
  >()
  const dailyByModel = new Map<string, { day: string; providerID: string; modelID: string; output: number }>()
  const hours = new Map<number, number>()

  for (const row of rows) {
    if (row.data.role !== "assistant") continue
    const message = row.data as Omit<Assistant, "id" | "sessionID">
    const day = localDay(row.timeCreated)
    const output = message.tokens.output + message.tokens.reasoning
    const input = message.tokens.input + message.tokens.cache.read + message.tokens.cache.write
    const modelKey = `${message.providerID}\u0000${message.modelID}`
    const dailyModelKey = `${day}\u0000${modelKey}`

    sessions.add(row.sessionID)
    totals.messages += 1
    totals.input += message.tokens.input
    totals.output += message.tokens.output
    totals.reasoning += message.tokens.reasoning
    totals.cacheRead += message.tokens.cache.read
    totals.cacheWrite += message.tokens.cache.write
    totals.cost += message.cost

    const dayValue = daily.get(day) ?? { messages: 0, output: 0, cost: 0 }
    dayValue.messages += 1
    dayValue.output += output
    dayValue.cost += message.cost
    daily.set(day, dayValue)

    const modelValue = models.get(modelKey) ?? {
      providerID: message.providerID,
      modelID: message.modelID,
      messages: 0,
      input: 0,
      output: 0,
      cost: 0,
    }
    modelValue.messages += 1
    modelValue.input += input
    modelValue.output += output
    modelValue.cost += message.cost
    models.set(modelKey, modelValue)

    const dailyModelValue = dailyByModel.get(dailyModelKey) ?? {
      day,
      providerID: message.providerID,
      modelID: message.modelID,
      output: 0,
    }
    dailyModelValue.output += output
    dailyByModel.set(dailyModelKey, dailyModelValue)

    const hour = new Date(row.timeCreated).getHours()
    hours.set(hour, (hours.get(hour) ?? 0) + 1)
  }

  const days = [...daily.entries()]
    .map(([day, value]) => ({ day, ...value }))
    .sort((a, b) => a.day.localeCompare(b.day))
  const today = localDay(now)
  const streak = streaks(
    days.map((day) => day.day),
    today,
  )
  const peakHour = [...hours.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0]

  return {
    range,
    sessions: sessions.size,
    messages: totals.messages,
    tokens: {
      input: totals.input,
      output: totals.output,
      reasoning: totals.reasoning,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
    },
    cost: totals.cost,
    activeDays: days.length,
    currentStreak: streak.current,
    longestStreak: streak.longest,
    peakHour,
    daily: days,
    models: [...models.values()].sort((a, b) => b.output - a.output),
    dailyByModel: [...dailyByModel.values()].filter((day) => day.output > 0),
  }
}
