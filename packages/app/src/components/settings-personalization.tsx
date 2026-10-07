import { Button } from "@redcode-ai/ui/button"
import { Select } from "@redcode-ai/ui/select"
import { useQuery } from "@tanstack/solid-query"
import { createMemo, For, Show, type Component } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { SettingsList, SettingsRow } from "./settings-list"

const SERVER_DEFAULT = "__server_default__"

export const SettingsPersonalization: Component = () => {
  const language = useLanguage()
  const settings = useSettings()
  const sdk = useGlobalSDK()

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
  const soulName = (id: string | undefined) => souls.data?.find((soul) => soul.id === id)?.displayName
  const options = createMemo(() => {
    const list = souls.data ?? []
    const stored = saved()
    return [
      {
        id: SERVER_DEFAULT,
        displayName: language.t("settings.personalization.serverDefault", {
          soul:
            soulName(serverDefault.data?.id) ??
            serverDefault.data?.id ??
            language.t(serverDefault.isPending ? "common.loading" : "session.header.noSoul"),
        }),
      },
      ...(stored && !list.some((soul) => soul.id === stored)
        ? [
            {
              id: stored,
              displayName: language.t("settings.personalization.unavailableSoul", { id: stored }),
            },
          ]
        : []),
      ...list.map((soul) => ({ ...soul, displayName: soul.displayName || soul.name })),
    ]
  })
  const selected = () => (saved() ? saved() : SERVER_DEFAULT)
  const current = () => options().find((option) => option.id === selected())

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 pt-6 pb-8 max-w-[720px]">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.personalization.title")}</h2>
          <span class="text-14-regular text-text-weak">{language.t("settings.personalization.description")}</span>
        </div>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        <SettingsList>
          <SettingsRow
            title={language.t("settings.personalization.defaultSoul")}
            description={language.t("settings.personalization.defaultSoulDescription")}
          >
            <Select
              data-action="settings-personalization-soul"
              options={options()}
              current={current()}
              value={(option: { id: string }) => option.id}
              label={(option: { displayName: string }) => option.displayName}
              onSelect={(option: { id: string } | undefined) => {
                if (!option) return
                settings.personalization.setLastSoul(option.id === SERVER_DEFAULT ? "" : option.id)
              }}
              variant="secondary"
              size="small"
              triggerVariant="settings"
              triggerStyle={{ "min-width": "260px" }}
              aria-label={language.t("settings.personalization.defaultSoul")}
            />
          </SettingsRow>
        </SettingsList>

        <Show when={souls.isPending || serverDefault.isPending}>
          <p class="text-14-regular text-text-weak">{language.t("common.loading")}</p>
        </Show>
        <Show when={souls.isError || serverDefault.isError}>
          <div class="flex flex-col items-start gap-2">
            <p class="text-14-regular text-text-danger-base">
              {souls.error instanceof Error
                ? souls.error.message
                : serverDefault.error instanceof Error
                  ? serverDefault.error.message
                  : language.t("common.requestFailed")}
            </p>
            <Button
              size="small"
              variant="secondary"
              onClick={() => {
                void souls.refetch()
                void serverDefault.refetch()
              }}
            >
              {language.t("common.retry")}
            </Button>
          </div>
        </Show>
        <Show when={saved() && souls.data && !souls.data.some((soul) => soul.id === saved())}>
          <p role="alert" class="text-14-regular text-text-danger-base">
            {language.t("settings.personalization.staleSoul", { id: saved() })}
          </p>
        </Show>

        <Show when={issues.isPending}>
          <p class="text-14-regular text-text-weak">{language.t("settings.personalization.issuesLoading")}</p>
        </Show>
        <Show when={issues.isError}>
          <div class="flex flex-col items-start gap-2">
            <p role="alert" class="text-14-regular text-text-danger-base">
              {issues.error instanceof Error ? issues.error.message : language.t("common.requestFailed")}
            </p>
            <Button size="small" variant="secondary" onClick={() => void issues.refetch()}>
              {language.t("common.retry")}
            </Button>
          </div>
        </Show>
        <Show when={issues.data?.length}>
          <section aria-label={language.t("settings.personalization.registryIssues")} class="flex flex-col gap-2">
            <h3 class="text-14-medium text-text-strong">{language.t("settings.personalization.registryIssues")}</h3>
            <ul class="flex flex-col gap-1">
              <For each={issues.data}>
                {(issue) => (
                  <li role="alert" class="text-14-regular text-text-danger-base">
                    {typeof issue === "string" ? issue : JSON.stringify(issue)}
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
      </div>
    </div>
  )
}
