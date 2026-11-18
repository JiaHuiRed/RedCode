import { Button } from "@redcode-ai/ui/button"
import { Dialog } from "@redcode-ai/ui/dialog"
import { TextField } from "@redcode-ai/ui/text-field"
import { Markdown } from "@redcode-ai/ui/markdown"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { useNavigate, useParams } from "@solidjs/router"
import { batch, createEffect, createMemo, For, on, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import { useSettings } from "@/context/settings"
import { persisted } from "@/utils/persist"
import { base64Encode } from "@redcode-ai/core/util/encode"
import { decode64 } from "@/utils/base64"
import { SoulAvatar } from "./soul-avatar"
import { SoulAvatarPicker } from "./soul-avatar-picker"
import { SettingsSoulEditor, SettingsSourceActions } from "./settings-soul-editor"

export type SoulCreateInput =
  | { markdown: string }
  | {
      id: string
      name: string
      displayName?: string
      commitPrefix?: string
      avatar?: string
      description?: string
      content: string
    }
export type SoulCreated = { id: string; name?: string; displayName?: string }
const SOUL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/

function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (typeof error !== "object" || error === null) return undefined
  const value = error as { message?: unknown; error?: unknown; data?: { message?: unknown } }
  if (typeof value.message === "string" && value.message) return value.message
  if (typeof value.error === "string" && value.error) return value.error
  if (typeof value.data?.message === "string" && value.data.message) return value.data.message
  return undefined
}

