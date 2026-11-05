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
  }),
)
