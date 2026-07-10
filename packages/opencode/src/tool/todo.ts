import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION_READ from "./todoread.md"
import DESCRIPTION_WRITE from "./todowrite.md"
import { Todo } from "../session/todo"

// Todo.Info is still a zod schema (session/todo.ts). Inline the field shape
// here rather than referencing its `.shape` — the LLM-visible JSON Schema is
// identical, and it removes the last zod dependency from this tool.
// 260710 Red id/parent_id 可选：不填=旧的纯扁平列表；填了=可表达层级子任务
const TodoItem = Schema.Struct({
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
})

export const Parameters = Schema.Struct({
  todos: Schema.mutable(Schema.Array(TodoItem)).annotate({ description: "The updated todo list" }),
})

type Metadata = {
  todos: Todo.Info[]
}

export const TodoWriteTool = Tool.define<typeof Parameters, Metadata, Todo.Service>(
  "todowrite",
  Effect.gen(function* () {
    const todo = yield* Todo.Service

    return {
      description: DESCRIPTION_WRITE,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "todowrite",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          yield* todo.update({
            sessionID: ctx.sessionID,
            todos: params.todos,
          })

          return {
            title: `${params.todos.filter((x) => x.status !== "completed").length} todos`,
            output: JSON.stringify(params.todos, null, 2),
            metadata: {
              todos: params.todos,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)

const ReadParams = Schema.Struct({})

type ReadMetadata = {
  todos: Todo.Info[]
  summary: string
}

export const TodoReadTool = Tool.define<typeof ReadParams, ReadMetadata, Todo.Service>(
  "todoread",
  Effect.gen(function* () {
    const todo = yield* Todo.Service

    return {
      description: DESCRIPTION_READ,
      parameters: ReadParams,
      execute: (_params: Schema.Schema.Type<typeof ReadParams>, ctx: Tool.Context<ReadMetadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "todowrite",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          const todos = yield* todo.get(ctx.sessionID)
          const total = todos.length
          const done = todos.filter((t) => t.status === "completed").length
          const active = todos.filter((t) => t.status === "in_progress").length
          const pending = todos.filter((t) => t.status === "pending").length
          const summary = `${total} total · ${done} done · ${active} active · ${pending} pending`

          return {
            title: `${total} todos`,
            output: JSON.stringify(todos, null, 2),
            metadata: { todos, summary },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof ReadParams, ReadMetadata>
  }),
)
