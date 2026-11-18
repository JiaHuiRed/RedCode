import { createEffect, createMemo, For, onCleanup, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import type { CompanionDetails, CompanionInfo } from "@redcode-ai/sdk/v2/client"
import { Button } from "@redcode-ai/ui/button"
import { Dialog } from "@redcode-ai/ui/dialog"
import { TextField } from "@redcode-ai/ui/text-field"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { showToast } from "@redcode-ai/ui/toast"
import { checksum } from "@redcode-ai/core/util/encode"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServer } from "@/context/server"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { useSettings } from "@/context/settings"
import { useCompanionWorkspace } from "@/context/companion-workspace"
import { prepareSoulAvatar } from "@/utils/soul-avatar-image"
import { decode64 } from "@/utils/base64"
import { Persist, persisted } from "@/utils/persist"
import { errorMessage } from "@/utils/session-helpers"
import { composeCompanionUser, splitCompanionUser } from "@/utils/companion-profile"
import { introductionState, upsertCompanion } from "@/utils/companion-workspace"
import { CompanionDiary } from "./companion-diary"
import { SoulAvatar } from "./soul-avatar"
import { SettingsList, SettingsRow } from "./settings-list"
import { SettingsSoulEditor, SettingsSourceActions } from "./settings-soul-editor"

const detailsKey = (url: string, id: string) => ["companion", url, "detail", id] as const

