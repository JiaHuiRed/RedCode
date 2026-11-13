import { Soul } from "@/soul"
import { resolveDefaultSoul } from "@/session/session"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { InstanceHttpApi } from "../api"
import { ConflictError, InvalidRequestError, UnknownError, notFound } from "../errors"

// 261113 Red payload 在 OpenAPI 层是宽松对象（见 groups/soul.ts 的说明），互斥与必填在这里
// 显式判定：markdown 与结构化字段混用一律 400，不能静默忽略其中一支。
function toCreateInput(payload: {
  id?: string
  name?: string
  displayName?: string
  commitPrefix?: string
  avatar?: string
  description?: string
  content?: string
  markdown?: string
}): Soul.CreateInput | InvalidRequestError {
  if (payload.markdown !== undefined) {
    const mixed = [payload.id, payload.name, payload.displayName, payload.commitPrefix, payload.avatar, payload.description, payload.content]
    if (mixed.some((value) => value !== undefined))
      return new InvalidRequestError({
        message: "markdown cannot be combined with structured fields",
        field: "markdown",
      })
    return { markdown: payload.markdown }
  }
  if (payload.id === undefined || payload.name === undefined || payload.content === undefined)
    return new InvalidRequestError({
      message: "id, name and content are required unless markdown is provided",
      field: payload.id === undefined ? "id" : payload.name === undefined ? "name" : "content",
    })
  return {
    id: payload.id,
    name: payload.name,
    content: payload.content,
    ...(payload.displayName === undefined ? {} : { displayName: payload.displayName }),
    ...(payload.commitPrefix === undefined ? {} : { commitPrefix: payload.commitPrefix }),
    ...(payload.avatar === undefined ? {} : { avatar: payload.avatar }),
    ...(payload.description === undefined ? {} : { description: payload.description }),
  }
}

export const soulHandlers = HttpApiBuilder.group(InstanceHttpApi, "soul", (handlers) =>
  Effect.gen(function* () {
    const soul = yield* Soul.Service
    return handlers
      .handle("list", () => soul.list())
      .handle("get", ({ params }) =>
        Effect.flatMap(soul.details(params.id), (details) =>
          details ? Effect.succeed(details) : Effect.fail(notFound(`Soul "${params.id}" not found`)),
        ),
      )
      .handle("issues", () => soul.issues())
      .handle("default", ({ query }) =>
        resolveDefaultSoul(soul, query.client).pipe(Effect.map((id) => (id === undefined ? {} : { id }))),
      )
      .handle("create", ({ payload }) => {
        const input = toCreateInput(payload)
        if (input instanceof InvalidRequestError) return Effect.fail(input)
        return soul.create(input).pipe(
          Effect.catchTag("SoulInvalidInput", (error) =>
            new InvalidRequestError({ message: error.message, field: error.field }),
          ),
          Effect.catchTag("SoulConflict", (error) =>
            new ConflictError({ message: error.message, resource: "soul" }),
          ),
          Effect.catchTag("SoulIO", (error) => new UnknownError({ message: error.message })),
        )
      })
  }),
)