export const SettingsPersonalization: Component = () => {
  const language = useLanguage()
  const settings = useSettings()
  const sdk = useGlobalSDK()
  const sync = useServerSync()
  const params = useParams()
  const dialog = useDialog()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [view, setView] = createStore({ selectedId: "", search: "", detail: false, feedback: "" })
  const souls = useQuery(() => ({
    queryKey: ["soul", sdk.url, "list"],
    queryFn: async () => (await sdk.client.soul.list({ throwOnError: true })).data,
  }))
  const companions = useQuery(() => ({
    queryKey: ["companion", sdk.url, "list"],
    queryFn: async () => (await sdk.client.companion.list({ throwOnError: true })).data,
  }))
  const issues = useQuery(() => ({
    queryKey: ["soul", sdk.url, "issues"],
    queryFn: async () => (await sdk.client.soul.issues({ throwOnError: true })).data,
  }))
  const serverDefault = useQuery(() => ({
    queryKey: ["soul", sdk.url, "default", "desktop"],
    queryFn: async () => (await sdk.client.soul.default({ client: "desktop" }, { throwOnError: true })).data,
  }))
  const boundIDs = createMemo(() => new Set(companions.data?.map((profile) => profile.soulID) ?? []))
  const soulsList = createMemo(() =>
    companions.data ? (souls.data ?? []).filter((soul) => !boundIDs().has(soul.id)) : [],
  )
  const effectiveDefaultId = () => settings.personalization.lastSoul() || serverDefault.data?.id
  const boundDefault = () => !!effectiveDefaultId() && boundIDs().has(effectiveDefaultId()!)
  const defaultSoul = createMemo(() => soulsList().find((soul) => soul.id === effectiveDefaultId()))
  const selected = createMemo(() => soulsList().find((soul) => soul.id === view.selectedId))
  const filtered = createMemo(() => {
    const query = view.search.trim().toLocaleLowerCase()
    return query
      ? soulsList().filter((soul) =>
          [soul.displayName, soul.name, soul.id, soul.description, soul.commitPrefix].some((value) =>
            value?.toLocaleLowerCase().includes(query),
          ),
        )
      : soulsList()
  })
  const detail = useQuery(() => ({
    queryKey: ["soul", sdk.url, "detail", view.selectedId],
    enabled: view.detail && !!selected(),
    queryFn: async () => (await sdk.client.soul.get({ id: view.selectedId }, { throwOnError: true })).data,
  }))
  const directory = createMemo(() => (params.dir ? decode64(params.dir) : undefined))
  const codeDirectory = createMemo(() => {
    const dir = directory()
    if (!dir || !companions.data || companions.data.some((profile) => profile.directory === dir)) return undefined
    return dir
  })
  const currentSession = createMemo(() => {
    const dir = directory()
    if (!dir || !params.id) return undefined
    const session = sync.peek(dir, { bootstrap: false })[0].session.find((item) => item.id === params.id)
    return session?.mode === "chat" ? undefined : session
  })
  const selectSoul = (id: string) => {
    setView({ selectedId: id, detail: true, feedback: "" })
  }
  const startWithSoul = (id: string) => {
    const dir = codeDirectory()
    if (!dir || boundIDs().has(id)) return
    dialog.close()
    navigate(`/${base64Encode(dir)}/session?soul=${encodeURIComponent(id)}`)
  }
  const setDefault = (id: string) => {
    if (boundIDs().has(id)) return
    settings.personalization.setLastSoul(id)
    setView("feedback", language.t("settings.personalization.saved"))
  }
  const createSoul = async (input: SoulCreateInput) => {
    const created = (await sdk.client.soul.create(input, { throwOnError: true })).data
    queryClient.setQueryData<typeof souls.data>(["soul", sdk.url, "list"], (current) => [
      ...(current ?? []).filter((soul) => soul.id !== created.id),
      created,
    ])
    void queryClient.invalidateQueries({ queryKey: ["soul", sdk.url, "list"] })
    void issues.refetch()
    void queryClient.invalidateQueries({ queryKey: ["soul", sdk.url, "detail", created.id] })
    selectSoul(created.id)
    dialog.close()
    return created
  }
  const openCreate = (seed?: SoulCreateSeed) =>
    dialog.push(() => (
      <Dialog
        class="settings-editor-dialog"
        size="large"
        title={language.t("settings.soulCode.new")}
        description={language.t("settings.personalization.create.description")}
      >
        <SoulCreateForm create={createSoul} seed={seed} />
      </Dialog>
    ))
  const copySoul = () => {
    const data = detail.data
    if (!data) return
    openCreate({
      id: `${data.id}-copy`,
      name: data.name,
      displayName: data.displayName,
      commitPrefix: data.commitPrefix,
      avatar: data.avatar,
      description: data.description,
      content: data.content,
    })
  }
  return (
    <div class="settings-page-body" data-component="settings-code-soul">
      <Show
        when={view.detail && selected()}
        fallback={
          <>
            <header class="flex items-start justify-between gap-4">
              <div>
                <h2 class="settings-page-title">{language.t("settings.soulCode.title")}</h2>
                <p class="settings-page-description">{language.t("settings.soulCode.description")}</p>
              </div>
              <Button variant="primary" onClick={() => openCreate()}>
                {language.t("settings.soulCode.new")}
              </Button>
            </header>
            <section class="flex flex-col gap-4 rounded-xl border border-border-weak-base bg-surface-base p-5">
              <div>
                <h3 class="text-14-medium text-text-strong">{language.t("settings.soulCode.default")}</h3>
                <p class="mt-1 text-12-regular text-text-weak">{language.t("settings.soulCode.defaultDescription")}</p>
              </div>
              <Show when={defaultSoul()}>
                {(soul) => (
                  <div class="flex items-center gap-3">
                    <SoulAvatar soul={soul()} />
                    <div class="min-w-0 flex-1">
                      <p class="text-14-medium text-text-strong">{soul().displayName || soul().name}</p>
                      <p class="text-12-regular text-text-weak">{soul().description}</p>
                    </div>
                    <Button variant="secondary" size="small" onClick={() => selectSoul(soul().id)}>
                      {language.t("settings.personalization.viewDetails")}
                    </Button>
                  </div>
                )}
              </Show>
              <Show when={boundDefault()}>
                <p role="status" class="text-13-regular text-text-weak">
                  {language.t("settings.soulCode.boundDefault")}
                </p>
              </Show>
              <Show when={!defaultSoul() && !boundDefault() && !souls.isPending && !serverDefault.isPending}>
                <p class="text-13-regular text-text-weak">{language.t("settings.personalization.noDefault")}</p>
              </Show>
              <Show when={settings.personalization.lastSoul()}>
                <div>
                  <Button
                    variant="ghost"
                    size="small"
                    disabled={!!serverDefault.data?.id && boundIDs().has(serverDefault.data.id)}
                    onClick={() => {
                      settings.personalization.setLastSoul("")
                      setView("feedback", language.t("settings.personalization.saved"))
                    }}
                  >
                    {language.t("settings.personalization.useServerDefault")}
                  </Button>
                </div>
              </Show>
            </section>
            <section class="flex flex-col gap-4">
              <h3 class="text-14-medium text-text-strong">{language.t("settings.personalization.roster")}</h3>
              <TextField
                value={view.search}
                onChange={(value) => setView("search", value)}
                placeholder={language.t("settings.personalization.search")}
                aria-label={language.t("settings.personalization.search")}
              />
              <Show when={companions.isPending || souls.isPending}>
                <p role="status" class="text-13-regular text-text-weak">
                  {language.t("common.loading")}
                </p>
              </Show>
              <Show when={companions.data && souls.data && !filtered().length}>
                <p class="text-13-regular text-text-weak">
                  {language.t(
                    soulsList().length ? "settings.personalization.noResults" : "settings.personalization.empty",
                  )}
                </p>
              </Show>
              <div class="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr))]">
                <For each={filtered()}>
                  {(soul) => (
                    <button
                      type="button"
                      class="flex items-start gap-3 rounded-xl border border-border-weak-base bg-surface-base p-4 text-left transition-colors hover:bg-surface-raised-base focus-visible:outline-2 focus-visible:outline-border-focus"
                      onClick={() => selectSoul(soul.id)}
                      aria-label={language.t("settings.personalization.selectSoul", {
                        name: soul.displayName || soul.name,
                      })}
                    >
                      <SoulAvatar soul={soul} />
                      <div class="min-w-0 flex-1">
                        <p class="flex flex-wrap items-center gap-2 text-14-medium text-text-strong">
                          {soul.displayName || soul.name}
                          <Show when={soul.id === effectiveDefaultId()}>
                            <span class="rounded-md bg-surface-raised-base px-2 py-0.5 text-12-regular text-text-weak">
                              {language.t("settings.personalization.defaultBadge")}
                            </span>
                          </Show>
                        </p>
                        <p class="mt-1 break-words text-12-regular text-text-weak">{soul.description || soul.name}</p>
                      </div>
                    </button>
                  )}
                </For>
              </div>
              <p class="text-12-regular text-text-weak">{language.t("settings.soulCode.chatSeparate")}</p>
            </section>
          </>
        }
      >
        {(soul) => (
          <>
            <Button size="small" variant="ghost" onClick={() => setView("detail", false)}>
              {language.t("settings.soulCode.back")}
            </Button>
            <header class="flex flex-wrap items-center gap-4">
              <SoulAvatar soul={soul()} size="large" />
              <div class="min-w-0 flex-1">
                <h2 class="settings-page-title">{soul().displayName || soul().name}</h2>
                <p class="settings-page-description">{soul().description || soul().name}</p>
              </div>
              <Show when={codeDirectory()}>
                <Button variant="primary" onClick={() => startWithSoul(soul().id)}>
                  {language.t("settings.soulCode.start")}
                </Button>
              </Show>
            </header>
            <div class="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                disabled={soul().id === effectiveDefaultId()}
                onClick={() => setDefault(soul().id)}
              >
                {language.t(
                  soul().id === effectiveDefaultId()
                    ? "settings.personalization.defaultBadge"
                    : "settings.personalization.setDefault",
                )}
              </Button>
              <Button variant="ghost" disabled={!detail.data} onClick={copySoul}>
                {language.t("settings.personalization.copySoul")}
              </Button>
            </div>
            <Show when={detail.data}>
              {(data) => (
                <section class="flex flex-col gap-4 rounded-xl border border-border-weak-base bg-surface-base p-5">
                  <div class="flex items-center justify-between gap-4">
                    <h3 class="text-14-medium text-text-strong">{language.t("settings.soulCode.body")}</h3>
                    <Button
                      variant="primary"
                      onClick={() => {
                        const id = data().id
                        dialog.push(() => <SettingsSoulEditor id={id} metadata />)
                      }}
                    >
                      {language.t("common.edit")}
                    </Button>
                  </div>
                  <p class="text-12-regular text-text-weak">{language.t("settings.editor.later")}</p>
                  <SettingsSourceActions path={data().path} onRefresh={() => detail.refetch({ throwOnError: true })} />
                  <div class="min-w-0 break-words py-2">
                    <Markdown text={data().content} cacheKey={`soul:${data().id}:${data().content}`} />
                  </div>
                  <SoulAvatarPicker soul={data()} />
                  <details class="rounded-lg border border-border-weak-base p-4">
                    <summary class="cursor-pointer text-13-medium text-text-weak">
                      {language.t("settings.personalization.advancedInfo")}
                    </summary>
                    <dl class="mt-3 grid gap-3 sm:grid-cols-2">
                      <For each={["id", "name", "displayName", "commitPrefix", "avatar", "description"] as const}>
                        {(field) => (
                          <div class="min-w-0">
                            <dt class="text-12-medium text-text-weak">{field}</dt>
                            <dd class="mt-1 break-all text-13-regular text-text-strong">{data()[field] || "—"}</dd>
                          </div>
                        )}
                      </For>
                    </dl>
                  </details>
                </section>
              )}
            </Show>
            <Show when={detail.isPending}>
              <p role="status" class="text-13-regular text-text-weak">
                {language.t("common.loading")}
              </p>
            </Show>
            <Show when={currentSession()?.soul === soul().id}>
              <p class="mt-4 text-12-regular text-text-weak">
                {language.t("settings.personalization.currentSessionNotice")}
              </p>
            </Show>
          </>
        )}
      </Show>
      <Show when={view.feedback}>
        <p role="status" class="mt-4 text-13-regular text-text-success-base">
          {view.feedback}
        </p>
      </Show>
      <Show when={souls.error || companions.error || serverDefault.error || detail.error}>
        <div role="alert" class="mt-4 flex flex-wrap items-center gap-3 text-13-regular text-text-on-critical-base">
          <p>
            {errorMessage(souls.error || companions.error || serverDefault.error || detail.error) ??
              language.t("common.requestFailed")}
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              void souls.refetch()
              void companions.refetch()
              void serverDefault.refetch()
              if (selected()) void detail.refetch()
            }}
          >
            {language.t("common.retry")}
          </Button>
        </div>
      </Show>
      <Show when={issues.data?.length}>
        <details class="mt-6 rounded-lg border border-border-weak-base p-4">
          <summary class="cursor-pointer text-13-medium text-text-weak">
            {language.t("settings.soulCode.registryIssues")}
          </summary>
          <ul class="mt-3 space-y-2">
            <For each={issues.data}>
              {(issue) => (
                <li class="break-all text-12-regular text-text-on-critical-base">
                  <code>{issue.path}</code>: {issue.message}
                </li>
              )}
            </For>
          </ul>
        </details>
      </Show>
      <Show when={issues.error}>
        <div class="mt-4 text-12-regular text-text-on-critical-base">
          <p role="alert">{errorMessage(issues.error) ?? language.t("common.requestFailed")}</p>
          <Button variant="ghost" size="small" onClick={() => void issues.refetch()}>
            {language.t("common.retry")}
          </Button>
        </div>
      </Show>
    </div>
  )
}

