import { Effect, Ref, Context, Layer } from "effect"
import { MessageID } from "./schema"

// ---------- types ----------

export interface Snippet {
  readonly id: string
  readonly name: string
  readonly file: string
  readonly startLine: number
  readonly endLine: number
}

export interface Interface {
  readonly register: (messageID: MessageID, snippet: Snippet) => Effect.Effect<void>
  readonly get: (messageID: MessageID, snippetId: string) => Effect.Effect<Snippet | undefined>
  readonly clear: (messageID: MessageID) => Effect.Effect<void>
}

// ---------- service ----------

export class Service extends Context.Service<Service, Interface>()("@opencode/Snippet") {}

export const layer = Layer.effect(Service, Effect.gen(function* () {
  const store = yield* Ref.make(new Map<string, Map<string, Snippet>>())

  return Service.of({
    register: (messageID, snippet) =>
      Ref.update(store, (map) => {
        const existing = map.get(messageID) ?? new Map()
        existing.set(snippet.id, snippet)
        map.set(messageID, existing)
        return map
      }),
    get: (messageID, snippetId) =>
      Ref.get(store).pipe(Effect.map((map) => map.get(messageID)?.get(snippetId))),
    clear: (messageID) =>
      Ref.update(store, (map) => {
        map.delete(messageID)
        return map
      }),
  })
}))

export const defaultLayer = layer

export * as Snippet from "./snippet"
