import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Companion } from "@/companion/companion"
import { InstanceHttpApi } from "../api"
import { ConflictError, InvalidRequestError, UnknownError, notFound } from "../errors"

const settingsResult = <A>(effect: Effect.Effect<A, Companion.Error>) =>
  effect.pipe(
    Effect.catchTag("CompanionInvalidInput", (error) => new InvalidRequestError({ message: error.message })),
    Effect.catchTag(
      "CompanionConflict",
      (error) => new ConflictError({ message: error.message, resource: "companion" }),
    ),
    Effect.catchTag("CompanionNotFound", (error) => notFound(error.message)),
    Effect.catchTag("CompanionIO", (error) => new UnknownError({ message: error.message })),
  )

export const companionHandlers = HttpApiBuilder.group(InstanceHttpApi, "companion", (handlers) =>
  Effect.gen(function* () {
    const companion = yield* Companion.Service
    return handlers
      .handle("list", () =>
        companion.list().pipe(Effect.catch((error) => new UnknownError({ message: error.message }))),
      )
      .handle("initialize", () => settingsResult(companion.initialize()))
      .handle("create", ({ payload }) => settingsResult(companion.create(payload)))
      .handle("get", ({ params }) => settingsResult(companion.details(params.id)))
      .handle("update", ({ params, payload }) => settingsResult(companion.update(params.id, payload)))
      .handle("import", ({ payload }) =>
        companion.importArchive(payload).pipe(
          Effect.catchTag(
            "CompanionInvalidInput",
            (error) => new InvalidRequestError({ message: error.message, field: "source" }),
          ),
          Effect.catchTag(
            "CompanionConflict",
            (error) => new ConflictError({ message: error.message, resource: "companion" }),
          ),
          Effect.catchTag("CompanionIO", (error) => new UnknownError({ message: error.message })),
          Effect.catchTag(
            "CompanionNotFound",
            (error) => new InvalidRequestError({ message: error.message, field: "source" }),
          ),
        ),
      )
  }),
)
