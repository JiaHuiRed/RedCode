import { BackgroundJob } from "@/background/job"
import { SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { Context, Effect, Layer } from "effect"

export interface Interface {
  readonly cancelTree: (id: string) => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@redcode/BackgroundCancel") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service

    // 261105 Red 后台任务取消的唯一入口（审计 RC-015-01）：job.ts 的 cancelTree 只结束 job，
    // fiber 中断跑不到 processor 收尾的 status.set(idle)，被中断会话语义上仍是 busy/retry，
    // TUI/GUI 的等待指示器会永久旋转（261023 实证）。HTTP 后台面板与 task_status 共用本操作，
    // 新入口不许再各自复刻收尾逻辑。
    const cancelTree: Interface["cancelTree"] = Effect.fn("BackgroundCancel.cancelTree")(function* (id: string) {
      const cancelled = yield* jobs.cancelTree(id)
      yield* Effect.forEach(
        cancelled,
        (jobID) => {
          const sessionID = jobID as SessionID
          return status
            .get(sessionID)
            .pipe(
              Effect.flatMap((current) =>
                current.type === "idle" ? Effect.void : status.set(sessionID, { type: "idle" }),
              ),
            )
        },
        { discard: true },
      )
      return cancelled
    })

    return Service.of({ cancelTree })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
)

export * as BackgroundCancel from "./cancel"
