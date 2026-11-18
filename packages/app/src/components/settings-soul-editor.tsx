import { createEffect, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import type { SoulGetResponse } from "@redcode-ai/sdk/v2/client"
import { Button } from "@redcode-ai/ui/button"
import { copyText } from "@redcode-ai/ui/clipboard"
import { Dialog } from "@redcode-ai/ui/dialog"
import { TextField } from "@redcode-ai/ui/text-field"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { showToast } from "@redcode-ai/ui/toast"
import { checksum } from "@redcode-ai/core/util/encode"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { Persist, persisted } from "@/utils/persist"
import { errorMessage } from "@/utils/session-helpers"

export const SettingsSourceActions: Component<{
  path?: string
  directory?: boolean
  onRefresh?: () => Promise<unknown> | void
}> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const [state, setState] = createStore({ busy: false, error: "", message: "" })
  const local = () => platform.platform === "desktop" && server.current?.type === "sidecar"
  const run = async (action: "open" | "reveal" | "copy" | "refresh") => {
    if (state.busy) return
    const path = props.path
    if (action !== "refresh" && !path) return
    setState({ busy: true, error: "", message: "" })
    try {
      if (action === "refresh") await props.onRefresh?.()
      if (action === "copy") {
        if (!(await copyText(path!))) throw new Error(language.t("common.requestFailed"))
        setState("message", language.t("settings.source.copied"))
      }
      if (action === "open" && local()) await platform.openPath?.(path!)
      if (action === "reveal" && local()) await platform.revealPath?.(path!)
    } catch (error) {
      setState("error", errorMessage(error, language.t("common.requestFailed")))
    } finally {
      setState("busy", false)
    }
  }
  return (
    <div class="flex min-w-0 flex-col gap-2 rounded-lg bg-surface-raised-base p-3">
      <Show when={props.path}>
        <code class="break-all text-12-regular text-text-weak">{props.path}</code>
        <div class="flex flex-wrap items-center gap-2">
          <Button
            size="small"
            variant="secondary"
            disabled={state.busy || !local() || !platform.openPath}
            title={
              !local()
                ? language.t(server.isLocal() ? "settings.source.unavailable" : "settings.source.remote")
                : undefined
            }
            onClick={() => void run("open")}
          >
            {language.t(props.directory ? "settings.source.folder" : "settings.source.open")}
          </Button>
          <Show when={!props.directory}>
            <Button
              size="small"
              variant="secondary"
              disabled={state.busy || !local() || !platform.revealPath}
              title={
                !local()
                  ? language.t(server.isLocal() ? "settings.source.unavailable" : "settings.source.remote")
                  : undefined
              }
              onClick={() => void run("reveal")}
            >
              {language.t("settings.source.reveal")}
            </Button>
          </Show>
          <Button size="small" variant="ghost" disabled={state.busy} onClick={() => void run("copy")}>
            {language.t("settings.source.copy")}
          </Button>
          <Show when={props.onRefresh}>
            <Button size="small" variant="ghost" disabled={state.busy} onClick={() => void run("refresh")}>
              {language.t("settings.source.refresh")}
            </Button>
          </Show>
        </div>
        <Show when={!local()}>
          <p class="text-12-regular text-text-weak">{language.t("settings.source.remote")}</p>
        </Show>
      </Show>
      <Show when={state.message}>
        <p role="status" class="text-12-regular text-text-weak">
          {state.message}
        </p>
      </Show>
      <Show when={state.error}>
        <p role="alert" class="text-12-regular text-text-on-critical-base">
          {state.error}
        </p>
      </Show>
    </div>
  )
}

const fields = (data: SoulGetResponse) => ({
  content: data.content,
  name: data.name,
  displayName: data.displayName,
  commitPrefix: data.commitPrefix,
  description: data.description ?? "",
})
const fingerprint = (data: SoulGetResponse) => JSON.stringify(fields(data))

