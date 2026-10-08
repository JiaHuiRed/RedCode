import { Button } from "@redcode-ai/ui/button"
import { TextField } from "@redcode-ai/ui/text-field"
import { useQuery } from "@tanstack/solid-query"
import { useParams } from "@solidjs/router"
import { createMemo, For, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { useSettings } from "@/context/settings"
import { decode64 } from "@/utils/base64"
import { SoulAvatar } from "./soul-avatar"
import { SoulAvatarPicker } from "./soul-avatar-picker"

export const SettingsPersonalization: Component = () => {
  const language = useLanguage()
  const settings = useSettings()
  const sdk = useGlobalSDK()
  const platform = usePlatform()
  const server = useServer()
  const sync = useServerSync()
  const params = useParams()
  const [view, setView] = createStore({ selectedId: "", search: "", feedback: "", error: "" })

  const souls = useQuery(() => ({
    queryKey: ["soul", sdk.url, "list"],
    queryFn: async () => (await sdk.client.soul.list({ throwOnError: true })).data,
  }))
  const issues = useQuery(() => ({
    queryKey: ["soul", sdk.url, "issues"],
    queryFn: async () => (await sdk.client.soul.issues({ throwOnError: true })).data,
  }))
  const serverDefault = useQuery(() => ({
    queryKey: ["soul", sdk.url, "default", "desktop"],
    queryFn: async () => (await sdk.client.soul.default({ client: "desktop" }, { throwOnError: true })).data,
  }))

  const saved = () => settings.personalization.lastSoul()
  const effectiveDefaultId = () => (saved() ? saved() : serverDefault.data?.id)
  const soulsList = () => souls.data ?? []
  const defaultSoul = createMemo(() => soulsList().find((soul) => soul.id === effectiveDefaultId()))
  const selected = createMemo(() => soulsList().find((soul) => soul.id === view.selectedId))
  const filtered = createMemo(() => {
    const query = view.search.trim().toLocaleLowerCase()
    if (!query) return soulsList()
    return soulsList().filter((soul) =>
      [soul.displayName, soul.name, soul.id, soul.description, soul.commitPrefix]
        .some((value) => value?.toLocaleLowerCase().includes(query)),
    )
  })

  const detail = useQuery(() => ({
    queryKey: ["soul", sdk.url, "detail", view.selectedId],
    enabled: !!view.selectedId,
    queryFn: async () => (await sdk.client.soul.get({ id: view.selectedId }, { throwOnError: true })).data,
  }))

  const directory = createMemo(() => (params.dir ? decode64(params.dir) : undefined))
  const sessionSoulId = createMemo(() => {
    const id = params.id
    const dir = directory()
    if (!id || !dir) return undefined
    return sync.child(dir, { bootstrap: false })[0].session.find((session) => session.id === id)?.soul
  })
  const currentSessionKnown = createMemo(() => {
    const id = params.id
    const dir = directory()
    if (!id || !dir) return false
    return !!sync.peek(dir, { bootstrap: false })[0].session.find((session) => session.id === id)
  })

  const selectSoul = (id: string) => {
    setView({ selectedId: id, feedback: "", error: "" })
  }
  const setDefault = (id: string) => {
    settings.personalization.setLastSoul(id)
    setView("feedback", language.t("settings.personalization.saved"))
    setView("error", "")
  }
  const useServerDefault = () => {
    settings.personalization.setLastSoul("")
    setView("feedback", language.t("settings.personalization.saved"))
    setView("error", "")
  }
  const sourceFor = (field: keyof NonNullable<typeof detail.data>["sources"]) => detail.data?.sources[field] ?? "absent"
  const sourceLabel = (field: keyof NonNullable<typeof detail.data>["sources"]) =>
    language.t(
      sourceFor(field) === "frontmatter"
        ? "settings.personalization.sourceFrontmatter"
        : sourceFor(field) === "absent"
          ? "settings.personalization.sourceAbsent"
          : "settings.personalization.sourceFallback",
    )
  const openSource = () => {
    const path = detail.data?.path
    if (!path || platform.platform !== "desktop" || !platform.openPath || !server.isLocal()) return
    void platform.openPath(path).catch((error: unknown) => {
      setView("error", error instanceof Error ? error.message : String(error))
    })
  }
  const copySource = () => {
    const path = detail.data?.path
    if (!path || typeof navigator === "undefined" || !navigator.clipboard?.writeText) return
    void navigator.clipboard.writeText(path).then(
      () => setView("feedback", language.t("settings.personalization.pathCopied")),
      (error: unknown) => setView("error", error instanceof Error ? error.message : String(error)),
    )
  }

  return (
    <div class="flex h-full flex-col overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10">
      <header class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex max-w-[1000px] flex-col gap-1 pt-6 pb-8">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.personalization.title")}</h2>
          <p class="text-14-regular text-text-weak">{language.t("settings.personalization.description")}</p>
        </div>
      </header>

      <main class="flex max-w-[1000px] flex-col gap-6">
        <section class="flex flex-col gap-3 rounded-lg border border-border-weak-base bg-surface-base p-4">
          <div class="flex items-center justify-between gap-4">
            <div>
              <h3 class="text-14-medium text-text-strong">{language.t("settings.personalization.defaultSoul")}</h3>
              <p class="mt-1 text-12-regular text-text-weak">{language.t("settings.personalization.defaultSoulDescription")}</p>
            </div>
            <span class="rounded-full bg-surface-raised-base px-2 py-1 text-12-medium text-text-weak">
              {language.t("settings.personalization.defaultBadge")}
            </span>
          </div>
          <Show when={souls.isPending || serverDefault.isPending}>
            <p aria-live="polite" class="text-14-regular text-text-weak">{language.t("common.loading")}</p>
          </Show>
          <Show when={souls.isError || serverDefault.isError}>
            <div class="flex flex-wrap items-center gap-2" role="alert">
              <p class="text-14-regular text-text-danger-base">
                {souls.error instanceof Error
                  ? souls.error.message
                  : serverDefault.error instanceof Error
                    ? serverDefault.error.message
                    : language.t("common.requestFailed")}
              </p>
              <Button size="small" variant="secondary" onClick={() => { void souls.refetch(); void serverDefault.refetch() }}>
                {language.t("common.retry")}
              </Button>
            </div>
          </Show>
          <Show when={defaultSoul()} fallback={
            <p class="text-14-regular text-text-weak">
              {language.t("settings.personalization.noDefault")}
            </p>
          }>
            {(soul) => (
              <div class="flex flex-wrap items-center gap-3">
                <SoulAvatar soul={soul()} />
                <div class="min-w-0 flex-1">
                  <p class="text-14-medium text-text-strong">{soul().displayName || soul().name}</p>
                  <p class="text-12-regular text-text-weak">{soul().name}</p>
                  <Show when={soul().description}><p class="mt-1 text-12-regular text-text-weak">{soul().description}</p></Show>
                  <Show when={soul().commitPrefix}><p class="mt-1 text-12-regular text-text-weak">{soul().commitPrefix}</p></Show>
                </div>
                <Button size="small" variant="secondary" onClick={() => selectSoul(soul().id)}>
                  {language.t("settings.personalization.viewDetails")}
                </Button>
              </div>
            )}
          </Show>
          <Show when={saved()}>
            <div>
              <Button size="small" variant="secondary" onClick={useServerDefault}>
                {language.t("settings.personalization.useServerDefault")}
              </Button>
            </div>
          </Show>
          <Show when={saved() && souls.data && !soulsList().some((soul) => soul.id === saved())}>
            <p role="alert" class="text-14-regular text-text-danger-base">
              {language.t("settings.personalization.staleSoul", { id: saved() })}
            </p>
          </Show>
          <Show
            when={
              currentSessionKnown() &&
              sessionSoulId() &&
              souls.data &&
              !soulsList().some((soul) => soul.id === sessionSoulId())
            }
          >
            <p role="alert" class="text-14-regular text-text-danger-base">
              {language.t("settings.personalization.missingCurrentSoul", { id: sessionSoulId() ?? "" })}
            </p>
          </Show>
          <p aria-live="polite" class="text-12-regular text-text-success-base">{view.feedback}</p>
        </section>

        <div class="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-[minmax(240px,0.85fr)_minmax(0,1.5fr)]">
          <section aria-label={language.t("settings.personalization.roster")} class="flex min-w-0 flex-col gap-3">
            <div class="flex items-center justify-between gap-3">
              <h3 class="text-14-medium text-text-strong">{language.t("settings.personalization.roster")}</h3>
              <span class="text-12-regular text-text-weak">{soulsList().length}</span>
            </div>
            <TextField
              value={view.search}
              onChange={(value) => setView("search", value)}
              placeholder={language.t("settings.personalization.search")}
              aria-label={language.t("settings.personalization.search")}
            />
            <Show when={souls.isPending}>
              <p aria-live="polite" class="text-14-regular text-text-weak">{language.t("common.loading")}</p>
            </Show>
            <Show when={souls.data && soulsList().length === 0}>
              <p class="rounded-lg border border-border-weak-base p-4 text-14-regular text-text-weak">
                {language.t("settings.personalization.empty")}
              </p>
            </Show>
            <Show when={souls.data && soulsList().length > 0 && filtered().length === 0}>
              <p class="rounded-lg border border-border-weak-base p-4 text-14-regular text-text-weak">
                {language.t("settings.personalization.noResults")}
              </p>
            </Show>
            <ul class="flex flex-col gap-2">
              <For each={filtered()}>
                {(soul) => (
                  <li>
                    <button
                      type="button"
                      aria-label={language.t("settings.personalization.selectSoul", { name: soul.displayName || soul.name })}
                      aria-pressed={view.selectedId === soul.id}
                      onClick={() => selectSoul(soul.id)}
                      class={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-surface-raised-base focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus ${
                        view.selectedId === soul.id ? "border-border-focus bg-surface-raised-base" : "border-border-weak-base"
                      }`}
                    >
                      <SoulAvatar soul={soul} />
                      <span class="min-w-0 flex-1">
                        <span class="flex flex-wrap items-center gap-2">
                          <span class="text-14-medium text-text-strong">{soul.displayName || soul.name}</span>
                          <Show when={soul.id === effectiveDefaultId()}>
                            <span class="rounded-full bg-surface-raised-base px-2 py-0.5 text-12-regular text-text-weak">
                              {language.t("settings.personalization.defaultBadge")}
                            </span>
                          </Show>
                          <Show when={currentSessionKnown() && soul.id === sessionSoulId()}>
                            <span class="rounded-full bg-surface-raised-base px-2 py-0.5 text-12-regular text-text-weak">
                              {language.t("settings.personalization.currentSessionBadge")}
                            </span>
                          </Show>
                        </span>
                        <span class="mt-1 block truncate text-12-regular text-text-weak">{soul.description || soul.name}</span>
                        <Show when={soul.commitPrefix}><span class="mt-1 block text-12-regular text-text-weak">{soul.commitPrefix}</span></Show>
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </section>

          <section aria-label={language.t("settings.personalization.details")} class="min-w-0 rounded-lg border border-border-weak-base bg-surface-base p-4">
            <Show when={selected()} fallback={<p class="text-14-regular text-text-weak">{language.t("settings.personalization.chooseSoul")}</p>}>
              {(soul) => (
                <div class="flex flex-col gap-4">
                  <div class="flex flex-wrap items-start gap-3">
                    <SoulAvatar soul={soul()} />
                    <div class="min-w-0 flex-1">
                      <h3 class="text-16-medium text-text-strong">{soul().displayName || soul().name}</h3>
                      <p class="text-12-regular text-text-weak">{soul().name} · {soul().id}</p>
                    </div>
                    <Show when={soul().id !== effectiveDefaultId()}>
                      <Button size="small" variant="secondary" onClick={() => setDefault(soul().id)}>
                        {language.t("settings.personalization.setDefault")}
                      </Button>
                    </Show>
                  </div>
                  <Show when={currentSessionKnown() && sessionSoulId() === soul().id}>
                    <p class="rounded-md bg-surface-raised-base p-2 text-12-regular text-text-weak">
                      {language.t("settings.personalization.currentSessionNotice")}
                    </p>
                  </Show>
                  <Show when={currentSessionKnown() && !sessionSoulId()}>
                    <p class="rounded-md bg-surface-raised-base p-2 text-12-regular text-text-weak">
                      {language.t("settings.personalization.currentSessionNoSoul")}
                    </p>
                  </Show>
                  <Show when={currentSessionKnown() && sessionSoulId() && sessionSoulId() !== soul().id}>
                    <p class="rounded-md bg-surface-raised-base p-2 text-12-regular text-text-weak">
                      {language.t("settings.personalization.otherCurrentSession", { id: sessionSoulId() ?? "" })}
                    </p>
                  </Show>
                  <Show when={soul().id} keyed>
                    {(id) => <SoulAvatarPicker soul={{ ...soul(), id }} />}
                  </Show>
                  <Show when={detail.isPending}>
                    <p aria-live="polite" class="text-14-regular text-text-weak">{language.t("common.loading")}</p>
                  </Show>
                  <Show when={detail.isError}>
                    <div role="alert" class="flex flex-wrap items-center gap-2">
                      <p class="text-14-regular text-text-danger-base">
                        {detail.error instanceof Error ? detail.error.message : language.t("common.requestFailed")}
                      </p>
                      <Button size="small" variant="secondary" onClick={() => void detail.refetch()}>{language.t("common.retry")}</Button>
                    </div>
                  </Show>
                  <Show when={detail.data}>
                    {(data) => (
                      <>
                        <dl class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <DetailField label="id" value={data().id} source={sourceLabel("id")} />
                          <DetailField label="name" value={data().name} source={sourceLabel("name")} />
                          <DetailField label="displayName" value={data().displayName} source={sourceLabel("displayName")} />
                          <DetailField label="commitPrefix" value={data().commitPrefix} source={sourceLabel("commitPrefix")} />
                          <DetailField label="avatar" value={data().avatar} source={sourceLabel("avatar")} />
                          <DetailField label="description" value={data().description} source={sourceLabel("description")} />
                        </dl>
                        <Show when={data().path}>
                          <div class="flex flex-wrap items-center gap-2">
                            <code class="min-w-0 flex-1 break-all text-12-regular text-text-weak">{data().path}</code>
                            <Show when={typeof navigator !== "undefined" && !!navigator.clipboard?.writeText}>
                              <Button size="small" variant="secondary" onClick={copySource}>{language.t("settings.personalization.copyPath")}</Button>
                            </Show>
                            <Show when={platform.platform === "desktop" && !!platform.openPath && server.isLocal()}>
                              <Button size="small" variant="secondary" onClick={openSource}>{language.t("settings.personalization.openPath")}</Button>
                            </Show>
                          </div>
                        </Show>
                        <Show when={data().content}>
                          <section class="flex flex-col gap-2">
                            <h4 class="text-14-medium text-text-strong">{language.t("settings.personalization.body")}</h4>
                            <pre class="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-raised-base p-3 font-mono text-12-regular text-text-weak">{data().content}</pre>
                          </section>
                        </Show>
                      </>
                    )}
                  </Show>
                  <p aria-live="polite" role={view.error ? "alert" : undefined} class="text-12-regular text-text-danger-base">{view.error}</p>
                </div>
              )}
            </Show>
          </section>
        </div>

        <Show when={issues.isPending}>
          <p aria-live="polite" class="text-14-regular text-text-weak">{language.t("settings.personalization.issuesLoading")}</p>
        </Show>
        <Show when={issues.isError}>
          <div role="alert" class="flex flex-wrap items-center gap-2">
            <p class="text-14-regular text-text-danger-base">{issues.error instanceof Error ? issues.error.message : language.t("common.requestFailed")}</p>
            <Button size="small" variant="secondary" onClick={() => void issues.refetch()}>{language.t("common.retry")}</Button>
          </div>
        </Show>
        <Show when={issues.data?.length}>
          <section aria-label={language.t("settings.personalization.registryIssues")} class="flex flex-col gap-2">
            <h3 class="text-14-medium text-text-strong">{language.t("settings.personalization.registryIssues")}</h3>
            <ul class="flex flex-col gap-1">
              <For each={issues.data}>
                {(issue) => (
                  <li role="alert" class="text-14-regular text-text-danger-base">
                    <code>{issue.path}</code>: {issue.message}
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
      </main>
    </div>
  )
}

const DetailField: Component<{ label: string; value?: string; source: string }> = (props) => (
  <div class="min-w-0 rounded-md bg-surface-raised-base p-2">
    <dt class="text-12-medium text-text-weak">{props.label} · {props.source}</dt>
    <dd class="mt-1 break-words text-14-regular text-text-strong">{props.value || "—"}</dd>
  </div>
)
