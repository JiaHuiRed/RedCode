import fs from "fs/promises"
import path from "path"
import { Global } from "@redcode-ai/core/global"
import * as Log from "@redcode-ai/core/util/log"
import { Database } from "@/storage/db"
import { SessionTable } from "./session.sql"

const log = Log.create({ service: "session.diff-gc" })

// 260904 cc A1 第 5 步：清掉 storage/session_diff/ 里已删会话的孤儿文件。
// Session.remove 此前只删库行不删这份文件，本机 615 个文件里 186 个（22MB）是孤儿；remove 现在会跟着删，
// 这里补历史欠账。每次进程启动跑一遍（index.ts，JSON→DB 迁移之后），纯文件系统 + 一条 select，几毫秒。
//
// 两道保险，都是冲着「测试洗掉 live 数据」那族事故：
//   · 只在这个进程的 CLI 入口调用，不挂在任何 Layer 上——测试构建 Session layer 不会顺手跑到它
//   · 库里一个会话都没有就什么都不删——空库时「全部都是孤儿」大概率是目录指错了，不是真没会话
export async function sweep() {
  const dir = path.join(Global.Path.data, "storage", "session_diff")
  const names = await fs.readdir(dir).catch(() => [] as string[])
  if (names.length === 0) return
  const ids = new Set<string>(
    Database.use((db) => db.select({ id: SessionTable.id }).from(SessionTable).all()).map((r) => r.id),
  )
  if (ids.size === 0) return
  let removed = 0
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    if (ids.has(name.slice(0, -5))) continue
    await fs.unlink(path.join(dir, name)).then(
      () => removed++,
      () => undefined,
    )
  }
  if (removed > 0) log.info("removed orphan session_diff files", { removed, total: names.length })
}

export * as SessionDiffGc from "./session-diff-gc"
