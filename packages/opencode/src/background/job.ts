import { InstanceState } from "@/effect/instance-state"
import { Identifier } from "@/id/id"
import { Cause, Clock, Context, Deferred, Effect, Fiber, Layer, Scope, SynchronizedRef } from "effect"

export type Status = "running" | "completed" | "error" | "cancelled"

export type Info = {
  id: string
  type: string
  title?: string
  status: Status
  started_at: number
  completed_at?: number
  output?: string
  error?: string
  metadata?: Record<string, unknown>
}

type Active = {
  info: Info
  done: Deferred.Deferred<Info>
  fiber?: Fiber.Fiber<void, unknown>
}

type State = {
  jobs: SynchronizedRef.SynchronizedRef<Map<string, Active>>
  scope: Scope.Scope
}

type FinishResult = {
  info?: Info
  done?: Deferred.Deferred<Info>
}

export type StartInput = {
  id?: string
  type: string
  title?: string
  metadata?: Record<string, unknown>
  run: Effect.Effect<string, unknown>
}

export type WaitInput = {
  id: string
  timeout?: number
}

export type WaitResult = {
  info?: Info
  timedOut: boolean
}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly start: (input: StartInput) => Effect.Effect<Info>
  readonly wait: (input: WaitInput) => Effect.Effect<WaitResult>
  readonly cancel: (id: string) => Effect.Effect<Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@redcode/BackgroundJob") {}

function snapshot(job: Active): Info {
  return {
    ...job.info,
    ...(job.info.metadata ? { metadata: { ...job.info.metadata } } : {}),
  }
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

// 260909 Red 完成态任务保留 30 分钟 / 全程至多 50 条，起任务时顺带回收——output 是
// 子代理的完整输出文本（可达数 MB），此前 jobs Map 只进不出，长驻 sidecar 进程里
// 每个后台任务永久滞留一份全文。运行中的任务永不触碰；已持有 done Deferred 引用的
// waiter 不受回收影响（对象按引用存活）。
const FINISHED_TTL_MS = 30 * 60 * 1000
const FINISHED_MAX = 50

function prune(jobs: Map<string, Active>, now: number): Map<string, Active> {
  const next = new Map(jobs)
  const finished: Array<{ id: string; at: number }> = []
  for (const [id, job] of next) {
    if (job.info.status === "running") continue
    const at = job.info.completed_at ?? job.info.started_at
    if (now - at > FINISHED_TTL_MS) {
      next.delete(id)
      continue
    }
    finished.push({ id, at })
  }
  if (finished.length > FINISHED_MAX) {
    finished
      .sort((a, b) => a.at - b.at)
      .slice(0, finished.length - FINISHED_MAX)
      .forEach(({ id }) => next.delete(id))
  }
  return next
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make<State>(
      Effect.fn("BackgroundJob.state")(function* () {
        return {
          jobs: yield* SynchronizedRef.make(new Map()),
          scope: yield* Scope.Scope,
        }
      }),
    )

    const finish = Effect.fn("BackgroundJob.finish")(function* (
      id: string,
      status: Exclude<Status, "running">,
      data?: { output?: string; error?: string },
    ) {
      const completed_at = yield* Clock.currentTimeMillis
      const result = yield* SynchronizedRef.modify(
        (yield* InstanceState.get(state)).jobs,
        (jobs): readonly [FinishResult, Map<string, Active>] => {
          const job = jobs.get(id)
          if (!job) return [{}, jobs]
          if (job.info.status !== "running") return [{ info: snapshot(job) }, jobs]
          const next = {
            ...job,
            fiber: undefined,
            info: {
              ...job.info,
              status,
              completed_at,
              ...(data?.output !== undefined ? { output: data.output } : {}),
              ...(data?.error !== undefined ? { error: data.error } : {}),
            },
          }
          // 260909 Red 完成态在 finish 侧也裁一次：只靠 start 侧裁会稳定超出 1 条。
          // 注意先把完成态放进 Map 再 prune——先裁后 set 等于没裁
          return [{ info: snapshot(next), done: job.done }, prune(new Map(jobs).set(id, next), completed_at)]
        },
      )
      if (result.info && result.done) yield* Deferred.succeed(result.done, result.info).pipe(Effect.ignore)
      return result.info
    })

    const list: Interface["list"] = Effect.fn("BackgroundJob.list")(function* () {
      return Array.from((yield* SynchronizedRef.get((yield* InstanceState.get(state)).jobs)).values())
        .map(snapshot)
        .toSorted((a, b) => a.started_at - b.started_at)
    })

    const get: Interface["get"] = Effect.fn("BackgroundJob.get")(function* (id) {
      const job = (yield* SynchronizedRef.get((yield* InstanceState.get(state)).jobs)).get(id)
      if (!job) return
      return snapshot(job)
    })

    const start: Interface["start"] = Effect.fn("BackgroundJob.start")(function* (input) {
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const s = yield* InstanceState.get(state)
          const id = input.id ?? Identifier.ascending("job")
          const started_at = yield* Clock.currentTimeMillis
          const done = yield* Deferred.make<Info>()
          return yield* SynchronizedRef.modifyEffect(
            s.jobs,
            Effect.fnUntraced(function* (jobs) {
              const existing = jobs.get(id)
              if (existing?.info.status === "running") return [snapshot(existing), jobs] as const
              const fiber = yield* restore(input.run).pipe(
                Effect.matchCauseEffect({
                  onSuccess: (output) => finish(id, "completed", { output }),
                  onFailure: (cause) =>
                    finish(id, Cause.hasInterruptsOnly(cause) ? "cancelled" : "error", {
                      error: errorText(Cause.squash(cause)),
                    }),
                }),
                Effect.asVoid,
                Effect.forkIn(s.scope, { startImmediately: true }),
              )
              const job = {
                info: {
                  id,
                  type: input.type,
                  title: input.title,
                  status: "running" as const,
                  started_at,
                  metadata: input.metadata,
                },
                done,
                fiber,
              }
              return [snapshot(job), prune(jobs, started_at).set(id, job)] as const
            }),
          )
        }),
      )
    })

    const wait: Interface["wait"] = Effect.fn("BackgroundJob.wait")(function* (input) {
      const job = (yield* SynchronizedRef.get((yield* InstanceState.get(state)).jobs)).get(input.id)
      if (!job) return { timedOut: false }
      if (job.info.status !== "running") return { info: snapshot(job), timedOut: false }
      if (input.timeout === undefined) return { info: yield* Deferred.await(job.done), timedOut: false }
      if (input.timeout <= 0) return { info: snapshot(job), timedOut: true }
      const info = yield* Deferred.await(job.done).pipe(Effect.timeoutOption(input.timeout))
      if (info._tag === "Some") return { info: info.value, timedOut: false }
      return { info: snapshot(job), timedOut: true }
    })

    const cancel: Interface["cancel"] = Effect.fn("BackgroundJob.cancel")(function* (id) {
      const job = (yield* SynchronizedRef.get((yield* InstanceState.get(state)).jobs)).get(id)
      if (!job) return
      if (job.info.status !== "running") return snapshot(job)
      if (job.fiber) {
        yield* Fiber.interrupt(job.fiber).pipe(Effect.ignore)
        yield* Fiber.await(job.fiber).pipe(Effect.ignore)
      }
      const info = yield* finish(id, "cancelled")
      return info
    })

    return Service.of({ list, get, start, wait, cancel })
  }),
)

export const defaultLayer = layer

export * as BackgroundJob from "./job"
