// 261015 Red 重复失败预算跨 step 持久化；见 docs/notes/implemented/bug-fix/2026-10-15-tool-failure-budget.md。
import { createHash } from "node:crypto"
import { and, eq, sql } from "drizzle-orm"
import { Database } from "@/storage/db"
import type { MessageID, SessionID } from "./schema"
import { MessageTable, PartTable } from "./session.sql"
import { inputKey } from "./repeat-tool-reminder"

export function inputSignature(tool: string, input: unknown): string {
  return signature(inputKey({ tool, input }))
}

export function signature(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

export function count(input: {
  sessionID: SessionID
  parentID: MessageID
  inputSignature: string
  errorSignature?: string
}): number {
  const row = Database.use((db) =>
    db.select({
      count: sql<number>`coalesce(max(json_extract(${PartTable.data}, '$.state.metadata.failureGuard.count')), 0)`,
    })
      .from(PartTable)
      .innerJoin(MessageTable, eq(MessageTable.id, PartTable.message_id))
      .where(and(
        eq(PartTable.session_id, input.sessionID),
        sql`json_extract(${MessageTable.data}, '$.parentID') = ${input.parentID}`,
        sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
        sql`json_extract(${PartTable.data}, '$.state.status') = 'error'`,
        sql`json_extract(${PartTable.data}, '$.state.metadata.failureGuard.inputSignature') = ${input.inputSignature}`,
        input.errorSignature === undefined ? undefined :
          sql`json_extract(${PartTable.data}, '$.state.metadata.failureGuard.errorSignature') = ${input.errorSignature}`,
      ))
      .get(),
  )
  return row?.count ?? 0
}

export function reminder(limit: number): string {
  return (
    `[System notice] Repeated tool failure: identical arguments produced the same error ${limit} times. ` +
    "Inspect the error and correct the arguments or use a different approach. " +
    "Calling this tool with the same arguments again will not execute it and will stop this automatic turn."
  )
}

export const BLOCKED = "Repeated tool failure budget exhausted. The tool was not executed; automatic continuation has stopped."
