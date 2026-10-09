import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { SessionTable } from "./session.sql"
import type { MessageID, SessionID } from "./schema"

export const SessionChangeTable = sqliteTable(
  "session_change",
  {
    session_id: text()
      .$type<SessionID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    id: text().notNull(),
    kind: text({ enum: ["session", "message"] }).notNull(),
    message_id: text().$type<MessageID>(),
    time_created: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.seq] }),
    index("session_change_time_created_id_idx").on(table.time_created, table.id),
  ],
)
