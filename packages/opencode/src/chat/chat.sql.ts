import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { ProjectTable } from "../project/project.sql"
import type { ProjectID } from "../project/schema"
import type { SessionID } from "../session/schema"
import { Timestamps } from "../storage/schema.sql"

export const ChatRoomTable = sqliteTable(
  "chat_room",
  {
    id: text().primaryKey(),
    project_id: text()
      .$type<ProjectID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    type: text().notNull(), // "group" | "direct"
    ...Timestamps,
  },
  (table) => [index("chat_room_project_idx").on(table.project_id)],
)

export const ChatMessageTable = sqliteTable(
  "chat_message",
  {
    id: text().primaryKey(),
    room_id: text()
      .notNull()
      .references(() => ChatRoomTable.id, { onDelete: "cascade" }),
    sender: text().notNull(), // "user" | "tui" | "gui"
    text: text(),
    content_type: text().notNull().default("text"), // "text" | "tool_result" | "system" | "diff"
    session_id: text().$type<SessionID>(),
    ...Timestamps,
  },
  (table) => [
    index("chat_message_room_time_idx").on(table.room_id, table.time_created),
    index("chat_message_session_idx").on(table.session_id),
  ],
)
