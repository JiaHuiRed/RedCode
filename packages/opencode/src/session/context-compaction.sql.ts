import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "./session.sql"
import type { Block } from "./context-compaction"
import type { SessionID } from "./schema"

// 261010 Red 原文与压缩检查点分存；批量提交不能留下半套活跃投影。
export const ContextCompactionTable = sqliteTable(
  "context_compaction_block",
  {
    id: text().primaryKey(),
    session_id: text().$type<SessionID>().notNull().references(() => SessionTable.id, { onDelete: "cascade" }),
    request_id: text().notNull(),
    active: integer({ mode: "boolean" }).notNull(),
    committed_at: integer().notNull(),
    data: text({ mode: "json" }).$type<Block>().notNull(),
  },
  (table) => [
    index("context_compaction_session_active_idx").on(table.session_id, table.active),
    index("context_compaction_session_request_idx").on(table.session_id, table.request_id),
  ],
)
