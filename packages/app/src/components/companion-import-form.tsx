import { Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useQueryClient } from "@tanstack/solid-query"
import type { CompanionInfo } from "@redcode-ai/sdk/v2/client"
import { Button } from "@redcode-ai/ui/button"
import { TextField } from "@redcode-ai/ui/text-field"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { errorMessage } from "@/utils/session-helpers"
import { upsertCompanion } from "@/utils/companion-workspace"

export const CompanionImportForm: Component<{ onImported?: (profile: CompanionInfo) => void }> = (props) => {
  const sdk = useGlobalSDK()
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const queryClient = useQueryClient()
  const native = () => platform.platform === "desktop" && server.current?.type === "sidecar"
  const [state, setState] = createStore({ source: "", busy: false, error: "", complete: false })
  const pick = async (kind: "folder" | "zip") => {
    if (!native()) return
    try {
      const paths =
        kind === "folder"
          ? await platform.openDirectoryPickerDialog?.({ title: language.t("chat.import.folder") })
          : await platform.openFilePickerDialog?.({ title: language.t("chat.import.zip"), extensions: ["zip"] })
      const path = Array.isArray(paths) ? paths[0] : paths
      if (path) setState({ source: path, error: "", complete: false })
    } catch (error) {
      setState("error", errorMessage(error, language.t("common.requestFailed")))
    }
  }
  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (state.busy || !state.source.trim()) return
    setState({ busy: true, error: "", complete: false })
    try {
      const { data } = await sdk.client.companion.import(
        { companionImportInput: { source: state.source.trim() } },
        { throwOnError: true },
      )
      queryClient.setQueryData<CompanionInfo[]>(["companion", sdk.url, "list"], (current) =>
        upsertCompanion(current, data.profile),
      )
      void queryClient.invalidateQueries({ queryKey: ["soul", sdk.url] })
      setState({ source: "", complete: true })
      props.onImported?.(data.profile)
    } catch (error) {
      setState("error", errorMessage(error, language.t("common.requestFailed")))
    } finally {
      setState("busy", false)
    }
  }
  return (
    <form class="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
      <p class="text-13-regular text-text-weak">{language.t("settings.companion.importDescription")}</p>
      <TextField
        label={language.t("chat.import.source")}
        value={state.source}
        onChange={(value) => setState({ source: value, complete: false })}
        placeholder={language.t("chat.import.placeholder")}
        disabled={state.busy}
        autocomplete="off"
        spellcheck={false}
        required
      />
      <Show when={!native()}>
        <p class="text-12-regular text-text-weak">{language.t("chat.import.remote")}</p>
      </Show>
      <div class="flex flex-wrap items-center gap-2">
        <Show when={native() && platform.openDirectoryPickerDialog}>
          <Button type="button" variant="secondary" disabled={state.busy} onClick={() => void pick("folder")}>
            {language.t("chat.import.folder")}
          </Button>
        </Show>
        <Show when={native() && platform.openFilePickerDialog}>
          <Button type="button" variant="secondary" disabled={state.busy} onClick={() => void pick("zip")}>
            {language.t("chat.import.zip")}
          </Button>
        </Show>
        <Button type="submit" variant="primary" disabled={state.busy || !state.source.trim()}>
          {language.t(state.busy ? "chat.import.busy" : "chat.import.action")}
        </Button>
      </div>
      <Show when={state.error}>
        <p role="alert" class="text-13-regular text-text-on-critical-base">
          {state.error}
        </p>
      </Show>
      <Show when={state.complete}>
        <p role="status" class="text-13-regular text-text-success-base">
          {language.t("settings.companion.imported")}
        </p>
      </Show>
    </form>
  )
}
