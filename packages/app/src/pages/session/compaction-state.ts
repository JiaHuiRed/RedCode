import type { AssistantMessage, Part } from "@redcode-ai/sdk/v2"

// 261013 Red GUI 压缩状态可见性：纯函数判据与 TUI 逐字对齐
// （packages/opencode/src/cli/cmd/tui/routes/session/index.tsx 的
// compactionMessage / compactionError / compacting 三个 memo）：
// 见 docs/notes/implemented/feature/2026-10-10-native-compaction.md#中断恢复与状态可见性
//   终态    = 摘要（mode "compaction" 且 parentID 为本条 user 消息的 assistant）带 error
//             → MessageAbortedError 为 canceled、其余 failed；
//             无 error 且 marker part 的 tokens_after 已回填 → success
//   pending = session.time.compacting 存在、marker 最新，且摘要不存在/未完成/创建时间不早于压缩开始
//   其余    = incomplete（未完成）
// 无 Solid 依赖，message-timeline.data.ts 的 construct 与单测共用同一份判据。

export type CompactionState = "success" | "failed" | "canceled" | "pending" | "incomplete"

export type CompactionStateInput = {
  /** marker 所属 user 消息 id */
  userMessageID: string
  /** 该 user 消息的 parts（含 type === "compaction" 的 marker part） */
  userParts: Part[]
  /** parentID === userMessageID 的 assistant 消息（摘要就在其中） */
  assistantMessages: AssistantMessage[]
  /** session.time.compacting，不存在为 undefined */
  sessionCompacting: number | undefined
  /** 该 marker 是否为该会话最新的 compaction marker（由调用方按消息序判定） */
  isLatestMarker: boolean
}

export type CompactionStateResult = {
  state: CompactionState
  attemptStarted: boolean
  tokensBefore?: number
  tokensAfter?: number
  /** failed/canceled 的失败原因：error.data?.message ?? error.name */
  reason?: string
}

/** TUI 的 compactionReason：error.data.message 优先，取不到回退 error.name */
function compactionReason(error: { name: string; data?: unknown }) {
  const data = error.data
  const message =
    data && typeof data === "object" && !Array.isArray(data) ? (data as { message?: unknown }).message : undefined
  if (typeof message === "string" && message) return message
  return error.name
}

export function resolveCompactionState(input: CompactionStateInput): CompactionStateResult {
  const marker = input.userParts.find((part) => part.type === "compaction")
  if (!marker) return { state: "incomplete", attemptStarted: false }

  const tokensBefore = marker.tokens_before
  const tokensAfter = marker.tokens_after
  // 与 TUI 一致取 findLast：同一 parent 下多次尝试只认最后一条摘要
  const summary = input.assistantMessages.findLast(
    (message) => message.mode === "compaction" && message.parentID === input.userMessageID,
  )
  const attemptStarted = !!summary || input.sessionCompacting !== undefined || tokensBefore !== undefined

  const error = summary?.error
  if (error) {
    return {
      state: error.name === "MessageAbortedError" ? "canceled" : "failed",
      attemptStarted: true,
      tokensBefore,
      tokensAfter,
      reason: compactionReason(error),
    }
  }

  if (tokensAfter !== undefined) return { state: "success", attemptStarted: true, tokensBefore, tokensAfter }

  if (
    input.sessionCompacting !== undefined &&
    input.isLatestMarker &&
    (!summary || summary.time.completed === undefined || summary.time.created >= input.sessionCompacting)
  ) {
    return { state: "pending", attemptStarted: true, tokensBefore }
  }

  return { state: "incomplete", attemptStarted, tokensBefore }
}
