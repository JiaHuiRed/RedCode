import { BackgroundCancel } from "@/background/cancel"
import { BackgroundJob } from "@/background/job"
import { InstanceState } from "@/effect/instance-state"
import { MessageV2 } from "@/session/message-v2"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import {
  STEERING_REQUEST_ID_MAX_BYTES,
  isSteeringMessageValid,
  steerTaskFromUser,
  steeringTargetRejection,
} from "@/tool/task"
import { Clock, Deferred, Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { ConflictError, ForbiddenError, InvalidRequestError, TimeoutError, notFound } from "../errors"
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

// 261116 Red 回执以持久化消息为准：只等落库，不等模型消费。
const STEER_RECEIPT_TIMEOUT = 10_000
const STEER_POLL_MS = 100

export const backgroundHandlers = HttpApiBuilder.group(InstanceHttpApi, "background", (handlers) =>
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const canceller = yield* BackgroundCancel.Service
    const sessions = yield* Session.Service

    const steer = Effect.fn("BackgroundHttpApi.steer")(function* (ctx: {
      params: { sessionID: string }
      payload: { message: string; requestID: string }
    }) {
      if (!isSteeringMessageValid(ctx.payload.message))
        return yield* new InvalidRequestError({
          message: "Steering message must be nonblank and at most 16384 UTF-8 bytes",
          field: "message",
        })
      if (
        !ctx.payload.requestID.trim() ||
        Buffer.byteLength(ctx.payload.requestID, "utf8") > STEERING_REQUEST_ID_MAX_BYTES
      )
        return yield* new InvalidRequestError({
          message: `Steering requestID must be nonblank and at most ${STEERING_REQUEST_ID_MAX_BYTES} UTF-8 bytes`,
          field: "requestID",
        })

      const sessionID = SessionID.make(ctx.params.sessionID)
      const child = yield* sessions.get(sessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      if (!child) return yield* notFound(`Task not found: ${ctx.params.sessionID}`)
      const parent = child.parentID
        ? yield* sessions.get(child.parentID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const projectID = (yield* InstanceState.context).project.id
      const rejection = steeringTargetRejection({
        child,
        parent,
        projectID,
        job: yield* background.get(sessionID),
      })
      if (rejection === "cross_project")
        return yield* new ForbiddenError({ message: "This task belongs to another project or workspace" })
      if (rejection === "not_child")
        return yield* new ConflictError({ message: "Only a child task session can accept user steering" })
      if (rejection === "not_running")
        return yield* new ConflictError({ message: "Only a running background task can accept user steering" })
      const parentSessionID = child.parentID
      if (!parentSessionID)
        return yield* new ConflictError({ message: "Only a child task session can accept user steering" })

      const sent = yield* Effect.try({
        try: () =>
          steerTaskFromUser({
            taskID: sessionID,
            parentSessionID,
            message: ctx.payload.message,
            requestID: ctx.payload.requestID,
          }),
        catch: (error) => new ConflictError({ message: error instanceof Error ? error.message : "Task steering failed" }),
      })

      // 261116 Red 先等父关联记录 trace：父记录失败不能返回成功；子消息的 delivery 随后
      // 读回真实值（prompt 子 fiber 仍可能在跑，不 join）。
      const traced = yield* Deferred.await(sent.trace).pipe(
        Effect.map(() => undefined),
        Effect.catch((error) => Effect.succeed(error)),
        Effect.timeoutOption(STEER_RECEIPT_TIMEOUT),
      )
      if (Option.isNone(traced))
        return yield* new TimeoutError({
          message: "Timed out waiting for the steering trace to be recorded",
          operation: "background.steer",
        })
      if (traced.value)
        return yield* new ConflictError({
          message: `Steering was accepted but its parent trace could not be recorded: ${traced.value.message}`,
        })

      const deadline = (yield* Clock.currentTimeMillis) + STEER_RECEIPT_TIMEOUT
      while (true) {
        const message = yield* MessageV2.get({ sessionID, messageID: sent.messageID }).pipe(
          Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
        )
        if (message?.info.role === "user")
          return {
            messageID: sent.messageID,
            state: message.info.delivery === "delivered" ? ("delivered" as const) : ("queued" as const),
          }
        if ((yield* Clock.currentTimeMillis) >= deadline)
          return yield* new TimeoutError({
            message: "Timed out reading the persisted steering message",
            operation: "background.steer",
          })
        yield* Effect.sleep(`${STEER_POLL_MS} millis`)
      }
    })

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
      .handle("steer", steer)
  }),
)
