import { createMemo, For, Show, type Component } from "solid-js"
import { useParams } from "@solidjs/router"
import { useQuery } from "@tanstack/solid-query"
import type { CompanionInfo } from "@redcode-ai/sdk/v2/client"
import { Button } from "@redcode-ai/ui/button"
import { Dialog } from "@redcode-ai/ui/dialog"
import { Icon } from "@redcode-ai/ui/icon"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { decode64 } from "@/utils/base64"
import { errorMessage } from "@/utils/session-helpers"
import { CompanionImportForm } from "./companion-import-form"
import { SettingsSourceActions } from "./settings-soul-editor"
import { SettingsList, SettingsRow } from "./settings-list"

const CompanionFiles: Component<{ profile: CompanionInfo }> = (props) => {
  const sdk = useGlobalSDK()
  const language = useLanguage()
  const details = useQuery(() => ({
    queryKey: ["companion", sdk.url, "detail", props.profile.id],
    queryFn: async () => (await sdk.client.companion.get({ id: props.profile.id }, { throwOnError: true })).data,
  }))
  return (
    <section class="settings-section">
      <h3 class="settings-section-title">{props.profile.name}</h3>
      <Show when={details.data}>
        {(data) => (
          <SettingsList>
            <For
              each={[
                { title: language.t("settings.modern.files.soul"), path: data().paths.soul },
                { title: language.t("settings.modern.files.identity"), path: data().paths.identity },
                { title: language.t("settings.modern.files.user"), path: data().paths.user },
                { title: language.t("settings.modern.files.memory"), path: data().paths.memory },
              ]}
            >
              {(file) => (
                <div class="py-4 border-b border-border-weak-base last:border-none">
                  <h4 class="settings-row-title mb-2">{file.title}</h4>
                  <SettingsSourceActions path={file.path} onRefresh={() => details.refetch({ throwOnError: true })} />
                </div>
              )}
            </For>
          </SettingsList>
        )}
      </Show>
      <Show when={details.isPending}>
        <p class="settings-empty">{language.t("common.loading")}</p>
      </Show>
      <Show when={details.error}>
        <p class="settings-error" role="alert">
          {errorMessage(details.error, language.t("common.requestFailed"))}
        </p>
        <Button size="small" onClick={() => void details.refetch()}>
          {language.t("common.retry")}
        </Button>
      </Show>
    </section>
  )
}

