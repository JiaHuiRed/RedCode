import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"

// 261119 Red Inferred commitments v1（迁移路线第 1 项）：对话里埋下、用户没显式要求的
// 后续跟进。到期后只在绑定 Chat 的下一条用户消息上提示一句，绝不即时回显。
// 决策：docs/notes/proposed/architecture/2026-11-18-qiuqiu-full-migration.md
export const CommitmentTable = sqliteTable(
  "commitment",
  {
    id: text().primaryKey(),
    companion_id: text().notNull(),
    session_id: text().notNull(),
    kind: text().notNull(),
    source: text().notNull(),
    sensitivity: text().notNull(),
    text: text().notNull(),
    reason: text().notNull(),
    dedupe_key: text().notNull(),
    due_at: integer().notNull(),
    expires_at: integer().notNull(),
    // pending | delivered | dismissed | expired
    status: text().notNull(),
    delivered_at: integer(),
    ...Timestamps,
  },
  (table) => [
    index("commitment_scope_status_due_idx").on(table.companion_id, table.status, table.due_at),
    index("commitment_scope_dedupe_idx").on(table.companion_id, table.dedupe_key),
  ],
)
