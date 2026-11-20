import { createMemo, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { DateTime } from "luxon"
import { filter, firstBy, flat, groupBy, mapValues, pipe, uniqueBy, values } from "remeda"
import { createSimpleContext } from "@redcode-ai/ui/context"
import { useServer } from "@/context/server"
import { useGlobalSDK } from "@/context/global-sdk"
import { useProviders } from "@/hooks/use-providers"
import { Persist, persisted } from "@/utils/persist"

export type ModelKey = { providerID: string; modelID: string }

type Visibility = "show" | "hide"
type User = ModelKey & { visibility: Visibility; favorite?: boolean }
type Store = {
  chat?: Record<string, (ModelKey & { variant?: string }) | null>
  user: User[]
  recent: ModelKey[]
  variant?: Record<string, string | undefined>
}

const RECENT_LIMIT = 5

function modelKey(model: ModelKey) {
  return `${model.providerID}:${model.modelID}`
}

function modelCatalog(providers: ReturnType<typeof useProviders>, visibility: (key: string) => Visibility | undefined) {
  const available = createMemo(() => {
    const connected = new Set(providers.connected().map((p) => p.id))
    return [...providers.all().values()]
      .filter((p) => connected.has(p.id))
      .flatMap((p) =>
        Object.values(p.models).map((m) => ({
          ...m,
          provider: p,
        })),
      )
  })

  const release = createMemo(
    () =>
      new Map(
        available().map((model) => {
          const parsed = DateTime.fromISO(model.release_date)
          return [modelKey({ providerID: model.provider.id, modelID: model.id }), parsed] as const
        }),
      ),
  )

  const latest = createMemo(() =>
    pipe(
      available(),
      filter(
        (x) =>
          Math.abs(
            (release().get(modelKey({ providerID: x.provider.id, modelID: x.id })) ?? DateTime.invalid("invalid"))
              .diffNow()
              .as("months"),
          ) < 6,
      ),
      groupBy((x) => x.provider.id),
      mapValues((models) =>
        pipe(
          models,
          groupBy((x) => x.family),
          values(),
          (groups) =>
            groups.flatMap((g) => {
              const first = firstBy(g, [(x) => x.release_date, "desc"])
              return first ? [{ modelID: first.id, providerID: first.provider.id }] : []
            }),
        ),
      ),
      values(),
      flat(),
    ),
  )

  const latestSet = createMemo(() => new Set(latest().map((x) => modelKey(x))))

  const list = createMemo(() =>
    available().map((m) => ({
      ...m,
      name: m.name.replace("(latest)", "").trim(),
      latest: m.name.includes("(latest)"),
    })),
  )

  const find = (key: ModelKey) => list().find((m) => m.id === key.modelID && m.provider.id === key.providerID)

  const visible = (model: ModelKey) => {
    const key = modelKey(model)
    const state = visibility(key)
    if (state === "hide") return false
    if (state === "show") return true
    if (latestSet().has(key)) return true
    const date = release().get(key)
    if (!date?.isValid) return true
    return false
  }

  return { list, find, visible, ready: providers.ready }
}

export const { use: useModels, provider: ModelsProvider } = createSimpleContext({
  name: "Models",
  init: () => {
    const providers = useProviders()
    const sdk = useGlobalSDK()
    const server = useServer()
    const chatKey = (directory: string) => JSON.stringify([server.key ?? sdk.url, directory])

    const [store, setStore, _, ready] = persisted(
      Persist.global("model", ["model.v1"]),
      createStore<Store>({
        user: [],
        recent: [],
        variant: {},
      }),
    )

    const visibility = createMemo(() => {
      const map = new Map<string, Visibility>()
      for (const item of store.user) map.set(`${item.providerID}:${item.modelID}`, item.visibility)
      return map
    })

    const catalog = (source: ReturnType<typeof useProviders>) => modelCatalog(source, (key) => visibility().get(key))
    const { list, find, visible } = catalog(providers)

    function update(model: ModelKey, state: Visibility) {
      const index = store.user.findIndex((x) => x.modelID === model.modelID && x.providerID === model.providerID)
      if (index >= 0) {
        setStore("user", index, (current) => ({ ...current, visibility: state }))
        return
      }
      setStore("user", store.user.length, { ...model, visibility: state })
    }

    const setVisibility = (model: ModelKey, state: boolean) => {
      update(model, state ? "show" : "hide")
    }

    const push = (model: ModelKey) => {
      const uniq = uniqueBy([model, ...store.recent], (x) => `${x.providerID}:${x.modelID}`)
      if (uniq.length > RECENT_LIMIT) uniq.pop()
      setStore("recent", uniq)
    }

    const variantKey = (model: ModelKey) => `${model.providerID}/${model.modelID}`
    const getVariant = (model: ModelKey) => store.variant?.[variantKey(model)]

    const setVariant = (model: ModelKey, value: string | undefined) => {
      const key = variantKey(model)
      if (!store.variant) {
        setStore("variant", { [key]: value })
        return
      }
      setStore("variant", key, value)
    }

    return {
      ready,
      list,
      find,
      visible,
      setVisibility,
      catalog,
      chat: {
        get: (directory: string) => store.chat?.[chatKey(directory)],
        set(directory: string, choice: (ModelKey & { variant?: string }) | null) {
          const key = chatKey(directory)
          const previous = untrack(() => store.chat?.[key])
          if (
            previous === choice ||
            (previous &&
              choice &&
              previous.providerID === choice.providerID &&
              previous.modelID === choice.modelID &&
              previous.variant === choice.variant)
          )
            return
          // Replace the whole entry so resetting effort cannot merge an old variant back in.
          setStore("chat", (previous) => ({ ...previous, [key]: choice }))
        },
      },
      recent: {
        list: createMemo(() => store.recent),
        push,
      },
      variant: {
        get: getVariant,
        set: setVariant,
      },
    }
  },
})
