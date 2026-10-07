import { Soul } from "@/soul"
import { resolveDefaultSoul } from "@/session/session"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const soulHandlers = HttpApiBuilder.group(InstanceHttpApi, "soul", (handlers) =>
  Effect.gen(function* () {
    const soul = yield* Soul.Service
    return handlers
      .handle("list", () => soul.list())
      .handle("issues", () => soul.issues())
      .handle("default", ({ query }) =>
        resolveDefaultSoul(soul, query.client).pipe(Effect.map((id) => (id === undefined ? {} : { id }))),
      )
  }),
)
