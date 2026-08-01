import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { SessionID } from "./schema"
import { Effect, Layer, Context, Schema } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@/storage/db"
import { GoalTable } from "./session.sql"

// 260801 Red Goal 状态服务：/goal 从纯 prompt 指令升级为落库状态。
// 一个 session 一个 goal（session_id 主键）。tokens_used/turn_count 供
// 自动续跑的预算与轮次上限使用（goal-continuation.ts）。

export const Status = Schema.Literals(["active", "done", "cleared", "blocked", "budget_limited"])
export type Status = Schema.Schema.Type<typeof Status>

export const Info = Schema.Struct({
  text: Schema.String.annotate({ description: "The pinned session goal" }),
  status: Status,
  tokens_used: Schema.Number,
  turn_count: Schema.Number,
}).annotate({ identifier: "Goal" })
export type Info = Schema.Schema.Type<typeof Info>

export const Event = {
  Updated: BusEvent.define(
    "goal.updated",
    Schema.Struct({
      sessionID: SessionID,
      goal: Schema.optional(Info),
    }),
  ),
}

export interface Interface {
  readonly set: (input: { sessionID: SessionID; text: string }) => Effect.Effect<void>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly clear: (sessionID: SessionID) => Effect.Effect<void>
  readonly done: (sessionID: SessionID) => Effect.Effect<void>
  readonly mark: (sessionID: SessionID, status: Exclude<Status, "active" | "done" | "cleared">) => Effect.Effect<void>
  readonly addUsage: (input: { sessionID: SessionID; tokens: number }) => Effect.Effect<void>
  readonly tick: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionGoal") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const get = Effect.fn("Goal.get")(function* (sessionID: SessionID) {
      const row = yield* Effect.sync(() =>
        Database.use((db) =>
          db.select().from(GoalTable).where(eq(GoalTable.session_id, sessionID)).get(),
        ),
      )
      if (!row) return undefined
      return {
        text: row.text,
        status: row.status as Status,
        tokens_used: row.tokens_used,
        turn_count: row.turn_count,
      }
    })

    const publish = Effect.fn("Goal.publish")(function* (sessionID: SessionID) {
      const goal = yield* get(sessionID)
      yield* bus.publish(Event.Updated, { sessionID, goal })
    })

    const set = Effect.fn("Goal.set")(function* (input: { sessionID: SessionID; text: string }) {
      const text = input.text.trim()
      if (!text) return
      yield* Effect.sync(() =>
        Database.transaction((db) => {
          db.delete(GoalTable).where(eq(GoalTable.session_id, input.sessionID)).run()
          db.insert(GoalTable)
            .values({
              session_id: input.sessionID,
              text,
              status: "active",
              tokens_used: 0,
              turn_count: 0,
            })
            .run()
        }),
      )
      yield* publish(input.sessionID)
    })

    const clear = Effect.fn("Goal.clear")(function* (sessionID: SessionID) {
      yield* Effect.sync(() =>
        Database.transaction((db) => {
          db.delete(GoalTable).where(eq(GoalTable.session_id, sessionID)).run()
        }),
      )
      yield* publish(sessionID)
    })

    const done = Effect.fn("Goal.done")(function* (sessionID: SessionID) {
      yield* Effect.sync(() =>
        Database.transaction((db) => {
          db.update(GoalTable)
            .set({ status: "done" })
            .where(eq(GoalTable.session_id, sessionID))
            .run()
        }),
      )
      yield* publish(sessionID)
    })

    const mark = Effect.fn("Goal.mark")(function* (
      sessionID: SessionID,
      status: Exclude<Status, "active" | "done" | "cleared">,
    ) {
      yield* Effect.sync(() =>
        Database.transaction((db) => {
          db.update(GoalTable)
            .set({ status })
            .where(eq(GoalTable.session_id, sessionID))
            .run()
        }),
      )
      yield* publish(sessionID)
    })

    const addUsage = Effect.fn("Goal.addUsage")(function* (input: { sessionID: SessionID; tokens: number }) {
      if (!Number.isFinite(input.tokens) || input.tokens <= 0) return
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(GoalTable)
            .set({ tokens_used: sql`${GoalTable.tokens_used} + ${Math.round(input.tokens)}` })
            .where(eq(GoalTable.session_id, input.sessionID))
            .run(),
        ),
      )
    })

    const tick = Effect.fn("Goal.tick")(function* (sessionID: SessionID) {
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .update(GoalTable)
            .set({ turn_count: sql`${GoalTable.turn_count} + 1` })
            .where(eq(GoalTable.session_id, sessionID))
            .run(),
        ),
      )
    })

    return Service.of({ set, get, clear, done, mark, addUsage, tick })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as Goal from "./goal"
