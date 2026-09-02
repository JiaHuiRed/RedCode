/**
 * 会话轮次目录：整份日志的每一轮一条，供侧边导航栏跳转用。
 *
 * 260901 cc 采自 deepseek-harness 的 `2026-08-30-web-turn-rail-outline-jump`。那篇的问题
 * 陈述对我们逐字成立：导航如果从**已加载的消息窗口**推导，而窗口只是日志的一个分页后缀
 * （本仓首屏 `initialMessagePageSize` 条，往前靠「加载更早」一页页翻），那么长会话里导航
 * 只会列出最近几轮 —— 恰恰是最不需要导航就能看到的那部分。所以目录必须**独立于窗口**，
 * 从库里直接查。
 *
 * 与上游的两点不同：
 *
 * ① **不做投影（projection）折叠。** 上游是事件溯源，目录是注册在 `ctx.sessionProjections`
 *    上的一个纯 fold，还要配一套「变更源身份闸门」把流式期间每条 assistant 消息的推送
 *    压到每轮三次。本仓是 SQLite，直接查表就有全量，那套增量机制没有对应物，也不需要。
 *
 * ② **预览在 SQL 里先截断。** 一个长会话的正文可以有几 MB，而目录每轮只要一两行。
 *    `substr(json_extract(...), 1, SQL_CLIP)` 让截断发生在数据库里，避免把整份正文
 *    拉进 JS 再扔掉。最终预算仍在 JS 里定（见 PROMPT_BUDGET / RESPONSE_BUDGET），
 *    SQL 那个 400 只是个宽松上界。
 *
 * 轮次的定义与时间线一致（`message-timeline.data.ts` 的 `constructMessageRows`）：
 * 一条 user 消息 + 它之后到下一条 user 消息之前的全部 assistant 消息。锚点取 user 消息的
 * id —— 跳转就是跳到它，而且它天然是这一轮在时间线上的第一行。
 */
import { Database } from "@/storage/db"
import { and, asc, eq, sql } from "drizzle-orm"
import { Schema } from "effect"
import { MessageTable, PartTable } from "./session.sql"
import type { SessionID } from "./schema"

/** SQL 侧的宽松上界，只为限制传输量；真正的预算在下面两条。 */
const SQL_CLIP = 400
/** 提问预览：一行。中文比英文密，比上游的 50 略放宽。 */
const PROMPT_BUDGET = 60
/** 回答预览：UI 上最多三行，按行宽给足。 */
const RESPONSE_BUDGET = 150

export const Entry = Schema.Struct({
  /** 这一轮的 user 消息 id。它同时是跳转锚点与时间线上该轮的第一行。 */
  messageID: Schema.String,
  /** user 消息的 time_created，毫秒。 */
  time: Schema.Finite,
  /** 第几轮，从 1 起。 */
  turn: Schema.Finite,
  prompt: Schema.String,
  promptClipped: Schema.Boolean,
  /** 这一轮最后一条带文字的 assistant 消息的开头。这一轮还没出回答时是空串。 */
  response: Schema.String,
  responseClipped: Schema.Boolean,
})
export type Entry = typeof Entry.Type

export const Info = Schema.Struct({
  sessionID: Schema.String,
  entries: Schema.Array(Entry),
})
export type Info = typeof Info.Type

const ROLE = sql<string>`json_extract(${MessageTable.data}, '$.role')`

/**
 * 每条消息取**第一个** text part 的开头。
 *
 * `group by message_id` + select 里带 `min(id)`：这是 SQLite 有明文保证的写法 —— 同一
 * 分组内的裸列取自 min() 命中的那一行，不是任取。用它把「一条消息可能有很多个 part」
 * 压成每条消息一行，否则一个长会话要拉几千行回来只为了每条消息的头几十个字。
 */
function previews(sessionID: SessionID) {
  return Database.use((db) =>
    db
      .select({
        messageID: PartTable.message_id,
        first: sql<string>`min(${PartTable.id})`,
        text: sql<string | null>`substr(json_extract(${PartTable.data}, '$.text'), 1, ${SQL_CLIP})`,
      })
      .from(PartTable)
      .where(and(eq(PartTable.session_id, sessionID), sql`json_extract(${PartTable.data}, '$.type') = 'text'`))
      .groupBy(PartTable.message_id)
      .all(),
  )
}

function messages(sessionID: SessionID) {
  return Database.use((db) =>
    db
      .select({ id: MessageTable.id, time: MessageTable.time_created, role: ROLE })
      .from(MessageTable)
      .where(eq(MessageTable.session_id, sessionID))
      .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
      .all(),
  )
}

/** 折成一行并压掉连续空白 —— 预览里换行会把三行的预算浪费在一个代码块的缩进上。 */
function flatten(text: string) {
  return text.replace(/\s+/gu, " ").trim()
}

function clip(text: string, budget: number) {
  const flat = flatten(text)
  // 按码点切，别按 UTF-16 码元 —— emoji 和部分 CJK 是代理对，切一半会留下半个字符。
  const points = Array.from(flat)
  if (points.length <= budget) return { text: flat, clipped: false }
  return { text: points.slice(0, budget).join("").trimEnd(), clipped: true }
}

export type Row = { id: string; time: number; role: string }

/**
 * 把「按时间排好的消息行 + 每条消息的正文开头」折成轮次目录。
 *
 * 与库解耦是为了能测：轮次编号、最后一条带文字的 assistant 才算回答、
 * 孤儿 assistant（没有前导 user，比如从中间截断的历史）不能凭空造一轮 —— 这几条
 * 都只跟折叠逻辑有关，不跟 SQL 有关。
 */
export function fold(sessionID: string, rows: Row[], text: Map<string, string>): Info {
  // Schema.Struct 出来的类型是只读的，而这里要在遇到后续 assistant 消息时回填 response，
  // 所以累加器用可变形状，最后整体当作 Entry[] 交出去。
  const entries: { -readonly [K in keyof Entry]: Entry[K] }[] = []
  for (const row of rows) {
    if (row.role === "user") {
      const prompt = clip(text.get(row.id) ?? "", PROMPT_BUDGET)
      entries.push({
        messageID: row.id,
        time: row.time,
        turn: entries.length + 1,
        prompt: prompt.text,
        promptClipped: prompt.clipped,
        response: "",
        responseClipped: false,
      })
      continue
    }
    // assistant：覆盖本轮的回答预览，于是留下的是**最后一条**带文字的那条，
    // 与上游「最新的 text-bearing assistant 消息在 turn/end 时落定」同一口径。
    const current = entries.at(-1)
    if (!current) continue
    const body = text.get(row.id)
    if (!body) continue
    const response = clip(body, RESPONSE_BUDGET)
    current.response = response.text
    current.responseClipped = response.clipped
  }

  return { sessionID, entries }
}

export function build(sessionID: SessionID): Info {
  return fold(
    sessionID,
    messages(sessionID),
    new Map(previews(sessionID).map((row) => [row.messageID, row.text ?? ""] as const)),
  )
}
