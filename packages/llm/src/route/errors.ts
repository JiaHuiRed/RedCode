import { Effect, Schema } from "effect"
import { InvalidProviderOutputReason, InvalidRequestReason, LLMError } from "../schema"

const Json = Schema.fromJsonString(Schema.Unknown)
export const encodeJson = Schema.encodeSync(Json)

const invalidRequest = (message: string) =>
  new LLMError({
    module: "ProviderShared",
    method: "request",
    reason: new InvalidRequestReason({ message }),
  })

export const eventError = (route: string, message: string, raw?: string) =>
  new LLMError({
    module: "ProviderShared",
    method: "stream",
    reason: new InvalidProviderOutputReason({ route, message, raw }),
  })

export const validateWith =
  <A, I, E extends { readonly message: string }, R>(decode: (input: I) => Effect.Effect<A, E, R>) =>
  (payload: I) =>
    decode(payload).pipe(Effect.mapError((error) => invalidRequest(error.message)))