const CompanionProfileEditor: Component<{ id: string; kind: "profile" | "user" }> = (props) => {
  const sdk = useGlobalSDK()
  const server = useServer()
  const language = useLanguage()
  const dialog = useDialog()
  const queryClient = useQueryClient()
  const settings = useSettings()
  let avatarInput: HTMLInputElement | undefined
  const details = useQuery(() => ({
    queryKey: detailsKey(sdk.url, props.id),
    queryFn: async () => (await sdk.client.companion.get({ id: props.id }, { throwOnError: true })).data,
  }))
  const [draft, setDraft, , ready] = persisted(
    {
      ...Persist.global(`settings.companion.edit.${checksum(server.key ?? sdk.url)}.${props.id}.${props.kind}`),
      evictOnQuota: false,
    },
    createStore({ name: "", nickname: "", notes: "", baseline: "", dirty: false }),
  )
  const [avatar, setAvatar, , avatarReady] = persisted(
    {
      ...Persist.media(`settings.companion.avatarDraft.${checksum(server.key ?? sdk.url)}.${props.id}`),
      evictOnQuota: false,
    },
    createStore({ image: "", dirty: false }),
  )
  const [state, setState] = createStore({ busy: false, avatarBusy: false, error: "", conflict: false })
  const formReady = () => ready() && (props.kind !== "profile" || avatarReady())
  const selectAvatar = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ""
    if (!file) return
    setState({ avatarBusy: true, error: "" })
    try {
      setAvatar({ image: await prepareSoulAvatar(file), dirty: true })
    } catch (error) {
      setState("error", errorMessage(error, language.t("settings.personalization.avatarFailed")))
    } finally {
      setState("avatarBusy", false)
    }
  }
  const seed = (data: CompanionDetails) =>
    setDraft({
      name: data.companionName || data.profile.name,
      ...splitCompanionUser(data.user),
      baseline: props.kind === "user" ? data.user : data.profile.name,
      dirty: false,
    })
  createEffect(() => {
    if (ready() && details.data && !draft.dirty) seed(details.data)
  })
  const change = (field: "name" | "nickname" | "notes", value: string) => {
    setDraft(field, value)
    setDraft("dirty", true)
    setState("error", "")
  }
  const reload = async () => {
    try {
      const current = await details.refetch({ throwOnError: true })
      if (current.data) seed(current.data)
      setState({ error: "", conflict: false })
    } catch (error) {
      setState("error", errorMessage(error, language.t("common.requestFailed")))
    }
  }
  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    if (state.busy || state.avatarBusy || !formReady()) return
    const user = composeCompanionUser(draft.nickname, draft.notes)
    if (props.kind === "user" && new TextEncoder().encode(user).length > 16 * 1024) {
      setState("error", language.t("settings.companion.userTooLarge"))
      return
    }
    setState({ busy: true, error: "", conflict: false })
    try {
      const current = (await sdk.client.companion.get({ id: props.id }, { throwOnError: true })).data
      if ((props.kind === "user" ? current.user : current.profile.name) !== draft.baseline) {
        setState({ error: language.t("settings.editor.conflict"), conflict: true })
        return
      }
      const { data } = await sdk.client.companion.update(
        {
          id: props.id,
          companionUpdateInput:
            props.kind === "user"
              ? { user }
              : draft.name.trim() !== current.profile.name
                ? { name: draft.name.trim() }
                : {},
        },
        { throwOnError: true },
      )
      seed(data)
      if (props.kind === "profile" && avatar.dirty) {
        settings.personalization.setSoulAvatar(data.profile.soulID, avatar.image)
        setAvatar({ image: "", dirty: false })
      }
      queryClient.setQueryData(detailsKey(sdk.url, props.id), data)
      queryClient.setQueryData<CompanionInfo[]>(["companion", sdk.url, "list"], (current) =>
        upsertCompanion(current, data.profile),
      )
      void queryClient.invalidateQueries({ queryKey: ["companion", sdk.url, "list"] })
      showToast({ title: language.t("settings.companion.saved") })
      dialog.close()
    } catch (error) {
      setState("error", errorMessage(error, language.t("common.requestFailed")))
    } finally {
      setState("busy", false)
    }
  }
  return (
    <Dialog
      class="settings-editor-dialog"
      size="large"
      title={language.t(props.kind === "user" ? "settings.companion.aboutYou" : "settings.companion.profileTitle")}
    >
      <Show
        when={formReady() && details.data}
        fallback={<p class="text-13-regular text-text-weak">{language.t("common.loading")}</p>}
      >
        <form class="flex flex-col gap-4" onSubmit={(event) => void save(event)}>
          <Show
            when={props.kind === "profile"}
            fallback={
              <>
                <SettingsSourceActions
                  path={details.data?.paths.user}
                  onRefresh={() => details.refetch({ throwOnError: true })}
                />
                <TextField
                  label={language.t("settings.companion.nickname")}
                  description={language.t("settings.companion.nicknameHelp")}
                  value={draft.nickname}
                  onChange={(value) => change("nickname", value)}
                  disabled={state.busy}
                />
                <label class="flex flex-col gap-2 text-14-medium text-text-strong">
                  {language.t("settings.companion.userNotes")}
                  <textarea
                    class="min-h-64 w-full resize-y rounded-lg border border-border-base bg-background-base p-3 text-14-regular leading-relaxed"
                    value={draft.notes}
                    disabled={state.busy}
                    onInput={(event) => change("notes", event.currentTarget.value)}
                  />
                </label>
                <p class="text-12-regular text-text-weak">{language.t("settings.companion.userHelp")}</p>
              </>
            }
          >
            <TextField
              label={language.t("settings.companion.name")}
              description={language.t("settings.companion.nameHelp")}
              value={draft.name}
              onChange={(value) => change("name", value)}
              disabled={state.busy}
            />
            <Show when={details.data}>
              {(data) => (
                <section class="flex flex-col gap-3">
                  <h3 class="text-14-medium text-text-strong">{language.t("settings.personalization.avatarTitle")}</h3>
                  <div class="flex items-center gap-3">
                    <Show
                      when={avatar.dirty}
                      fallback={
                        <SoulAvatar
                          id={data().profile.soulID}
                          soul={{
                            id: data().profile.soulID,
                            name: draft.name.trim() || data().profile.name,
                            displayName: draft.name.trim() || data().profile.name,
                          }}
                          size="large"
                        />
                      }
                    >
                      <Show
                        when={avatar.image}
                        fallback={
                          <span class="flex size-12 items-center justify-center rounded-xl bg-surface-raised-base text-20-medium">
                            {draft.name.slice(0, 1)}
                          </span>
                        }
                      >
                        <img src={avatar.image} alt={draft.name} class="size-12 rounded-xl object-cover" />
                      </Show>
                    </Show>
                    <input
                      ref={avatarInput}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      class="hidden"
                      aria-label={language.t("settings.personalization.chooseAvatar")}
                      onChange={(event) => void selectAvatar(event)}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={state.busy || state.avatarBusy}
                      onClick={() => avatarInput?.click()}
                    >
                      {language.t(state.avatarBusy ? "common.loading" : "settings.personalization.chooseAvatar")}
                    </Button>
                    <Show when={avatar.image || settings.personalization.soulAvatar(data().profile.soulID)}>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={state.busy || state.avatarBusy}
                        onClick={() => setAvatar({ image: "", dirty: true })}
                      >
                        {language.t("settings.personalization.removeAvatar")}
                      </Button>
                    </Show>
                  </div>
                </section>
              )}
            </Show>
          </Show>
          <p class="text-12-regular text-text-weak">{language.t("settings.editor.draft")}</p>
          <Show when={state.error}>
            <p role="alert" class="text-13-regular text-text-on-critical-base">
              {state.error}
            </p>
          </Show>
          <Show when={state.conflict}>
            <Button variant="secondary" disabled={state.busy} onClick={() => void reload()}>
              {language.t("settings.editor.reload")}
            </Button>
          </Show>
          <div class="flex justify-end gap-2 border-t border-border-weak-base pt-4">
            <Button variant="ghost" disabled={state.busy} onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={state.busy || state.avatarBusy || (!draft.dirty && !(props.kind === "profile" && avatar.dirty))}
            >
              {language.t(state.busy ? "settings.editor.saving" : "common.save")}
            </Button>
          </div>
        </form>
      </Show>
      <Show when={details.error}>
        <p role="alert" class="text-13-regular text-text-on-critical-base">
          {errorMessage(details.error, language.t("common.requestFailed"))}
        </p>
        <Button onClick={() => void details.refetch()}>{language.t("common.retry")}</Button>
      </Show>
    </Dialog>
  )
}

