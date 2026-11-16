// 261116 Red B03：会话「当前最重要的行动」判据。
//
// 看板卡片与新会话页的最近任务入口必须对同一个会话给出同一个结论，各写一份必然漂
// （与 @/utils/session-status 的 classifySession 同思路）。这里只做「下一步该处理什么」：
//   等待回答（模型提问） > 等待授权（权限请求） > 出错待看 > 完成待看 > 已有草稿。
// 前四档来自运行时真实状态；草稿是最后兜底，且只认已落盘的文字/评论草稿。
// 没有可靠数据就返回 undefined —— 不猜、不为卡片额外调用模型。
import type { Session } from "@redcode-ai/sdk/v2/client"
import { base64Encode } from "@redcode-ai/core/util/encode"
import type { useServerSync } from "@/context/server-sync"
import type { useNotification } from "@/context/notification"
import type { usePermission } from "@/context/permission"
import type { usePlatform } from "@/context/platform"
import { sessionPermissionRequest, sessionQuestionRequest } from "@/pages/session/composer/session-request-tree"
import { Persist } from "@/utils/persist"

export type SessionNextActionKind = "question" | "permission" | "error" | "unseen"

export type SessionNextAction = {
  kind: SessionNextActionKind
}

export interface SessionNextActionDeps {
  readonly sync: ReturnType<typeof useServerSync>
  readonly notification: ReturnType<typeof useNotification>
  readonly permission: ReturnType<typeof usePermission>
}

// peek 与 classifySession 同源：只读内存里的目录 store，不 pin、不 bootstrap
// （child() 会永久钉住目录并触发整套实例拉起，见 utils/session-status 的说明）。
export function sessionNextAction(
  session: Session,
  deps: SessionNextActionDeps,
): SessionNextAction | undefined {
  const [store] = deps.sync.peek(session.directory, { bootstrap: false })

  if (sessionQuestionRequest(store.session, store.question, session.id)) return { kind: "question" }
  if (
    sessionPermissionRequest(store.session, store.permission, session.id, (item) =>
      !deps.permission.autoResponds(item, session.directory),
    )
  ) {
    return { kind: "permission" }
  }
  if (deps.notification.session.unseenHasError(session.id)) return { kind: "error" }
  if (deps.notification.session.unseenCount(session.id) > 0) return { kind: "unseen" }
  return undefined
}

/**
 * 只读探测某个会话是否留有文字草稿（含带评论的文件上下文）。
 *
 * 为什么不直接 `usePrompt().dirty(scope)`：那会为每个会话创建一套 prompt store，
 * 连带读取该会话的图片媒体（本机 RedCode.media.dat 约 6.9MB），一屏 20+ 张卡片逐个
 * 读盘不可接受。这里只读 prompt 持久化里那一个键，代价是一次小文件读取。
 *
 * 已知边界（宁可漏报不误报）：
 * - 只读已落盘的草稿，最后 250ms 内的未落盘输入可能还没写进去；
 * - 图片附件单独存放在媒体 store，这里不读，所以纯图片草稿不会显示「已有草稿」；
 * - 读取或解析失败一律按「没有草稿」处理。
 */
export async function readSessionDraft(
  directory: string,
  sessionID: string,
  platform: ReturnType<typeof usePlatform>,
): Promise<boolean> {
  // prompt store 的键用路由 :dir 段同一形态（base64 编码后的目录），与 context/prompt.tsx 一致。
  const target = Persist.scoped(base64Encode(directory), sessionID, "prompt")
  let raw: string | null | undefined
  try {
    raw =
      platform.platform === "desktop" && platform.storage
        ? await platform.storage(target.storage)?.getItem(target.key)
        : localStorage.getItem(`${target.storage}:${target.key}`)
  } catch {
    // 存储不可用（受限上下文/配额异常）时无法确认草稿：按没有处理，不冒充数据。
    return false
  }
  if (!raw) return false

  try {
    const value = JSON.parse(raw) as {
      prompt?: { type?: string; content?: string }[]
      context?: { items?: { comment?: string }[] }
    }
    const text = Array.isArray(value.prompt)
      ? value.prompt.some((part) => part?.type === "text" && typeof part.content === "string" && part.content.trim())
      : false
    const comment = !!value.context?.items?.some((item) => !!item?.comment?.trim())
    return text || comment
  } catch {
    // 损坏或旧格式的持久化内容：无法确认有草稿，按没有处理（不冒充数据）。
    return false
  }
}