export const SettingsFiles: Component = () => {
  const sdk = useGlobalSDK()
  const language = useLanguage()
  const dialog = useDialog()
  const params = useParams()
  const platform = usePlatform()
  const server = useServer()
  const directory = createMemo(() => (params.dir ? decode64(params.dir) : undefined))
  const parameters = () => ({ directory: directory() })
  const local = () => platform.platform === "desktop" && server.current?.type === "sidecar"
  const paths = useQuery(() => ({
    queryKey: ["settings", sdk.url, directory(), "paths"],
    queryFn: async () => (await sdk.client.path.get(parameters(), { throwOnError: true })).data,
  }))
  const profiles = useQuery(() => ({
    queryKey: ["companion", sdk.url, "list"],
    queryFn: async () => (await sdk.client.companion.list({ throwOnError: true })).data,
  }))
  const instructions = useQuery(() => ({
    queryKey: ["settings", sdk.url, directory(), "instructions"],
    queryFn: async () => (await sdk.client.app.instructions(parameters(), { throwOnError: true })).data,
  }))
  const skills = useQuery(() => ({
    queryKey: ["settings", sdk.url, directory(), "skills"],
    queryFn: async () => (await sdk.client.app.skills(parameters(), { throwOnError: true })).data,
  }))
  const lsp = useQuery(() => ({
    queryKey: ["settings", sdk.url, directory(), "lsp"],
    queryFn: async () => (await sdk.client.lsp.status(parameters(), { throwOnError: true })).data,
  }))
  const formatters = useQuery(() => ({
    queryKey: ["settings", sdk.url, directory(), "formatters"],
    queryFn: async () => (await sdk.client.formatter.status(parameters(), { throwOnError: true })).data,
  }))
  const refresh = () =>
    Promise.allSettled([
      paths.refetch(),
      profiles.refetch(),
      instructions.refetch(),
      skills.refetch(),
      lsp.refetch(),
      formatters.refetch(),
    ])
  const ErrorState: Component<{ error: unknown; retry: () => unknown }> = (props) => (
    <div class="settings-inline-actions">
      <p class="settings-error" role="alert">
        {errorMessage(props.error, language.t("settings.modern.files.unavailable"))}
      </p>
      <Button size="small" variant="secondary" onClick={() => void props.retry()}>
        {language.t("common.retry")}
      </Button>
    </div>
  )
  const source = (path: string) =>
    /^https?:\/\//i.test(path) ? (
      <button
        class="text-12-regular text-text-interactive-base break-all text-left"
        onClick={() => platform.openLink(path)}
      >
        {path}
        <Icon name="square-arrow-top-right" size="small" />
      </button>
    ) : (
      <SettingsSourceActions path={path} />
    )

  return (
    <div class="settings-page-body">
      <header class="settings-page-heading">
        <div>
          <h2 class="settings-page-title">{language.t("settings.modern.files")}</h2>
          <p class="settings-page-description">{language.t("settings.modern.files.description")}</p>
        </div>
        <Button size="small" variant="secondary" onClick={() => void refresh()}>
          {language.t("settings.modern.files.refresh")}
        </Button>
      </header>
      <Show when={!local()}>
        <p class="settings-note">{language.t("settings.modern.files.remote")}</p>
      </Show>
      <Show when={paths.data}>
        {(data) => (
          <SettingsList>
            <For
              each={[
                {
                  title: language.t("settings.modern.files.config"),
                  description: language.t("settings.modern.files.config.description"),
                  path: data().config,
                },
                {
                  title: language.t("settings.modern.files.state"),
                  description: language.t("settings.modern.files.state.description"),
                  path: data().state,
                },
                ...(directory()
                  ? [
                      {
                        title: language.t("settings.modern.files.project"),
                        description: language.t("settings.modern.files.project.description"),
                        path: data().directory,
                      },
                    ]
                  : []),
              ]}
            >
              {(file) => (
                <div class="py-4 border-b border-border-weak-base last:border-none">
                  <h3 class="settings-row-title">{file.title}</h3>
                  <p class="settings-row-description mb-3">{file.description}</p>
                  <SettingsSourceActions path={file.path} directory />
                </div>
              )}
            </For>
          </SettingsList>
        )}
      </Show>
      <Show when={paths.isPending}>
        <p class="settings-empty">{language.t("common.loading")}</p>
      </Show>
      <Show when={paths.error}>
        <ErrorState error={paths.error} retry={() => paths.refetch()} />
      </Show>

      <Show when={profiles.data?.length}>
        <section class="settings-section">
          <div>
            <h3 class="settings-section-title">{language.t("settings.modern.files.companion")}</h3>
            <p class="settings-page-description">{language.t("settings.modern.files.companion.description")}</p>
          </div>
          <For each={profiles.data}>{(profile) => <CompanionFiles profile={profile} />}</For>
        </section>
      </Show>
      <Show when={profiles.error}>
        <ErrorState error={profiles.error} retry={() => profiles.refetch()} />
      </Show>

      <section class="settings-section">
        <div>
          <h3 class="settings-section-title">{language.t("settings.modern.files.instructions")}</h3>
          <p class="settings-page-description">{language.t("settings.modern.files.instructions.description")}</p>
        </div>
        <Show when={!instructions.isPending} fallback={<p class="settings-empty">{language.t("common.loading")}</p>}>
          <Show
            when={!instructions.error}
            fallback={<ErrorState error={instructions.error} retry={() => instructions.refetch()} />}
          >
            <Show
              when={instructions.data?.sources.length}
              fallback={<p class="settings-note">{language.t("settings.modern.files.empty")}</p>}
            >
              <SettingsList>
                <For each={instructions.data?.sources}>
                  {(item) => (
                    <div class="py-4 border-b border-border-weak-base last:border-none">
                      <div class="settings-inline-actions mb-2">
                        <span class="settings-row-title">{item.kind}</span>
                        <span class="settings-scope">{language.t(`settings.modern.instruction.${item.status}`)}</span>
                        <span class="settings-row-description">{item.effectiveBytes ?? item.bytes} B</span>
                      </div>
                      {source(item.path)}
                    </div>
                  )}
                </For>
              </SettingsList>
            </Show>
          </Show>
        </Show>
      </section>

      <section class="settings-section">
        <div>
          <h3 class="settings-section-title">{language.t("settings.modern.files.skills")}</h3>
          <p class="settings-page-description">{language.t("settings.modern.files.skills.description")}</p>
        </div>
        <Show when={!skills.isPending} fallback={<p class="settings-empty">{language.t("common.loading")}</p>}>
          <Show when={!skills.error} fallback={<ErrorState error={skills.error} retry={() => skills.refetch()} />}>
            <Show
              when={skills.data?.length}
              fallback={<p class="settings-note">{language.t("settings.modern.files.empty")}</p>}
            >
              <SettingsList>
                <For each={skills.data}>
                  {(item) => (
                    <div class="py-4 border-b border-border-weak-base last:border-none">
                      <h4 class="settings-row-title">{item.name}</h4>
                      <p class="settings-row-description mb-3">{item.description}</p>
                      {source(item.location)}
                    </div>
                  )}
                </For>
              </SettingsList>
            </Show>
          </Show>
        </Show>
      </section>

      <section class="settings-section">
        <div>
          <h3 class="settings-section-title">{language.t("settings.modern.files.languageTools")}</h3>
          <p class="settings-page-description">{language.t("settings.modern.files.languageTools.description")}</p>
        </div>
        <Show when={lsp.isPending || formatters.isPending}>
          <p class="settings-empty">{language.t("common.loading")}</p>
        </Show>
        <Show when={lsp.error}>
          <ErrorState error={lsp.error} retry={() => lsp.refetch()} />
        </Show>
        <Show when={formatters.error}>
          <ErrorState error={formatters.error} retry={() => formatters.refetch()} />
        </Show>
        <Show when={lsp.data?.length || formatters.data?.length}>
          <SettingsList>
            <For each={lsp.data}>
              {(item) => (
                <SettingsRow title={item.name} description={<code class="settings-path">{item.root}</code>}>
                  <span class="settings-scope">
                    {language.t(
                      item.status === "connected" ? "settings.modern.files.connected" : "settings.modern.files.error",
                    )}
                  </span>
                </SettingsRow>
              )}
            </For>
            <For each={formatters.data}>
              {(item) => (
                <SettingsRow title={item.name} description={item.extensions.join(" · ")}>
                  <span class="settings-scope">
                    {language.t(item.enabled ? "settings.modern.files.enabled" : "settings.modern.files.disabled")}
                  </span>
                </SettingsRow>
              )}
            </For>
          </SettingsList>
        </Show>
        <Show when={lsp.isSuccess && formatters.isSuccess && !lsp.data.length && !formatters.data.length}>
          <p class="settings-note">{language.t("settings.modern.files.empty")}</p>
        </Show>
      </section>

      <section class="settings-section">
        <h3 class="settings-section-title">{language.t("settings.modern.files.maintenance")}</h3>
        <SettingsList>
          <SettingsRow
            title={language.t("settings.modern.files.import")}
            description={language.t("settings.modern.files.import.description")}
          >
            <Button
              size="small"
              variant="secondary"
              onClick={() =>
                dialog.push(() => (
                  <Dialog class="settings-editor-dialog" title={language.t("settings.modern.files.import")}>
                    <div>
                      <CompanionImportForm
                        onImported={() => {
                          void profiles.refetch()
                        }}
                      />
                    </div>
                  </Dialog>
                ))
              }
            >
              {language.t("common.open")}
            </Button>
          </SettingsRow>
        </SettingsList>
      </section>
    </div>
  )
}