// 261115 Red UX-13 复制预填：从现有 Soul 带字段进创建表单。
export type SoulCreateSeed = {
  id: string
  name: string
  displayName?: string
  commitPrefix?: string
  avatar?: string
  description?: string
  content: string
}

export const SoulCreateForm: Component<{
  create: (input: SoulCreateInput) => Promise<SoulCreated>
  seed?: SoulCreateSeed | undefined
  // 创建成功后「以此 Soul 新建会话」（UX-13 创建即用）；无目标目录的入口不传。
  onStart?: (id: string) => void
}> = (props) => {
  const language = useLanguage()
  // 261115 Red UX-13 草稿持久化：写到一半关设置再打开可恢复（此前是组件局部 store，
  // 弹层一关就没了）。busy/error/message 是瞬态，留在 state 不落盘。
  const [draft, setDraft] = createStore({
    mode: "markdown" as "markdown" | "fields",
    markdown: "",
    id: "",
    name: "",
    displayName: "",
    commitPrefix: "",
    avatar: "",
    description: "",
    content: "",
  })
  persisted("settings.personalization.createDraft.v1", [draft, setDraft])
  const [state, setState] = createStore({
    busy: false,
    error: "",
    message: "",
    fieldErrors: { id: "", name: "", content: "" },
    created: undefined as SoulCreated | undefined,
  })

  // 复制预填：seed 变化（每次点「复制此 Soul」都是新对象）就整体覆盖草稿并切 fields 模式。
  createEffect(
    on(
      () => props.seed,
      (value) => {
        if (!value) return
        batch(() => {
          setDraft({
            mode: "fields",
            id: value.id,
            name: value.name,
            displayName: value.displayName ?? "",
            commitPrefix: value.commitPrefix ?? "",
            avatar: value.avatar ?? "",
            description: value.description ?? "",
            content: value.content,
          })
        })
        setState({ fieldErrors: { id: "", name: "", content: "" }, error: "", created: undefined })
      },
    ),
  )

  // 所有提交共用：busy 期间直接返回（按钮已 disabled，这里是第二道闸）；失败保留输入。
  const submit = async (input: SoulCreateInput) => {
    if (state.busy) return
    setState({ busy: true, error: "", message: "" })
    try {
      const created = await props.create(input)
      batch(() => {
        setDraft({
          markdown: "",
          id: "",
          name: "",
          displayName: "",
          commitPrefix: "",
          avatar: "",
          description: "",
          content: "",
        })
      })
      setState({
        busy: false,
        fieldErrors: { id: "", name: "", content: "" },
        created,
        message: language.t("settings.personalization.create.created", {
          name: created.displayName || created.name || created.id,
        }),
      })
    } catch (error) {
      setState({
        busy: false,
        error: errorMessage(error) ?? language.t("settings.personalization.create.failed"),
      })
    }
  }

  const submitMarkdown = (event: SubmitEvent) => {
    event.preventDefault()
    if (!draft.markdown.trim()) {
      setState({ error: language.t("settings.personalization.create.markdownRequired"), message: "" })
      return
    }
    // 整份原文直接交给服务端按同一套 frontmatter 规则解析，不在浏览器里拆分字段。
    void submit({ markdown: draft.markdown })
  }

  const submitFields = (event: SubmitEvent) => {
    event.preventDefault()
    const id = draft.id.trim()
    const name = draft.name.trim()
    const content = draft.content.trim()
    const fieldErrors = {
      id: !id
        ? language.t("settings.personalization.create.idRequired")
        : SOUL_ID_PATTERN.test(id)
          ? ""
          : language.t("settings.personalization.create.idInvalid"),
      name: name ? "" : language.t("settings.personalization.create.nameRequired"),
      content: content ? "" : language.t("settings.personalization.create.contentRequired"),
    }
    setState({ fieldErrors, error: "", message: "" })
    if (fieldErrors.id || fieldErrors.name || fieldErrors.content) return
    void submit({
      id,
      name,
      displayName: draft.displayName.trim() || undefined,
      commitPrefix: draft.commitPrefix.trim() || undefined,
      avatar: draft.avatar.trim() || undefined,
      description: draft.description.trim() || undefined,
      content,
    })
  }

  return (
    <div class="flex flex-col gap-3">
      <div
        role="group"
        aria-label={language.t("settings.personalization.create.modeLabel")}
        class="flex flex-wrap gap-2"
      >
        <Button
          type="button"
          size="small"
          variant={draft.mode === "markdown" ? "secondary" : "ghost"}
          aria-pressed={draft.mode === "markdown"}
          disabled={state.busy}
          onClick={() => {
            setDraft("mode", "markdown")
            setState("error", "")
          }}
        >
          {language.t("settings.personalization.create.modeMarkdown")}
        </Button>
        <Button
          type="button"
          size="small"
          variant={draft.mode === "fields" ? "secondary" : "ghost"}
          aria-pressed={draft.mode === "fields"}
          disabled={state.busy}
          onClick={() => {
            setDraft("mode", "fields")
            setState("error", "")
          }}
        >
          {language.t("settings.personalization.create.modeFields")}
        </Button>
      </div>
      <Show when={draft.mode === "markdown"}>
        <form class="flex flex-col gap-3" onSubmit={submitMarkdown}>
          <TextField
            label={language.t("settings.personalization.create.markdownLabel")}
            description={language.t("settings.personalization.create.markdownDescription")}
            placeholder={language.t("settings.personalization.create.markdownPlaceholder")}
            value={draft.markdown}
            onChange={(value) => {
              setDraft("markdown", value)
              setState("error", "")
            }}
            disabled={state.busy}
            multiline
            spellcheck={false}
            autocomplete="off"
            class="max-h-80 overflow-y-auto font-mono text-12-regular"
          />
          <div class="flex flex-wrap items-center gap-3">
            <Button type="submit" size="small" disabled={state.busy}>
              {language.t(
                state.busy
                  ? "settings.personalization.create.submitting"
                  : "settings.personalization.create.markdownSubmit",
              )}
            </Button>
          </div>
        </form>
      </Show>
      <Show when={draft.mode === "fields"}>
        <form class="flex flex-col gap-3" onSubmit={submitFields}>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <TextField
              label={language.t("settings.personalization.create.idLabel")}
              description={language.t("settings.personalization.create.idDescription")}
              placeholder={language.t("settings.personalization.create.idPlaceholder")}
              value={draft.id}
              onChange={(value) => {
                setDraft("id", value)
                setState({ error: "", fieldErrors: { ...state.fieldErrors, id: "" } })
              }}
              error={state.fieldErrors.id}
              validationState={state.fieldErrors.id ? "invalid" : undefined}
              disabled={state.busy}
              spellcheck={false}
              autocomplete="off"
            />
            <TextField
              label={language.t("settings.personalization.create.nameLabel")}
              value={draft.name}
              onChange={(value) => {
                setDraft("name", value)
                setState({ error: "", fieldErrors: { ...state.fieldErrors, name: "" } })
              }}
              error={state.fieldErrors.name}
              validationState={state.fieldErrors.name ? "invalid" : undefined}
              disabled={state.busy}
              autocomplete="off"
            />
            <TextField
              label={language.t("settings.personalization.create.displayNameLabel")}
              value={draft.displayName}
              onChange={(value) => {
                setDraft("displayName", value)
                setState("error", "")
              }}
              disabled={state.busy}
              autocomplete="off"
            />
            <TextField
              label={language.t("settings.personalization.create.commitPrefixLabel")}
              value={draft.commitPrefix}
              onChange={(value) => {
                setDraft("commitPrefix", value)
                setState("error", "")
              }}
              disabled={state.busy}
              autocomplete="off"
            />
            <TextField
              label={language.t("settings.personalization.create.avatarLabel")}
              description={language.t("settings.personalization.create.avatarDescription")}
              value={draft.avatar}
              onChange={(value) => {
                setDraft("avatar", value)
                setState("error", "")
              }}
              disabled={state.busy}
              spellcheck={false}
              autocomplete="off"
            />
            <TextField
              label={language.t("settings.personalization.create.descriptionLabel")}
              description={language.t("settings.personalization.create.descriptionHint")}
              value={draft.description}
              onChange={(value) => {
                setDraft("description", value)
                setState("error", "")
              }}
              disabled={state.busy}
            />
          </div>
          <TextField
            label={language.t("settings.personalization.create.contentLabel")}
            placeholder={language.t("settings.personalization.create.contentPlaceholder")}
            value={draft.content}
            onChange={(value) => {
              setDraft("content", value)
              setState({ error: "", fieldErrors: { ...state.fieldErrors, content: "" } })
            }}
            error={state.fieldErrors.content}
            validationState={state.fieldErrors.content ? "invalid" : undefined}
            disabled={state.busy}
            multiline
            spellcheck={false}
            class="min-h-32 max-h-60 overflow-y-auto font-mono text-12-regular"
          />
          <div class="flex flex-wrap items-center gap-2">
            <Button type="submit" size="small" disabled={state.busy}>
              {language.t(
                state.busy
                  ? "settings.personalization.create.submitting"
                  : "settings.personalization.create.fieldsSubmit",
              )}
            </Button>
          </div>
        </form>
      </Show>
      <div class="flex flex-wrap items-center gap-2">
        <p data-testid="soul-create-message" aria-live="polite" class="text-12-regular text-text-success-base">
          {state.message}
        </p>
        {/* 261115 Red UX-13 创建即用：成功创建后立即以它开新会话（有目标目录的入口才有意义）。 */}
        <Show when={state.created && props.onStart}>
          <Button size="small" variant="secondary" onClick={() => props.onStart?.(state.created!.id)}>
            {language.t("settings.personalization.create.startNew")}
          </Button>
        </Show>
      </div>
      <Show when={state.error}>
        <p data-testid="soul-create-error" role="alert" class="text-12-regular text-text-on-critical-base">
          {state.error}
        </p>
      </Show>
    </div>
  )
}
