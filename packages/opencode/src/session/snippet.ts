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

// 260709 Red snippet store：register 按 messageID 分桶（支持按消息清理），
// get 跨所有 messageID 搜索（snippet 工具的 messageID ≠ read 工具的 messageID）。
// 同名 snippetId 后注册的覆盖先注册的（文件重读后自然更新）。
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
    get: (_messageID, snippetId) =>
      Ref.get(store).pipe(Effect.map((map) => {
        // 260709 Red 跨所有 messageID 搜索，后注册的优先（遍历顺序=插入顺序，取最后命中）
        let found: Snippet | undefined
        for (const bucket of map.values()) {
          const hit = bucket.get(snippetId)
          if (hit) found = hit
        }
        return found
      })),
    clear: (messageID) =>
      Ref.update(store, (map) => {
        map.delete(messageID)
        return map
      }),
  })
}))

export const defaultLayer = layer

export * as Snippet from "./snippet"
