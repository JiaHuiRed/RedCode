import { Database, eq, desc, lt, and } from "@/storage/db"
import { ChatRoomTable, ChatMessageTable } from "./chat.sql"

function generateId() {
  return `chat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export function ensureRoom(
  projectId: string,
  roomId: string,
  type: "group" | "direct",
) {
  return Database.transaction((tx) => {
    const existing = tx.select().from(ChatRoomTable).where(eq(ChatRoomTable.id, roomId)).get()
    if (existing) return existing.id
    tx.insert(ChatRoomTable).values([{ id: roomId, project_id: projectId as any, type }]).run()
    return roomId
  })
}

export interface SendParams {
  roomId: string
  sender: "user" | "tui" | "gui"
  text: string
  contentType?: string
  sessionId?: string
}

export function sendMessage(params: SendParams) {
  const id = generateId()
  Database.use((tx) => {
    tx.insert(ChatMessageTable).values([{
      id,
      room_id: params.roomId,
      sender: params.sender,
      text: params.text,
      content_type: params.contentType ?? "text",
      session_id: (params.sessionId as any) ?? null,
      time_created: Date.now(),
      time_updated: Date.now(),
    }]).run()
  })
  return { id }
}

export interface MessageRow {
  id: string
  room_id: string
  sender: "user" | "tui" | "gui"
  text: string | null
  content_type: string
  session_id: string | null
  time_created: number
}

export function getMessages(
  roomId: string,
  opts?: { limit?: number; before?: number },
): MessageRow[] {
  return Database.use((tx) => {
    const conditions = [eq(ChatMessageTable.room_id, roomId)]
    if (opts?.before) conditions.push(lt(ChatMessageTable.time_created, opts.before))
    return tx
      .select()
      .from(ChatMessageTable)
      .where(and(...conditions))
      .orderBy(desc(ChatMessageTable.time_created))
      .limit(opts?.limit ?? 50)
      .all() as MessageRow[]
  })
}

export function getLastMessage(roomId: string): MessageRow | undefined {
  return Database.use((tx) => {
    return tx
      .select()
      .from(ChatMessageTable)
      .where(eq(ChatMessageTable.room_id, roomId))
      .orderBy(desc(ChatMessageTable.time_created))
      .limit(1)
      .get() as MessageRow | undefined
  })
}

export * as Chat from "."
