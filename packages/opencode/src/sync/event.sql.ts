import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const EventSequenceTable = sqliteTable("event_sequence", {
  aggregate_id: text().notNull().primaryKey(),
  seq: integer().notNull(),
  owner_id: text(),
})

export const EventTable = sqliteTable(
  "event",
  {
    id: text().primaryKey(),
    aggregate_id: text()
      .notNull()
      .references(() => EventSequenceTable.aggregate_id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    type: text().notNull(),
    data: text({ mode: "json" }).$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    // 261013 Red 热读路径按 aggregate_id 过滤 + seq 排序（control-plane/workspace.ts:723-724、
    // httpapi handlers/sync.ts:87 复合过滤），无索引时全表扫描；(aggregate_id, seq) 的
    // 前缀同时服务单列过滤，排序直接吃索引。
    index("event_aggregate_id_seq_idx").on(table.aggregate_id, table.seq),
  ],
)
