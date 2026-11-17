import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Companion } from "@/companion/companion"
import { InstanceHttpApi } from "../api"
import { ConflictError, InvalidRequestError, UnknownError } from "../errors"

export const companionHandlers = HttpApiBuilder.group(InstanceHttpApi, "companion", (handlers) =>
  Effect.gen(function* () {
    const companion = yield* Companion.Service
    return handlers
      .handle("list", () =>
        companion.list().pipe(Effect.catch((error) => new UnknownError({ message: error.message }))),
      )
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
