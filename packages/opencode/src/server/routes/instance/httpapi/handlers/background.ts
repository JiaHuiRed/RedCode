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
    return handlers
      .handle("list", () => Effect.map(background.list(), (jobs) => jobs.map(project)))
      // 261104 Red 取消是幂等的：不存在的任务返回空数组，客户端刷新后自然消失。
      .handle("cancel", ({ params }) =>
        Effect.map(background.cancelTree(params.jobID), (cancelled) => ({ cancelled })),
      )
  }),
)
