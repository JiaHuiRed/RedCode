import { BackgroundCancel } from "@/background/cancel"
import { BackgroundJob } from "@/background/job"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { InstanceHttpApi } from "../api"

function project(info: BackgroundJob.Info) {
  return {
    id: info.id,
    type: info.type,
    title: info.title,
    status: info.status,
    startedAt: info.started_at,
    completedAt: info.completed_at,
    error: info.error,
    sessionID: typeof info.metadata?.sessionId === "string" ? info.metadata.sessionId : undefined,
    parentSessionID: typeof info.metadata?.parentSessionId === "string" ? info.metadata.parentSessionId : undefined,
  }
}

// 261115 Red UX-17：结果按需取 + 有界。output 是子代理完整输出（可达数 MB），这里只
// 回末尾 32,000 字符——结论在结尾，开头需要完整上下文时走 sessionID 的会话记录。
// 完成任务 30 分钟后被回收，届时 found=false，客户端提示改从会话查看。
const RESULT_CHAR_CAP = 32_000

function sessionOf(info: BackgroundJob.Info | undefined, key: string) {
  const value = info?.metadata?.[key]
  return typeof value === "string" ? value : undefined
}

export const backgroundHandlers = HttpApiBuilder.group(InstanceHttpApi, "background", (handlers) =>
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const canceller = yield* BackgroundCancel.Service
    return handlers
      .handle("list", () => Effect.map(background.list(), (jobs) => jobs.map(project)))
      // 261105 Red 取消走 BackgroundCancel：job 树与 SessionStatus 归位一起做（审计 RC-015-01）。
      // 261104 Red 取消是幂等的：不存在的任务返回空数组，客户端刷新后自然消失。
      .handle("cancel", ({ params }) =>
        Effect.map(canceller.cancelTree(params.jobID), (cancelled) => ({ cancelled })),
      )
      .handle("result", ({ params }) =>
        Effect.gen(function* () {
          const info = yield* background.get(params.jobID)
          const output = info?.output
          const truncated = output !== undefined && output.length > RESULT_CHAR_CAP
          return {
            id: params.jobID,
            found: info !== undefined,
            status: info?.status,
            title: info?.title,
            output: truncated ? output.slice(-RESULT_CHAR_CAP) : output,
            truncated,
            totalChars: output?.length ?? 0,
            error: info?.error,
            sessionID: sessionOf(info, "sessionId"),
            parentSessionID: sessionOf(info, "parentSessionId"),
          }
        }),
      )
  }),
)
