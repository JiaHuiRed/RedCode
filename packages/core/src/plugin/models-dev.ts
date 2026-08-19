import { DateTime, Effect, Scope, Stream } from "effect"
import { Catalog } from "../catalog"
import { EventV2 } from "../event"
import { ModelV2 } from "../model"
import { ModelsDev } from "../models-dev"
import { PluginV2 } from "../plugin"
import { ProviderV2 } from "../provider"

function released(date: string) {
  const time = Date.parse(date)
  return DateTime.makeUnsafe(Number.isFinite(time) ? time : 0)
}

function cost(input: ModelsDev.Model["cost"]) {
  const base = {
    input: input?.input ?? 0,
    output: input?.output ?? 0,
    cache: {
      read: input?.cache_read ?? 0,
      write: input?.cache_write ?? 0,
    },
  }
  if (!input?.context_over_200k) return [base]
  return [
    base,
    {
      tier: {
        type: "context" as const,
        size: 200_000,
      },
      input: input.context_over_200k.input,
      output: input.context_over_200k.output,
      cache: {
        read: input.context_over_200k.cache_read ?? 0,
        write: input.context_over_200k.cache_write ?? 0,
      },
    },
  ]
}

function variants(model: ModelsDev.Model) {
  return Object.entries(model.experimental?.modes ?? {}).map(([id, item]) => ({
    id: ModelV2.VariantID.make(id),
    headers: { ...(item.provider?.headers ?? {}) },
    body: { ...(item.provider?.body ?? {}) },
    aisdk: {
      provider: {},
      request: {},
    },
  }))
}

export const ModelsDevPlugin = PluginV2.define({
  id: PluginV2.ID.make("models-dev"),
  effect: Effect.gen(function* () {
    const catalog = yield* Catalog.Service
    const modelsDev = yield* ModelsDev.Service
    const events = yield* EventV2.Service
    const scope = yield* Scope.Scope
    const load = yield* catalog.loader()
    const refresh = Effect.fn("ModelsDevPlugin.refresh")(function* () {
      const data = yield* modelsDev.get()
      yield* load((catalog) => {
        for (const item of Object.values(data)) {
          const providerID = ProviderV2.ID.make(item.id)
          catalog.provider.update(providerID, (provider) => {
            provider.name = item.name
            provider.env = [...item.env]
            provider.endpoint = item.npm
              ? {
                  type: "aisdk",
                  package: item.npm,
                  url: item.api,
                }
              : {
                  type: "unknown",
                }
          })

          for (const model of Object.values(item.models)) {
            const modelID = ModelV2.ID.make(model.id)
            catalog.model.update(providerID, modelID, (draft) => {
              draft.name = model.name
              draft.family = model.family ? ModelV2.Family.make(model.family) : undefined
              draft.endpoint = model.provider?.npm
                ? {
                    type: "aisdk",
                    package: model.provider?.npm,
                    url: model.provider.api,
                  }
                : {
                    type: "unknown",
                  }
              draft.capabilities = {
                tools: model.tool_call,
                input: [...(model.modalities?.input ?? [])],
                output: [...(model.modalities?.output ?? [])],
              }
              draft.variants = variants(model)
              draft.time.released = released(model.release_date)
              // 260615 Red: DeepSeek/Xiaomi use official CNY pricing (¥/M tokens).
              // Override models.dev USD values to avoid double-conversion precision loss.
              const cnyLookup: Record<
                string,
                Record<string, { input: number; output: number; cache: { read: number; write: number } }>
              > = {
                deepseek: {
                  "deepseek-v4-flash": { input: 1, output: 2, cache: { read: 0.02, write: 1 } },
                  "deepseek-v4-pro": { input: 3, output: 6, cache: { read: 0.025, write: 3 } },
                },
                xiaomi: {
                  "mimo-v2.5": { input: 1, output: 2, cache: { read: 0.02, write: 1 } },
                  "mimo-v2.5-pro": { input: 3, output: 6, cache: { read: 0.025, write: 3 } },
                  "mimo-v2-omni": { input: 1, output: 2, cache: { read: 0.02, write: 1 } },
                  "mimo-v2-pro": { input: 3, output: 6, cache: { read: 0.025, write: 3 } },
                },
              }
              const cnyCost = cnyLookup[item.id]?.[model.id]
              if (cnyCost) {
                draft.cost = [cnyCost]
              } else {
                draft.cost = cost(model.cost)
                // DeepSeek / MiMo (Xiaomi): 没有独立 cache write 价格，命不中都按 input 原价算
                if (item.id === "deepseek" || item.id === "xiaomi") {
                  for (const tier of draft.cost) {
                    if (tier.cache.write === 0 && tier.input > 0) {
                      tier.cache.write = tier.input
                    }
                  }
                }
              }
              draft.status = model.status ?? "active"
              draft.enabled = true
              draft.limit = {
                context: model.limit.context,
                input: model.limit.input,
                output: model.limit.output,
              }
            })
          }
        }
      })
    })
    yield* refresh()
    yield* events.subscribe(ModelsDev.Event.Refreshed).pipe(
      Stream.runForEach(() => refresh()),
      Effect.forkIn(scope, { startImmediately: true }),
    )
  }).pipe(Effect.provide(ModelsDev.defaultLayer)),
})
