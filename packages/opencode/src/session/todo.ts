import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { SessionID } from "./schema"
import { Effect, Layer, Context, Schema } from "effect"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"
import { asc } from "drizzle-orm"
import { TodoTable } from "./session.sql"

export const Info = Schema.Struct({
  // 260710 Red 层级子任务：id/parent_id 可选，兼容旧的纯扁平列表调用方
  id: Schema.optional(
    Schema.String.annotate({
      description: "Stable id for this item, e.g. '1' or '2.1'. Needed to nest sub-tasks under it via parent_id.",
    }),
  ),
  parent_id: Schema.optional(
    Schema.String.annotate({ description: "id of the parent item, to nest this item as its sub-task." }),
  ),
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.String.annotate({
    description: "Current status of the task: pending, in_progress, completed, cancelled",
  }),
  priority: Schema.String.annotate({ description: "Priority level of the task: high, medium, low" }),
}).annotate({ identifier: "Todo" })
export type Info = Schema.Schema.Type<typeof Info>

export const Event = {
  Updated: BusEvent.define(
    "todo.updated",
    Schema.Struct({
      sessionID: SessionID,
      todos: Schema.Array(Info),
    }),
  ),
}

export interface Interface {
  readonly update: (input: { sessionID: SessionID; todos: Info[] }) => Effect.Effect<void>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTodo") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const update = Effect.fn("Todo.update")(function* (input: { sessionID: SessionID; todos: Info[] }) {
      yield* Effect.sync(() =>
        Database.transaction((db) => {
          db.delete(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).run()
          if (input.todos.length === 0) return
          db.insert(TodoTable)
            .values(
              input.todos.map((todo, position) => ({
                session_id: input.sessionID,
                id: todo.id ?? null,
                parent_id: todo.parent_id ?? null,
                content: todo.content,
                status: todo.status,
                priority: todo.priority,
                position,
              })),
            )
            .run()
        }),
      )
      yield* bus.publish(Event.Updated, input)
    })

    const get = Effect.fn("Todo.get")(function* (sessionID: SessionID) {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db.select().from(TodoTable).where(eq(TodoTable.session_id, sessionID)).orderBy(asc(TodoTable.position)).all(),
        ),
      )
      return rows.map((row) => ({
        id: row.id ?? undefined,
        parent_id: row.parent_id ?? undefined,
        content: row.content,
        status: row.status,
        priority: row.priority,
      }))
    })

    return Service.of({ update, get })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as Todo from "./todo"
