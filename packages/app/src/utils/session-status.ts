// 260828 cc 会话运行态的**唯一**判据。
//
// 这套规则原本内联在 home-kanban.tsx 的 columns() memo 里。侧边栏也要按同一套规则显示
// 「哪个项目在动」，两处各写一份必然漂：看板说"需关注"、侧边栏不亮点，或者反过来。
// 抽出来之后两边引用同一个函数，漂不了。
import type { Session } from "@redcode-ai/sdk/v2/client"
import { sessionPermissionRequest } from "@/pages/session/composer/session-request-tree"
import type { useServerSync } from "@/context/server-sync"
import type { useNotification } from "@/context/notification"
import type { usePermission } from "@/context/permission"

export type SessionStatus = "working" | "attention" | "idle"

export interface SessionStatusDeps {
  readonly sync: ReturnType<typeof useServerSync>
  readonly notification: ReturnType<typeof useNotification>
  readonly permission: ReturnType<typeof usePermission>
}

/**
 * 判定一个会话属于哪一档。
 *
 * **只读窥探**：`sync.child(dir, { bootstrap: false })` 不会触发目录的
 * `InstanceStore.load()`（那会拉起整套 MCP/LSP 进程树，见 home.tsx 里 sessionLoad 上方
 * 那段注释）。所以这个函数可以对任意多个项目调用，代价只是读已经在内存里的 store ——
 * 从没打开过的项目自然什么都没有，那也是对的：我们确实不知道，且不该为了知道而去拉起它。
 */
export function classifySession(session: Session, deps: SessionStatusDeps): SessionStatus {
  const [store] = deps.sync.child(session.directory, { bootstrap: false })
  const id = session.id

  const hasPermission = !!sessionPermissionRequest(
    store.session,
    store.permission,
    id,
    (item) => !deps.permission.autoResponds(item, session.directory),
  )
  // 有权限请求挂着时不算「工作中」—— 它在等人，不在跑
  if (!hasPermission && store.session_working(id)) return "working"
  if (hasPermission) return "attention"
  if (deps.notification.session.unseenHasError(id)) return "attention"
  if (deps.notification.session.unseenCount(id) > 0) return "attention"
  return "idle"
}

export interface SessionStatusTally {
  readonly working: number
  readonly attention: number
  readonly idle: number
}

export function tallySessionStatus(sessions: readonly Session[], deps: SessionStatusDeps): SessionStatusTally {
  let working = 0
  let attention = 0
  let idle = 0
  for (const session of sessions) {
    const status = classifySession(session, deps)
    if (status === "working") working++
    else if (status === "attention") attention++
    else idle++
  }
  return { working, attention, idle }
}
