import { BackgroundJob } from "@/background/job"
import { SessionID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { Context, Effect, Layer } from "effect"

export interface Interface {
  readonly cancelTree: (id: string) => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@redcode/BackgroundCancel") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    const runState = yield* SessionRunState.Service

    // 261105 Red 后台任务取消的唯一入口（审计 RC-015-01）：job.ts 的 cancelTree 只结束 job，
    // fiber 中断跑不到 processor 收尾的 status.set(idle)，被中断会话语义上仍是 busy/retry，
    // TUI/GUI 的等待指示器会永久旋转（261023 实证）。HTTP 后台面板与 task_status 共用本操作，
    // 新入口不许再各自复刻收尾逻辑。
    // 261107 Red 归位不能只写状态表：job.cancelTree 中断的是等 Deferred 的外壳 fiber，
    // 真正的模型循环 fork 在 SessionRunState 的 runner scope 里。只归位会让面板显示
    // 「已取消」而子会话继续发请求、写文件（261107 实测）。按被取消的 job id（= 会话 id）
    // 走 SessionRunState.cancel，由它停 runner 并归位状态，同时级联嵌套子任务。
    const cancelTree: Interface["cancelTree"] = Effect.fn("BackgroundCancel.cancelTree")(function* (id: string) {
      const cancelled = yield* jobs.cancelTree(id)
      yield* Effect.forEach(cancelled, (jobID) => runState.cancel(jobID as SessionID), { discard: true })
      return cancelled
    })

    return Service.of({ cancelTree })
  }),
)

// 261107 Red provide 链内的服务对上层不可见，BackgroundJob 必须与 SessionRunState 一起显式合并；
// 两者是同一 layer 引用，memoMap 会去重成一份实例。
export const defaultLayer = layer.pipe(
  Layer.provide(Layer.mergeAll(BackgroundJob.defaultLayer, SessionRunState.defaultLayer)),
)

export * as BackgroundCancel from "./cancel"
