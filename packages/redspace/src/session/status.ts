import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "./schema"
import { NonNegativeInt } from "@redcode-ai/core/schema"
import { Clock, Effect, Layer, Context, Schema } from "effect"

export const Info = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("idle"),
  }),
  Schema.Struct({
    type: Schema.Literal("retry"),
    attempt: NonNegativeInt,
    message: Schema.String,
    action: Schema.optional(
      Schema.Struct({
        reason: Schema.String,
        provider: Schema.String,
        title: Schema.String,
        message: Schema.String,
        label: Schema.String,
        link: Schema.optional(Schema.String),
      }),
    ),
    next: NonNegativeInt,
    // 261023 Red 进入本状态段的时刻（毫秒）。同类型重写保留段起点，见 set 内注释。
    since: Schema.optional(NonNegativeInt),
  }),
  Schema.Struct({
    type: Schema.Literal("busy"),
    since: Schema.optional(NonNegativeInt),
  }),
]).annotate({ identifier: "SessionStatus" })
export type Info = Schema.Schema.Type<typeof Info>

export const Event = {
  Status: BusEvent.define(
    "session.status",
    Schema.Struct({
      sessionID: SessionID,
      status: Info,
    }),
  ),
  // deprecated
  Idle: BusEvent.define(
    "session.idle",
    Schema.Struct({
      sessionID: SessionID,
    }),
  ),
}

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Map<SessionID, Info>>
  readonly set: (sessionID: SessionID, status: Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@redcode/SessionStatus") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionStatus.state")(() => Effect.succeed(new Map<SessionID, Info>())),
    )

    const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.get(sessionID) ?? { type: "idle" as const }
    })

    const list = Effect.fn("SessionStatus.list")(function* () {
      return new Map(yield* InstanceState.get(state))
    })

  const set = Effect.fn("SessionStatus.set")(function* (sessionID: SessionID, status: Info) {
    const data = yield* InstanceState.get(state)
    if (status.type === "idle") {
      yield* bus.publish(Event.Status, { sessionID, status })
      yield* bus.publish(Event.Idle, { sessionID })
      data.delete(sessionID)
      return
    }
    // 261023 Red 状态段打点：同类型重写保留段起点——retry 每个 attempt 都会 set 一次，
    // 段起点即这轮重试循环的开始；busy↔retry 切换才算新段，新段尊重调用方显式给的
    // since（生产写入方不传，测试用它种入「早已开始的段」）。消费方是 task_status 的
    // 「子代理在同一状态卡了多久」警告，见 tool/task_status.ts。
    const now = yield* Clock.currentTimeMillis
    const previous = data.get(sessionID)
    const continuing = previous && previous.type === status.type && "since" in previous
    const since = continuing ? ((previous as { since?: number }).since ?? now) : (status.since ?? now)
    const stamped = { ...status, since } as Info
    yield* bus.publish(Event.Status, { sessionID, status: stamped })
    data.set(sessionID, stamped)
  })

    return Service.of({ get, list, set })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as SessionStatus from "./status"
