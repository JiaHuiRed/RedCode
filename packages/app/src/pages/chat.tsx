import { createEffect, createMemo, For, on, onCleanup, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import type { CompanionInfo, Session } from "@redcode-ai/sdk/v2/client"
import { Button } from "@redcode-ai/ui/button"
import { Icon } from "@redcode-ai/ui/icon"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { base64Encode } from "@redcode-ai/core/util/encode"
import { Binary } from "@redcode-ai/core/util/binary"
import { CompanionChatFrame, useCompanionHistory } from "@/components/companion-chat-frame"
import { useModels, type ModelKey } from "@/context/models"
import { useProviders } from "@/hooks/use-providers"
import { SoulAvatar } from "@/components/soul-avatar"
import { ChatComposerTools } from "@/components/chat-composer-tools"
import { prepareSoulAvatar } from "@/utils/soul-avatar-image"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { useCompanionWorkspace } from "@/context/companion-workspace"
import { errorMessage } from "@/utils/session-helpers"
import { Identifier } from "@/utils/id"
import { recordCompanionMessageAccepted } from "@/utils/companion-onboarding"
import { createChatAttachments } from "@/utils/chat-attachments"
import { createChatHomeSubmit } from "@/utils/chat-home-submit"
import { requireCompanionModel, sendCompanionMessage } from "@/utils/chat-send-ack"
import { introductionState, selectCompanion, upsertCompanion } from "@/utils/companion-workspace"

export default function Chat() {
  const sdk = useGlobalSDK()
  const sync = useServerSync()
  const language = useLanguage()
  const navigate = useNavigate()
  const dialog = useDialog()
  const workspace = useCompanionWorkspace()
  const settings = useSettings()
  const [search, setSearch] = useSearchParams<{ companion?: string }>()
  const queryClient = useQueryClient()
  const [state, setState] = createStore({
    creating: false,
    createError: "",
    changingIntroduction: false,
  })
  let mounted = true
  let navigationEpoch = 0
  let filePicker: HTMLInputElement | undefined
  onCleanup(() => {
    mounted = false
  })
  // 261119 Red 首页附件走与 Code 相同的 FilePart 形状，但预算更窄：Chat 首条消息
  // 通常只是一句话，不需要把几十 MB 的归档塞进首个请求。
  const attachments = createChatAttachments(
    (file) =>
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error ?? new Error("read failed"))
        reader.readAsDataURL(file)
      }),
  )
  createEffect(
    on(
      () => search.companion,
      () => {
        navigationEpoch++
      },
      { defer: true },
    ),
  )
  const profileKey = () => ["companion", sdk.url, "list"] as const
  const profiles = useQuery(() => ({
    queryKey: profileKey(),
    queryFn: async () => (await sdk.client.companion.list({ throwOnError: true })).data,
  }))
  const souls = useQuery(() => ({
    queryKey: ["soul", sdk.url, "list"],
    queryFn: async () => (await sdk.client.soul.list({ throwOnError: true })).data,
  }))
  const requestedID = () => search.companion ?? (workspace.selected() || undefined)
  const profile = createMemo(() =>
    workspace.ready() ? selectCompanion(profiles.data ?? [], search.companion, workspace.selected()) : undefined,
  )
  const draftKey = () => profile()?.id ?? requestedID() ?? "default"
  const attachmentError = () => {
    const error = attachments.error(draftKey())
    if (!error) return ""
    return error.type === "tooMany"
      ? language.t("chat.composer.tooMany", { count: attachments.limit })
      : language.t(error.type === "tooLarge" ? "chat.composer.tooLarge" : "chat.composer.readFailed", {
          name: error.name,
        })
  }
  const assignDraft = (id: string) => {
    attachments.assignDefault(id)
    workspace.assignDraft(id)
  }
  const text = () => workspace.draft(draftKey())
  const submission = () => workspace.submission(draftKey())
  const submissionError = () =>
    submission()?.error ||
    (!submission()?.sending && submission()?.messageID ? language.t("chat.companion.pendingRetry") : "")
  const initializing = () => !!workspace.submission("default")?.sending
  const ready = () => workspace.ready() && !profiles.isPending && !profiles.error
  const missing = () => ready() && requestedID() !== undefined && !profile()
  const atCapacity = () => (profiles.data?.length ?? 0) >= 2
  const introduction = () => (profile() ? introductionState(profile()!) : "available")
  const updateProfile = (value: CompanionInfo) =>
    queryClient.setQueryData<CompanionInfo[]>(profileKey(), (current) => upsertCompanion(current, value))
  // 261119 Red Adopt an avatar shipped inside an imported companion workspace once: re-encode it
  // through the client's bounded avatar pipeline and store it in local media settings. A removed
  // avatar is an explicit empty entry, so only "never set" is adopted, and only one attempt per
  // session prevents a failing conversion from retrying on every render.
  const adoptedAvatars = new Set<string>()
  createEffect(() => {
    const selected = profile()
    if (!selected || !settings.mediaReady() || adoptedAvatars.has(selected.soulID)) return
    if (settings.personalization.hasSoulAvatar(selected.soulID)) return
    adoptedAvatars.add(selected.soulID)
    void (async () => {
      try {
        const details = (await sdk.client.companion.get({ id: selected.id }, { throwOnError: true })).data
        if (!details.avatar) return
        const blob = await (await fetch(details.avatar)).blob()
        const image = await prepareSoulAvatar(new File([blob], "avatar", { type: blob.type }))
        settings.personalization.setSoulAvatar(selected.soulID, image)
      } catch (error) {
        console.warn("Adopting the companion avatar failed", error)
      }
    })()
  })
  createEffect(() => {
    const first = profiles.data?.[0]
    if (!first || !workspace.ready()) return
    attachments.assignDefault(first.id)
    if (workspace.drafts().default) workspace.assignDraft(first.id)
    const selected = profile()
    if (selected && workspace.selected() !== selected.id) workspace.select(selected.id)
  })
  const choose = (id: string) => {
    navigationEpoch++
    setSearch({ companion: id })
    workspace.select(id)
  }
  const soul = createMemo(() => {
    const selected = profile()
    if (!selected) return
    return {
      ...souls.data?.find((item) => item.id === selected.soulID),
      id: selected.soulID,
      name: selected.name,
      displayName: selected.name,
    }
  })
  const sessions = useCompanionHistory(profile)
  const models = useModels()
  const directory = () => profile()?.directory ?? ""
  const catalog = models.catalog(useProviders(directory))
  const preferred = createMemo(() => {
    const stored = models.chat.get(directory())
    // Sessions from before Chat remembered draft choices already carry the last sent model.
    const previous = sessions.data?.[0]?.model
    return stored === undefined && previous
      ? { providerID: previous.providerID, modelID: previous.id, variant: previous.variant }
      : stored
  })
  const choice = createMemo(() => {
    const candidate = preferred()
    if (!candidate || !catalog.visible(candidate)) return
    const model = catalog.find(candidate)
    if (!model) return
    return {
      providerID: candidate.providerID,
      modelID: candidate.modelID,
      variant: candidate.variant && model.variants?.[candidate.variant] ? candidate.variant : undefined,
    }
  })
  const chooseModel = (model: ModelKey | undefined) => {
    const current = choice()
    if (model && current?.providerID === model.providerID && current.modelID === model.modelID) return
    models.chat.set(directory(), model ?? null)
  }
  const modelReady = () => models.ready() && (!preferred() || catalog.ready())
  const openSettings = (tab: "chat" | "providers" | "models" = "chat") =>
    void import("@/components/dialog-settings").then((module) =>
      dialog.show(() => <module.DialogSettings initialTab={tab} />),
    )
  const createCompanion = async () => {
    if (!ready() || state.creating || initializing()) return
    const requestID = workspace.requestID()
    const epoch = ++navigationEpoch
    setState({ creating: true, createError: "" })
    try {
      const { data } = await sdk.client.companion.create(
        { companionCreateInput: { requestID } },
        { throwOnError: true },
      )
      updateProfile(data.profile)
      workspace.finishRequest(requestID)
      void queryClient.invalidateQueries({ queryKey: ["soul", sdk.url, "list"] })
      if (mounted && epoch === navigationEpoch) choose(data.profile.id)
    } catch (error) {
      setState("createError", errorMessage(error, language.t("common.requestFailed")))
    } finally {
      setState("creating", false)
    }
  }
  const seedSession = (session: Session) => {
    const [, setStore] = sync.child(session.directory, { bootstrap: false })
    setStore(
      "session",
      produce((list) => {
        const match = Binary.search(list, session.id, (item) => item.id)
        if (match.found) list[match.index] = session
        else list.splice(match.index, 0, session)
      }),
    )
  }
  const send = createChatHomeSubmit({
    ready: () => !!ready() && modelReady() && !missing() && !state.creating && !attachments.pending(draftKey()),
    profile,
    text,
    options: (scope, kind) => ({
      model: choice() && { providerID: choice()!.providerID, modelID: choice()!.modelID },
      variant: choice()?.variant,
      files:
        kind === "message"
          ? attachments.files(scope).map(({ id, mime, filename, url }) => ({ id, mime, filename, url }))
          : [],
    }),
    currentID: () => profile()?.id,
    epoch: () => navigationEpoch,
    mounted: () => mounted,
    get: workspace.submission,
    set: workspace.setSubmission,
    initialize: async () => (await sdk.client.companion.initialize({ throwOnError: true })).data.profile,
    prepare: (selected) => requireCompanionModel(sdk.client, selected.directory, language.t("chat.companion.noModels")),
    activate: async (selected) => {
      const { data } = await sdk.client.companion.update(
        { id: selected.id, companionUpdateInput: { introduction: "active" } },
        { throwOnError: true },
      )
      queryClient.setQueryData(["companion", sdk.url, "detail", selected.id], data)
      return data.profile
    },
    createSession: async (selected) =>
      (
        await sdk.client.session.create(
          { directory: selected.directory, mode: "chat", companionID: selected.id },
          { throwOnError: true },
        )
      ).data,
    getSession: async (session) => {
      const result = await sdk.client.session.get(
        { directory: session.directory, sessionID: session.id },
        { throwOnError: false },
      )
      if (result.data) return result.data
      if (result.response?.status === 404) return
      throw result.error
    },
    submit: (session, messageID, content, options) =>
      sendCompanionMessage({
        client: sdk.client,
        listen: sdk.event.on,
        session,
        messageID,
        text: content,
        model: options.model,
        variant: options.variant,
        files: options.files.map(({ mime, filename, url }) => ({ mime, filename, url })),
        timeoutMessage: language.t("chat.companion.unconfirmed"),
      }),
    receivedProfile: (selected) => {
      updateProfile(selected)
      void queryClient.invalidateQueries({ queryKey: ["soul", sdk.url, "list"] })
    },
    selectInitialized: workspace.select,
    assignDraft,
    clearDraft: workspace.clearDraft,
    accepted: (session, options) => {
      // 附件跟着这一条消息一起被接收，成功后清空；失败路径不动，草稿与附件都留着可重试。
      attachments.remove(new Set(options.files.map((file) => file.id)))
      if (options.model) models.chat.set(session.directory, { ...options.model, variant: options.variant })
      seedSession(session)
      recordCompanionMessageAccepted(queryClient, sdk.url, session)
      void queryClient.invalidateQueries({ queryKey: ["companion", sdk.url, session.companionID, "sessions"] })
    },
    navigate: (session) => navigate(`/${base64Encode(session.directory)}/session/${session.id}`),
    introductionText: (selected) =>
      language.t(
        !selected || introductionState(selected) === "available"
          ? "chat.introduction.message"
          : "chat.introduction.resumeMessage",
      ),
    nextMessageID: () => Identifier.ascending("message"),
    error: (error) => errorMessage(error, language.t("common.requestFailed")),
    invalidSession: () => language.t("chat.companion.sessionMismatch"),
  })
  const setIntroduction = async (introduction: "paused" | "complete") => {
    const selected = profile()
    if (!selected || state.changingIntroduction) return
    setState("changingIntroduction", true)
    try {
      const { data } = await sdk.client.companion.update(
        { id: selected.id, companionUpdateInput: { introduction } },
        { throwOnError: true },
      )
      updateProfile(data.profile)
    } catch (error) {
      workspace.setSubmission(selected.id, { error: errorMessage(error, language.t("common.requestFailed")) })
    } finally {
      setState("changingIntroduction", false)
    }
  }
  return (
    <div data-component="chat-home" class="size-full">
      <CompanionChatFrame
        profile={profile()}
        history={sessions}
        options={
          <>
            <Show when={profiles.data?.length}>
              <select
                aria-label={language.t("settings.companion.choose")}
                class="max-w-48 rounded-lg border border-border-base bg-background-base px-3 py-2 text-13-regular"
                value={profile()?.id ?? ""}
                onChange={(event) => choose(event.currentTarget.value)}
              >
                <Show when={!profile()}>
                  <option value="" disabled>
                    {language.t("settings.companion.choose")}
                  </option>
                </Show>
                <For each={profiles.data}>{(item) => <option value={item.id}>{item.name}</option>}</For>
              </select>
            </Show>
            <Button
              variant="secondary"
              disabled={!ready() || state.creating || atCapacity() || initializing()}
              onClick={() => void createCompanion()}
            >
              {language.t(state.creating ? "chat.companion.creating" : "chat.companion.new")}
            </Button>
            <Show when={ready() && !missing() && introduction() === "available"}>
              <>
                <Button
                  variant="secondary"
                  disabled={submission()?.sending || state.creating || initializing()}
                  onClick={() => void send("introduction")}
                >
                  {language.t("chat.introduction.start")}
                </Button>
              </>
            </Show>
            <Show when={ready() && profile() && (introduction() === "active" || introduction() === "paused")}>
              <>
                <Button variant="secondary" disabled={submission()?.sending} onClick={() => void send("introduction")}>
                  {language.t("chat.introduction.resume")}
                </Button>
                <Show when={introduction() === "active"}>
                  <Button
                    variant="ghost"
                    disabled={state.changingIntroduction || submission()?.sending}
                    onClick={() => void setIntroduction("paused")}
                  >
                    {language.t("chat.introduction.pause")}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={state.changingIntroduction || submission()?.sending}
                    onClick={() => void setIntroduction("complete")}
                  >
                    {language.t("chat.introduction.finish")}
                  </Button>
                </Show>
              </>
            </Show>
          </>
        }
      >
        <div class="companion-home-scroll">
          <div class="companion-home-center">
            <div class="companion-greeting">
              <Show when={profile()}>{(selected) => <SoulAvatar id={selected().soulID} soul={soul()} />}</Show>
              <h1>
                {settings.userProfile.displayName()
                  ? language.t("chat.ui.greetingNamed", { name: settings.userProfile.displayName() })
                  : language.t("chat.ui.greeting")}
              </h1>
            </div>
            <Show when={state.createError}>
              <div role="alert" class="flex flex-wrap items-center gap-3 text-13-regular text-text-on-critical-base">
                <p>{state.createError}</p>
                <Button variant="secondary" disabled={state.creating} onClick={() => void createCompanion()}>
                  {language.t("common.retry")}
                </Button>
              </div>
            </Show>
            <Show when={submissionError() || profiles.error}>
              <div
                role="alert"
                class="flex flex-col gap-3 rounded-xl border border-border-critical-base bg-surface-critical-weak p-4 text-13-regular text-text-strong"
              >
                <p>{submissionError() || errorMessage(profiles.error, language.t("common.requestFailed"))}</p>
                <div class="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    disabled={submission()?.sending}
                    onClick={() => (profiles.error ? void profiles.refetch() : void send(submission()?.kind))}
                  >
                    {language.t("common.retry")}
                  </Button>
                  <Button variant="ghost" onClick={() => openSettings("providers")}>
                    {language.t("chat.companion.providers")}
                  </Button>
                  <Button variant="ghost" onClick={() => openSettings("models")}>
                    {language.t("chat.companion.models")}
                  </Button>
                </div>
              </div>
            </Show>
            <Show when={missing()}>
              <p role="alert" class="text-13-regular text-text-weak">
                {language.t("chat.profile.missing")}
              </p>
            </Show>
            <form
              class="companion-home-composer"
              onSubmit={(event) => {
                event.preventDefault()
                void send()
              }}
            >
              <Show when={attachmentError()}>
                <p role="alert" class="px-1 text-12-regular text-text-on-critical-base">
                  {attachmentError()}
                </p>
              </Show>
              <Show when={attachments.files(draftKey()).length > 0}>
                <ul class="flex flex-wrap gap-1.5 px-1 pt-1">
                  <For each={attachments.files(draftKey())}>
                    {(file) => (
                      <li class="flex max-w-full items-center gap-1.5 rounded-lg border border-border-weak-base bg-surface-raised-base py-0.5 pr-1 pl-2 text-12-regular text-text-weak">
                        <span class="min-w-0 truncate">{file.filename}</span>
                        <button
                          type="button"
                          class="shrink-0 rounded p-0.5 text-text-weaker hover:text-text-strong focus-visible:outline-2 focus-visible:outline-border-focus"
                          aria-label={language.t("chat.composer.removeFile", { name: file.filename })}
                          onClick={() => attachments.remove(new Set([file.id]))}
                        >
                          <Icon name="close-small" size="small" />
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <textarea
                data-action="chat-first-message"
                aria-label={language.t("chat.native.placeholder")}
                placeholder={language.t("chat.native.placeholder")}
                value={text()}
                rows={1}
                disabled={submission()?.sending || !ready() || missing()}
                onInput={(event) => workspace.setDraft(draftKey(), event.currentTarget.value)}
                onPaste={(event) => {
                  const pasted = Array.from(event.clipboardData?.files ?? [])
                  if (pasted.length === 0) return
                  event.preventDefault()
                  void attachments.add(draftKey(), pasted)
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                    event.preventDefault()
                    void send()
                  }
                }}
              />
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex min-w-0 flex-wrap items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="small"
                    icon="plus-small"
                    aria-label={language.t("chat.composer.addFile")}
                    disabled={submission()?.sending || !ready() || missing()}
                    onClick={() => filePicker?.click()}
                  />
                  <input
                    ref={filePicker}
                    type="file"
                    multiple
                    hidden
                    onChange={(event) => {
                      void attachments.add(draftKey(), Array.from(event.currentTarget.files ?? []))
                      event.currentTarget.value = ""
                    }}
                  />
                  <ChatComposerTools
                    disabled={submission()?.sending || !ready() || missing()}
                    directory={directory}
                    catalog={catalog}
                    model={choice()}
                    variant={choice()?.variant}
                    onManage={() => openSettings("models")}
                    onConnect={() => openSettings("providers")}
                    onModelChange={chooseModel}
                    onVariantChange={(variant) => {
                      const current = choice()
                      if (current) models.chat.set(directory(), { ...current, variant })
                    }}
                  />
                </div>
                <button
                  type="submit"
                  class="companion-send"
                  aria-label={language.t(submission()?.sending ? "chat.opening" : "chat.native.send")}
                  disabled={
                    submission()?.sending ||
                    attachments.pending(draftKey()) ||
                    !text().trim() ||
                    !modelReady() ||
                    !ready() ||
                    missing() ||
                    state.creating ||
                    initializing()
                  }
                >
                  <Icon name="paper-plane" />
                </button>
              </div>
            </form>
          </div>
        </div>
      </CompanionChatFrame>
    </div>
  )
}