export const SettingsSoulEditor: Component<{
  id: string
  metadata?: boolean
  onSaved?: (data: SoulGetResponse) => void
}> = (props) => {
  const sdk = useGlobalSDK()
  const server = useServer()
  const language = useLanguage()
  const dialog = useDialog()
  const queryClient = useQueryClient()
  const key = () => ["soul", sdk.url, "detail", props.id] as const
  const detail = useQuery(() => ({
    queryKey: key(),
    queryFn: async () => (await sdk.client.soul.get({ id: props.id }, { throwOnError: true })).data,
  }))
  const [draft, setDraft, , ready] = persisted(
    { ...Persist.global(`settings.soul.edit.${checksum(server.key ?? sdk.url)}.${props.id}`), evictOnQuota: false },
    createStore({
      content: "",
      name: "",
      displayName: "",
      commitPrefix: "",
      description: "",
      baseline: "",
      dirty: false,
    }),
  )
  const [state, setState] = createStore({ saving: false, error: "", conflict: false })
  const seed = (data: SoulGetResponse) => setDraft({ ...fields(data), baseline: fingerprint(data), dirty: false })
  createEffect(() => {
    if (!ready() || !detail.data || draft.dirty) return
    seed(detail.data)
  })
  const change = (field: keyof ReturnType<typeof fields>, value: string) => {
    setDraft(field, value)
    setDraft("dirty", true)
    setState("error", "")
  }
  const reload = async () => {
    setState({ error: "", conflict: false })
    try {
      const result = await detail.refetch({ throwOnError: true })
      if (result.data) seed(result.data)
    } catch (error) {
      setState("error", errorMessage(error, language.t("common.requestFailed")))
    }
  }
  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    if (state.saving || !ready()) return
    if (!draft.content.trim()) {
      setState("error", language.t("settings.editor.required"))
      return
    }
    setState({ saving: true, error: "", conflict: false })
    try {
      const current = (await sdk.client.soul.get({ id: props.id }, { throwOnError: true })).data
      if (props.metadata) {
        const profiles = (await sdk.client.companion.list({ throwOnError: true })).data
        if (profiles.some((profile) => profile.soulID === props.id))
          throw new Error(language.t("settings.soulCode.chatSeparate"))
      }
      if (fingerprint(current) !== draft.baseline) {
        setState({ error: language.t("settings.editor.conflict"), conflict: true })
        return
      }
      const { data } = await sdk.client.soul.update(
        {
          id: props.id,
          content: draft.content,
          ...(props.metadata
            ? {
                ...(draft.name !== current.name ? { name: draft.name } : {}),
                ...(draft.displayName !== current.displayName ? { displayName: draft.displayName } : {}),
                ...(draft.commitPrefix !== current.commitPrefix ? { commitPrefix: draft.commitPrefix } : {}),
                ...(draft.description !== (current.description ?? "") ? { description: draft.description } : {}),
              }
            : {}),
        },
        { throwOnError: true },
      )
      seed(data)
      queryClient.setQueryData(key(), data)
      void queryClient.invalidateQueries({ queryKey: ["soul", sdk.url, "list"] })
      void queryClient.invalidateQueries({ queryKey: ["soul", sdk.url, "issues"] })
      props.onSaved?.(data)
      showToast({ title: language.t("settings.editor.saved") })
      dialog.close()
    } catch (error) {
      setState("error", errorMessage(error, language.t("common.requestFailed")))
    } finally {
      setState("saving", false)
    }
  }
  return (
    <Dialog
      class="settings-editor-dialog"
      size="large"
      title={language.t(props.metadata ? "settings.soulCode.edit" : "settings.companion.identity")}
      description={language.t("settings.editor.description")}
    >
      <Show
        when={ready() && detail.data}
        fallback={<p class="text-13-regular text-text-weak">{language.t("common.loading")}</p>}
      >
        <form class="flex flex-col gap-4" onSubmit={(event) => void save(event)}>
          <SettingsSourceActions path={detail.data?.path} onRefresh={() => detail.refetch({ throwOnError: true })} />
          <p class="text-12-regular text-text-weak">
            {language.t(draft.dirty ? "settings.editor.restored" : "settings.editor.draft")}
          </p>
          <label class="flex flex-col gap-2 text-14-medium text-text-strong">
            {language.t("settings.soulCode.body")}
            <textarea
              class="min-h-72 w-full resize-y rounded-lg border border-border-base bg-background-base p-3 text-14-regular leading-relaxed"
              value={draft.content}
              disabled={state.saving}
              onInput={(event) => change("content", event.currentTarget.value)}
              spellcheck={false}
            />
          </label>
          <p class="text-12-regular text-text-weak">{language.t("settings.editor.later")}</p>
          <Show when={props.metadata}>
            <details class="rounded-lg border border-border-weak-base p-4">
              <summary class="cursor-pointer text-13-medium text-text-strong">
                {language.t("settings.soulCode.metadata")}
              </summary>
              <div class="mt-4 grid gap-4 sm:grid-cols-2">
                <TextField
                  label={language.t("settings.personalization.create.nameLabel")}
                  value={draft.name}
                  onChange={(value) => change("name", value)}
                  disabled={state.saving}
                />
                <TextField
                  label={language.t("settings.personalization.create.displayNameLabel")}
                  value={draft.displayName}
                  onChange={(value) => change("displayName", value)}
                  disabled={state.saving}
                />
                <TextField
                  label={language.t("settings.personalization.create.commitPrefixLabel")}
                  value={draft.commitPrefix}
                  onChange={(value) => change("commitPrefix", value)}
                  disabled={state.saving}
                />
                <TextField
                  label={language.t("settings.personalization.create.descriptionLabel")}
                  value={draft.description}
                  onChange={(value) => change("description", value)}
                  disabled={state.saving}
                />
              </div>
            </details>
          </Show>
          <Show when={state.error}>
            <p role="alert" class="text-13-regular text-text-on-critical-base">
              {state.error}
            </p>
          </Show>
          <Show when={state.conflict}>
            <Button variant="secondary" disabled={state.saving} onClick={() => void reload()}>
              {language.t("settings.editor.reload")}
            </Button>
          </Show>
          <div class="flex justify-end gap-2 border-t border-border-weak-base pt-4">
            <Button variant="ghost" disabled={state.saving} onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={state.saving || !draft.dirty}>
              {language.t(state.saving ? "settings.editor.saving" : "common.save")}
            </Button>
          </div>
        </form>
      </Show>
      <Show when={detail.error}>
        <p role="alert" class="text-13-regular text-text-on-critical-base">
          {errorMessage(detail.error, language.t("common.requestFailed"))}
        </p>
        <Button onClick={() => void detail.refetch()}>{language.t("common.retry")}</Button>
      </Show>
    </Dialog>
  )
}
