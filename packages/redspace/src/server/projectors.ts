import sessionProjectors from "../session/projectors"
import { SyncEvent } from "@/sync"
import { Session } from "@/session/session"
import { SessionTable } from "@/session/session.sql"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"

// 260828 cc：有意不投影的事件。全是流式增量/进度通知 —— 它们只驱动内存里的消息
// 拼装（session-message-updater），落库的是对应的 *.ended / *.updated。以前这份名单
// 隐含在 `def.type.includes("next")` 这个子串判断里，等于把「忘写 projector」的护栏
// 对整个 session.next.* 命名空间关掉。改成显式列举后,新增事件忘了 projector 会在
// process() 直接抛错，test/sync/invariants.test.ts 的集合相等断言会在 CI 先红。
export const NON_PROJECTING_EVENT_TYPES = [
  // 工具进度只驱动内存里的消息拼装（session-message-updater），没有对应的落库形态；
  // 其余 session.next.* 的 delta 事件都是有 projector 的（在 projectors-next.ts 里按
  // 定义变量引用，不是字符串字面量 —— 按字面量 grep 会数漏）。
  "session.next.tool.progress",
] as const

export function initProjectors() {
  SyncEvent.init({
    projectors: sessionProjectors,
    nonProjecting: NON_PROJECTING_EVENT_TYPES,
    convertEvent: (type, data) => {
      if (type === "session.updated") {
        const id = (data as SyncEvent.Event<typeof Session.Event.Updated>["data"]).sessionID
        const row = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, id)).get())

        if (!row) return data

        return {
          sessionID: id,
          info: Session.fromRow(row),
        }
      }
      return data
    },
  })
}
