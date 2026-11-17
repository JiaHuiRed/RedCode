import { createMemo, For, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { Button } from "@redcode-ai/ui/button"
import { Spinner } from "@redcode-ai/ui/spinner"
import { base64Encode } from "@redcode-ai/core/util/encode"
import { Binary } from "@redcode-ai/core/util/binary"
import { SoulAvatar } from "@/components/soul-avatar"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { companionSessions } from "@/utils/product-mode"
import { errorMessage } from "@/utils/session-helpers"

export default function Chat() {
  const sdk = useGlobalSDK()
  const sync = useServerSync()
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const navigate = useNavigate()
  const [search, setSearch] = useSearchParams<{ companion?: string }>()
  const queryClient = useQueryClient()
  const [state, setState] = createStore({ source: "", importing: false, opening: false, error: "" })
  const profileKey = () => ["companion", sdk.url, "list"] as const
  const profiles = useQuery(() => ({
    queryKey: profileKey(),
    queryFn: async () => (await sdk.client.companion.list({ throwOnError: true })).data,
  }))
  const souls = useQuery(() => ({
    queryKey: ["soul", sdk.url, "list"],
    queryFn: async () => (await sdk.client.soul.list({ throwOnError: true })).data,
  }))
  const profile = createMemo(() => profiles.data?.find((item) => item.id === search.companion) ?? profiles.data?.[0])
  const soul = createMemo(() => souls.data?.find((item) => item.id === profile()?.soulID))
  const sessions = useQuery(() => ({
    queryKey: ["companion", sdk.url, profile()?.id, "sessions"],
    enabled: !!profile(),
    refetchOnMount: true,
    queryFn: async () => {
      const selected = profile()
      if (!selected) return []
      const result = await sdk.client.session.list(
        { directory: selected.directory, roots: true },
        { throwOnError: true },
      )
      return companionSessions(result.data, selected.id)
    },
  }))

  async function importArchive() {
    if (state.importing || !state.source.trim()) return
    setState({ importing: true, error: "" })
    try {
      const { data } = await sdk.client.companion.import(
        { companionImportInput: { source: state.source.trim() } },
        { throwOnError: true },
      )
      queryClient.setQueryData<typeof profiles.data>(profileKey(), (current) => [
        ...(current ?? []).filter((item) => item.id !== data.profile.id),
        data.profile,
      ])
      void queryClient.invalidateQueries({ queryKey: ["soul", sdk.url, "list"] })
      setSearch({ companion: data.profile.id })
      setState("source", "")
    } catch (error) {
      setState("error", errorMessage(error, language.t("common.requestFailed")))
    } finally {
      setState("importing", false)
    }
  }

  async function pickSource(kind: "directory" | "zip") {
    setState("error", "")
    try {
      const result =
        kind === "directory"
          ? await platform.openDirectoryPickerDialog?.({ title: language.t("chat.import.folder") })
          : await platform.openFilePickerDialog?.({ title: language.t("chat.import.zip"), extensions: ["zip"] })
      const source = Array.isArray(result) ? result[0] : result
      if (source) setState("source", source)
    } catch (error) {
      setState("error", errorMessage(error, language.t("common.requestFailed")))
    }
  }

  async function startChat() {
    const selected = profile()
    if (!selected || state.opening) return
    setState({ opening: true, error: "" })
    try {
      const { data } = await sdk.client.session.create(
        {
          directory: selected.directory,
          mode: "chat",
          companionID: selected.id,
        },
        { throwOnError: true },
      )
      // Seed the real response before navigation so the titlebar sees the bound
      // Chat mode immediately, even before the directory's first fetch finishes.
      const [, setStore] = sync.child(data.directory, { bootstrap: false })
      setStore(
        "session",
        produce((list) => {
          const match = Binary.search(list, data.id, (item) => item.id)
          if (match.found) list[match.index] = data
          else list.splice(match.index, 0, data)
        }),
      )
      navigate(`/${base64Encode(data.directory)}/session/${data.id}`)
    } catch (error) {
      setState("error", errorMessage(error, language.t("common.requestFailed")))
    } finally {
      setState("opening", false)
    }
  }

  return (
    <div data-component="chat-home" class="size-full overflow-y-auto">
      <div class="mx-auto flex w-full max-w-[960px] flex-col gap-8 px-6 py-10 md:px-10 md:py-14">
        <header class="space-y-3">
          <p class="text-12-medium text-text-weaker">RedSpace · Chat</p>
          <h1 class="text-24-medium text-text-strong">{language.t("chat.title")}</h1>
          <p class="max-w-[600px] text-14-regular text-text-weak">{language.t("chat.description")}</p>
        </header>

        <Show when={state.error || profiles.error}>
          <div
            role="alert"
            class="flex items-center justify-between gap-4 rounded-lg border border-border-critical-base bg-surface-critical-weak p-4 text-13-regular text-text-strong"
          >
            <span>{state.error || errorMessage(profiles.error, language.t("common.requestFailed"))}</span>
            <Show when={profiles.error}>
              <Button variant="secondary" onClick={() => void profiles.refetch()}>
                {language.t("common.retry")}
              </Button>
            </Show>
          </div>
        </Show>

        <Show when={!profiles.isPending} fallback={<Spinner class="size-6" />}>
          <Show when={profile()} keyed>
            {(selected) => (
              <section class="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" aria-label={selected.name}>
                <div class="flex flex-col gap-5 rounded-xl border border-border-weak-base bg-background-weak p-6">
                  <div class="flex items-center gap-4">
                    <SoulAvatar id={selected.soulID} soul={soul()} size="large" />
                    <div class="min-w-0">
                      <h2 class="truncate text-20-medium text-text-strong">{selected.name}</h2>
                      <p class="mt-1 text-12-regular text-text-weaker">
                        {language.t("chat.profile.files", { count: selected.files })}
                      </p>
                    </div>
                  </div>
                  <p class="text-14-regular text-text-weak">{language.t("chat.profile.description")}</p>
                  <Button
                    data-action="chat-start"
                    variant="primary"
                    disabled={state.opening}
                    onClick={() => void startChat()}
                  >
                    {state.opening ? language.t("chat.opening") : language.t("chat.start")}
                  </Button>
                  <Show when={selected.warnings.length}>
                    <details class="text-12-regular text-text-weak">
                      <summary class="cursor-pointer">{language.t("chat.import.notes")}</summary>
                      <ul class="mt-2 list-disc space-y-2 pl-4">
                        <For each={selected.warnings}>{(warning) => <li>{warning}</li>}</For>
                      </ul>
                    </details>
                  </Show>
                  <Show when={(profiles.data?.length ?? 0) > 1}>
                    <div
                      class="flex flex-wrap gap-2 border-t border-border-weak-base pt-4"
                      aria-label={language.t("chat.profile.choose")}
                    >
                      <For each={profiles.data}>
                        {(item) => (
                          <Button
                            variant={item.id === selected.id ? "secondary" : "ghost"}
                            onClick={() => setSearch({ companion: item.id })}
                          >
                            {item.name}
                          </Button>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
                <div class="min-w-0 py-1">
                  <h2 class="mb-4 text-14-medium text-text-strong">{language.t("chat.recent")}</h2>
                  <Show when={!sessions.isPending} fallback={<Spinner class="size-5" />}>
                    <Show
                      when={!sessions.error}
                      fallback={
                        <div role="alert" class="space-y-3 text-13-regular text-text-weak">
                          <p>{errorMessage(sessions.error, language.t("common.requestFailed"))}</p>
                          <Button variant="secondary" onClick={() => void sessions.refetch()}>
                            {language.t("common.retry")}
                          </Button>
                        </div>
                      }
                    >
                      <Show
                        when={sessions.data?.length}
                        fallback={<p class="text-13-regular text-text-weaker">{language.t("chat.recent.empty")}</p>}
                      >
                        <ul class="space-y-1">
                          <For each={sessions.data}>
                            {(session) => (
                              <li>
                                <a
                                  href={`/${base64Encode(session.directory)}/session/${session.id}`}
                                  class="flex flex-col gap-1 rounded-lg px-3 py-3 hover:bg-surface-base-hover focus-visible:outline-2 focus-visible:outline-border-focus"
                                >
                                  <span class="truncate text-14-medium text-text-strong">{session.title}</span>
                                  <time
                                    class="text-12-regular text-text-weaker"
                                    dateTime={new Date(session.time.updated ?? session.time.created).toISOString()}
                                  >
                                    {new Intl.DateTimeFormat(language.locale(), {
                                      dateStyle: "medium",
                                      timeStyle: "short",
                                    }).format(session.time.updated ?? session.time.created)}
                                  </time>
                                </a>
                              </li>
                            )}
                          </For>
                        </ul>
                      </Show>
                    </Show>
                  </Show>
                </div>
              </section>
            )}
          </Show>
        </Show>

        <details open={!profile()} class="rounded-xl border border-border-weak-base p-6">
          <summary class="cursor-pointer text-14-medium text-text-strong">{language.t("chat.import.title")}</summary>
          <form
            class="mt-4 space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              void importArchive()
            }}
          >
            <p class="text-13-regular text-text-weak">{language.t("chat.import.description")}</p>
            <div class="space-y-2">
              <label for="companion-source" class="block text-12-medium text-text-weak">
                {language.t("chat.import.source")}
              </label>
              <input
                id="companion-source"
                data-action="chat-import-source"
                class="h-10 w-full rounded-md border border-border-base bg-background-base px-3 text-13-regular text-text-strong focus:outline-2 focus:outline-border-focus"
                value={state.source}
                onInput={(event) => setState("source", event.currentTarget.value)}
                placeholder={language.t("chat.import.placeholder")}
                disabled={state.importing}
                autocomplete="off"
                spellcheck={false}
                required
              />
              <Show when={!server.isLocal()}>
                <p class="text-12-regular text-text-weaker">{language.t("chat.import.remote")}</p>
              </Show>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <Show when={server.isLocal() && platform.openDirectoryPickerDialog}>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={state.importing}
                  onClick={() => void pickSource("directory")}
                >
                  {language.t("chat.import.folder")}
                </Button>
              </Show>
              <Show when={server.isLocal() && platform.openFilePickerDialog}>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={state.importing}
                  onClick={() => void pickSource("zip")}
                >
                  {language.t("chat.import.zip")}
                </Button>
              </Show>
              <Button
                data-action="chat-import"
                type="submit"
                variant="primary"
                disabled={state.importing || !state.source.trim()}
              >
                {state.importing ? language.t("chat.import.busy") : language.t("chat.import.action")}
              </Button>
            </div>
          </form>
        </details>
      </div>
    </div>
  )
}
