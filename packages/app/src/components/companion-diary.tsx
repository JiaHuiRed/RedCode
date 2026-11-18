import { createMemo, createSignal, For, Show } from "solid-js"
import { useQuery } from "@tanstack/solid-query"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { errorMessage } from "@/utils/session-helpers"

export function CompanionDiary(props: { directory: string }) {
  const sdk = useGlobalSDK()
  const language = useLanguage()
  const [selected, setSelected] = createSignal("")
  const files = useQuery(() => ({
    queryKey: ["companion-diary", sdk.url, props.directory, "list"],
    queryFn: async () => {
      const { data } = await sdk.client.file.list(
        { directory: props.directory, path: "memory" },
        { throwOnError: true },
      )
      return data
        .filter((item) => item.type === "file" && /^\d{4}-\d{2}-\d{2}[^/\\]*\.md$/.test(item.name))
        .map((item) => item.name)
        .sort()
        .reverse()
    },
  }))
  const name = createMemo(() => (files.data?.includes(selected()) ? selected() : files.data?.[0]))
  const entry = useQuery(() => ({
    queryKey: ["companion-diary", sdk.url, props.directory, name()],
    enabled: !!name(),
    queryFn: async () => {
      const { data } = await sdk.client.file.read(
        { directory: props.directory, path: `memory/${name()}` },
        { throwOnError: true },
      )
      if (data.type !== "text" || data.encoding) throw new Error(language.t("settings.companion.diaryUnreadable"))
      return {
        text: data.content
          .replace(/^<!-- companion-entry:[a-f0-9]{64} -->\r?$/gm, "")
          .replace(/^Source: session:[^\r\n]+\/message:[^\r\n]+\r?$/gm, "")
          .trim(),
        truncated: data.truncated,
      }
    },
  }))
  return (
    <div data-component="companion-diary" class="flex flex-col gap-2">
      <Show when={files.error || entry.error}>
        <p role="alert">{errorMessage(files.error || entry.error, language.t("common.requestFailed"))}</p>
      </Show>
      <Show when={files.isPending}>
        <p>{language.t("common.loading")}</p>
      </Show>
      <Show when={files.isSuccess && !name()}>
        <p>{language.t("settings.companion.diaryEmpty")}</p>
      </Show>
      <Show when={name()}>
        <select
          aria-label={language.t("settings.companion.dailyMemory")}
          value={name()}
          onChange={(event) => setSelected(event.currentTarget.value)}
        >
          <For each={files.data}>{(file) => <option value={file}>{file.slice(0, -3)}</option>}</For>
        </select>
        <Show when={entry.isPending}>
          <p>{language.t("common.loading")}</p>
        </Show>
        <Show when={entry.data}>
          {(value) => (
            <div class="max-h-72 overflow-auto whitespace-pre-wrap break-words text-14-regular text-text-strong">
              {value().text}
              <Show when={value().truncated}>
                <p>{language.t("settings.companion.diaryTruncated")}</p>
              </Show>
            </div>
          )}
        </Show>
      </Show>
    </div>
  )
}
