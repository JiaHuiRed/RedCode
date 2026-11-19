import { Match, Show, Switch } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import type { CompanionInfo } from "@redcode-ai/sdk/v2/client"
import { Button } from "@redcode-ai/ui/button"
import { Dialog } from "@redcode-ai/ui/dialog"
import { SettingsSourceActions } from "./settings-soul-editor"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { errorMessage } from "@/utils/session-helpers"

// 261119 Red 后台生成与阅读共用同一份梦境日记。方案见 docs/notes/proposed/architecture/2026-11-19-companion-heartbeat-dreams.md
export function CompanionDreamDiary(props: { profile: CompanionInfo }) {
  const sdk = useGlobalSDK()
  const language = useLanguage()
  const diary = useQuery(() => ({
    queryKey: ["companion-dream-diary", sdk.url, props.profile.id, props.profile.directory],
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      const directory = props.profile.directory
      const options = { throwOnError: true, signal } as const
      const { data: entries } = await sdk.client.file.list({ directory, path: "." }, options)
      const names = entries.filter((entry) => entry.type === "file").map((entry) => entry.name)
      const path = names.includes("DREAMS.md") ? "DREAMS.md" : names.find((name) => name.toLowerCase() === "dreams.md")
      if (!path) return null
      const { data } = await sdk.client.file.read({ directory, path }, options)
      if (data.type !== "text" || data.encoding) throw new Error(language.t("settings.companion.diaryUnreadable"))
      return { path: directory.replace(/[\\/]$/, "") + "/" + path, content: data.content, truncated: data.truncated }
    },
  }))
  return (
    <Dialog title={language.t("chat.dreams.title")} description={props.profile.name}>
      <div class="max-h-[65vh] overflow-y-auto px-5 pb-5 text-14-regular text-text-strong">
        <Switch fallback={<p>{language.t("chat.dreams.empty")}</p>}>
          <Match when={diary.isPending}>
            <p role="status">{language.t("common.loading")}</p>
          </Match>
          <Match when={diary.isError}>
            <p role="alert">{errorMessage(diary.error, language.t("common.requestFailed"))}</p>
            <Button variant="secondary" onClick={() => void diary.refetch()}>
              {language.t("common.retry")}
            </Button>
          </Match>
          <Match when={diary.data?.content.trim()}>
            <article class="whitespace-pre-wrap break-words">{diary.data?.content}</article>
            <Show when={diary.data?.truncated}>
              <p class="mt-2 text-12-regular text-text-weak">{language.t("settings.companion.diaryTruncated")}</p>
              <SettingsSourceActions path={diary.data?.path} />
            </Show>
          </Match>
        </Switch>
      </div>
    </Dialog>
  )
}