export const SettingsChatCompanion: Component = () => {
  const sdk = useGlobalSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const params = useParams()
  const sync = useServerSync()
  const workspace = useCompanionWorkspace()
  const [search] = useSearchParams<{ companion?: string }>()
  const [view, setView] = createStore({ selected: "", creating: false, createError: "", introductionBusy: false })
  let mounted = true
  onCleanup(() => {
    mounted = false
  })
  const profiles = useQuery(() => ({
    queryKey: ["companion", sdk.url, "list"],
    queryFn: async () => (await sdk.client.companion.list({ throwOnError: true })).data,
  }))
  const requestedID = createMemo(() => {
    const dir = params.dir ? decode64(params.dir) : undefined
    const session =
      dir && params.id
        ? sync.peek(dir, { bootstrap: false })[0].session.find((item) => item.id === params.id)
        : undefined
    return view.selected || session?.companionID || (search.companion ?? (workspace.selected() || undefined))
  })
  const selected = createMemo(() =>
    requestedID() !== undefined ? profiles.data?.find((profile) => profile.id === requestedID()) : profiles.data?.[0],
  )
  const details = useQuery(() => ({
    queryKey: detailsKey(sdk.url, selected()?.id ?? ""),
    enabled: !!selected(),
    queryFn: async () => (await sdk.client.companion.get({ id: selected()!.id }, { throwOnError: true })).data,
  }))
  const soul = useQuery(() => ({
    queryKey: ["soul", sdk.url, "detail", selected()?.soulID],
    enabled: !!selected(),
    queryFn: async () => (await sdk.client.soul.get({ id: selected()!.soulID }, { throwOnError: true })).data,
  }))
  const openChat = (id: string) => {
    workspace.select(id)
    dialog.close()
    navigate(`/chat?companion=${encodeURIComponent(id)}`)
  }
  const createCompanion = async () => {
    if (!workspace.ready() || view.creating || profiles.isPending || profiles.error) return
    const requestID = workspace.requestID()
    setView({ creating: true, createError: "" })
    try {
      const { data } = await sdk.client.companion.create(
        { companionCreateInput: { requestID } },
        { throwOnError: true },
      )
      queryClient.setQueryData<CompanionInfo[]>(["companion", sdk.url, "list"], (current) =>
        upsertCompanion(current, data.profile),
      )
      workspace.finishRequest(requestID)
      void queryClient.invalidateQueries({ queryKey: ["soul", sdk.url, "list"] })
      if (mounted) openChat(data.profile.id)
    } catch (error) {
      setView("createError", errorMessage(error, language.t("common.requestFailed")))
    } finally {
      setView("creating", false)
    }
  }
  const setIntroduction = async (introduction: "paused" | "complete") => {
    const profile = selected()
    if (!profile || view.introductionBusy) return
    setView("introductionBusy", true)
    try {
      const { data } = await sdk.client.companion.update(
        { id: profile.id, companionUpdateInput: { introduction } },
        { throwOnError: true },
      )
      queryClient.setQueryData(detailsKey(sdk.url, profile.id), data)
      queryClient.setQueryData<CompanionInfo[]>(["companion", sdk.url, "list"], (current) =>
        upsertCompanion(current, data.profile),
      )
    } catch (error) {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(error, language.t("common.requestFailed")),
      })
    } finally {
      setView("introductionBusy", false)
    }
  }
  const openMemory = () => {
    const data = details.data
    if (!data) return
    dialog.push(() => (
      <Dialog
        class="settings-editor-dialog"
        title={language.t("settings.companion.memory")}
        description={language.t("settings.companion.memoryDescription")}
      >
        <div class="flex flex-col gap-5">
          <section class="flex flex-col gap-2">
            <h3 class="text-14-medium text-text-strong">{language.t("settings.companion.memoryFile")}</h3>
            <SettingsSourceActions path={data.paths.memory} />
          </section>
          <section class="flex flex-col gap-2">
            <h3 class="text-14-medium text-text-strong">{language.t("settings.companion.dailyMemory")}</h3>
            <CompanionDiary directory={data.paths.directory} />
            <SettingsSourceActions path={`${data.paths.directory.replace(/[\\/]+$/, "")}/memory`} directory />
          </section>
        </div>
      </Dialog>
    ))
  }
  return (
    <div class="settings-page-body" data-component="settings-chat-companion">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 class="settings-page-title">{language.t("settings.companion.title")}</h2>
          <p class="settings-page-description">{language.t("settings.companion.description")}</p>
        </div>
        <Button
          variant="secondary"
          disabled={
            !workspace.ready() ||
            view.creating ||
            profiles.isPending ||
            !!profiles.error ||
            (profiles.data?.length ?? 0) >= 2
          }
          onClick={() => void createCompanion()}
        >
          {language.t(view.creating ? "chat.companion.creating" : "chat.companion.new")}
        </Button>
      </header>
      <Show when={(profiles.data?.length ?? 0) >= 2}>
        <p class="text-12-regular text-text-weak">{language.t("chat.companion.limit")}</p>
      </Show>
      <Show when={view.createError}>
        <div role="alert" class="flex flex-wrap items-center gap-3 text-13-regular text-text-on-critical-base">
          <p>{view.createError}</p>
          <Button variant="secondary" disabled={view.creating} onClick={() => void createCompanion()}>
            {language.t("common.retry")}
          </Button>
        </div>
      </Show>
      <Show
        when={!profiles.isPending}
        fallback={
          <p role="status" class="text-13-regular text-text-weak">
            {language.t("common.loading")}
          </p>
        }
      >
        <Show
          when={selected()}
          fallback={
            <Show when={!profiles.error}>
              <section class="flex flex-col gap-4 rounded-xl border border-border-weak-base bg-surface-base p-6">
                <h3 class="text-16-medium text-text-strong">
                  {language.t(requestedID() !== undefined ? "chat.profile.missing" : "settings.companion.empty")}
                </h3>
                <Show when={requestedID() === undefined}>
                  <p class="text-13-regular text-text-weak">{language.t("settings.companion.emptyDescription")}</p>
                </Show>
                <div>
                  <Button
                    variant="primary"
                    onClick={() => {
                      dialog.close()
                      navigate("/chat")
                    }}
                  >
                    {language.t(requestedID() !== undefined ? "chat.profile.choose" : "settings.companion.goChat")}
                  </Button>
                </div>
              </section>
            </Show>
          }
        >
          {(profile) => (
            <>
              <section class="flex flex-wrap items-center gap-4 rounded-xl border border-border-weak-base bg-surface-base p-6">
                <SoulAvatar
                  id={profile().soulID}
                  soul={{ ...soul.data, id: profile().soulID, name: profile().name, displayName: profile().name }}
                  size="large"
                />
                <div class="min-w-0 flex-1">
                  <h3 class="text-20-medium text-text-strong">{profile().name}</h3>
                  <p class="mt-1 text-12-regular text-text-weak">{language.t("settings.companion.current")}</p>
                </div>
                <Button
                  variant="ghost"
                  onClick={() => {
                    const id = profile().id
                    dialog.push(() => <CompanionProfileEditor id={id} kind="profile" />)
                  }}
                >
                  {language.t("settings.companion.editProfile")}
                </Button>
                <Show when={(profiles.data?.length ?? 0) > 1}>
                  <label class="flex w-full items-center gap-3 border-t border-border-weak-base pt-4 text-12-regular text-text-weak">
                    {language.t("settings.companion.choose")}
                    <select
                      class="min-w-0 rounded-lg border border-border-base bg-background-base px-3 py-2 text-13-regular"
                      value={profile().id}
                      disabled={view.creating}
                      onChange={(event) => {
                        setView("selected", event.currentTarget.value)
                      }}
                    >
                      <For each={profiles.data}>{(item) => <option value={item.id}>{item.name}</option>}</For>
                    </select>
                  </label>
                </Show>
              </section>
              <Show when={introductionState(profile()) !== "complete"}>
                <section class="flex flex-wrap items-center gap-3 rounded-xl border border-border-weak-base p-4">
                  <p class="min-w-0 flex-1 text-13-regular text-text-weak">
                    {language.t("chat.introduction.optional")}
                  </p>
                  <Button variant="secondary" onClick={() => openChat(profile().id)}>
                    {language.t("chat.introduction.open")}
                  </Button>
                  <Show when={introductionState(profile()) === "active"}>
                    <Button
                      variant="ghost"
                      disabled={view.introductionBusy}
                      onClick={() => void setIntroduction("paused")}
                    >
                      {language.t("chat.introduction.pause")}
                    </Button>
                  </Show>
                  <Button
                    variant="ghost"
                    disabled={view.introductionBusy}
                    onClick={() => void setIntroduction("complete")}
                  >
                    {language.t("chat.introduction.finish")}
                  </Button>
                </section>
              </Show>
              <section class="flex flex-col gap-3">
                <h3 class="text-14-medium text-text-strong">{language.t("settings.companion.identity")}</h3>
                <SettingsList>
                  <SettingsRow title="Soul" description={language.t("settings.companion.identityDescription")}>
                    <Button
                      variant="primary"
                      onClick={() => {
                        const target = profile()
                        dialog.push(() => <SettingsSoulEditor id={target.soulID} />)
                      }}
                    >
                      {language.t("settings.companion.editSoul")}
                    </Button>
                  </SettingsRow>
                </SettingsList>
                <Show when={soul.data?.path}>
                  <SettingsSourceActions
                    path={soul.data?.path}
                    onRefresh={() => soul.refetch({ throwOnError: true })}
                  />
                </Show>
              </section>
              <section class="flex flex-col gap-3">
                <h3 class="text-14-medium text-text-strong">{language.t("settings.companion.aboutYou")}</h3>
                <SettingsList>
                  <SettingsRow
                    title={language.t("settings.companion.nickname")}
                    description={language.t("settings.companion.aboutDescription")}
                  >
                    <Button
                      variant="secondary"
                      onClick={() => {
                        const id = profile().id
                        dialog.push(() => <CompanionProfileEditor id={id} kind="user" />)
                      }}
                    >
                      {language.t("common.edit")}
                    </Button>
                  </SettingsRow>
                </SettingsList>
              </section>
              <section class="flex flex-col gap-3">
                <h3 class="text-14-medium text-text-strong">{language.t("settings.companion.memory")}</h3>
                <SettingsList>
                  <SettingsRow
                    title={language.t("settings.companion.memoryFile")}
                    description={language.t("settings.companion.memoryDescription")}
                  >
                    <Button variant="secondary" disabled={!details.data} onClick={openMemory}>
                      {language.t("settings.personalization.viewDetails")}
                    </Button>
                  </SettingsRow>
                </SettingsList>
                <Show when={details.data}>
                  <SettingsSourceActions
                    path={`${details.data!.paths.directory.replace(/[\\/]+$/, "")}/memory`}
                    directory
                  />
                </Show>
              </section>
              <Button
                variant="secondary"
                onClick={() =>
                  void import("./dialog-settings").then((module) =>
                    dialog.show(() => <module.DialogSettings initialTab="sound" />),
                  )
                }
              >
                {language.t("settings.companion.readout")}
              </Button>
            </>
          )}
        </Show>
      </Show>
      <Show when={profiles.error || details.error || soul.error}>
        <div class="mt-5 flex flex-wrap items-center gap-3 text-13-regular text-text-on-critical-base" role="alert">
          <p>{errorMessage(profiles.error || details.error || soul.error, language.t("common.requestFailed"))}</p>
          <Button
            variant="secondary"
            onClick={() => {
              void profiles.refetch()
              if (selected()) {
                void details.refetch()
                void soul.refetch()
              }
            }}
          >
            {language.t("common.retry")}
          </Button>
        </div>
      </Show>
    </div>
  )
}
