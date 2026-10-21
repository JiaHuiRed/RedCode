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

// 261021 Red 核心签名 = 同工具 + 同错误文本。参数里的无关/幻觉字段抖动（redmind 实测：
// Read 连错 10 次，content 参数在 缺省→整段正文→"x" 之间抖）会让精确 inputSignature 每换
// 一次就重开失败预算，防线被绕过、额度白烧。错误文本相同 = 本次调用没有产生新信息，应
// 同链计数；换出不同错误（如换目标文件路径）仍是新链，保留模型合理自救的空间。
export function coreSignature(tool: string, error: string): string {
  return signature(`tool\0${tool}\0error\0${error}`)
}

export function signature(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

export function count(input: {
  sessionID: SessionID
  parentID: MessageID
  inputSignature?: string
  coreSignature?: string
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
        input.inputSignature === undefined ? undefined :
          sql`json_extract(${PartTable.data}, '$.state.metadata.failureGuard.inputSignature') = ${input.inputSignature}`,
        input.coreSignature === undefined ? undefined :
          sql`json_extract(${PartTable.data}, '$.state.metadata.failureGuard.coreSignature') = ${input.coreSignature}`,
        input.errorSignature === undefined ? undefined :
          sql`json_extract(${PartTable.data}, '$.state.metadata.failureGuard.errorSignature') = ${input.errorSignature}`,
      ))
      .get(),
  )
  return row?.count ?? 0
}

export function reminder(limit: number): string {
  return (
    `[System notice] Repeated tool failure: the same error has occurred ${limit} times in a row for this tool ` +
    "(even with slightly different arguments). " +
    "Inspect the error and correct the arguments or use a different approach. " +
    "Calling this tool again in a way that produces the same error will not execute it and will stop this automatic turn."
  )
}

export const BLOCKED = "Repeated tool failure budget exhausted. The tool was not executed; automatic continuation has stopped."
