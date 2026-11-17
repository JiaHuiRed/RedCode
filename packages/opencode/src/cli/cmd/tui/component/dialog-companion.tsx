import { createOpencodeClient } from "@redcode-ai/sdk/v2"
import { createStore } from "solid-js/store"
import { onMount } from "solid-js"
import { useSDK } from "../context/sdk"
import { useProjectNavigation } from "../context/project-navigation"
import { useRoute } from "../context/route"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { latestCompanionSession } from "../companion"
import { sameDirectory } from "../validate-session"

type Choice = { id: string; name: string; directory: string }

export function DialogCompanion() {
  const sdk = useSDK()
  const navigation = useProjectNavigation()
  const route = useRoute()
  const dialog = useDialog()
  const toast = useToast()
  const [state, setState] = createStore({ profiles: [] as Choice[], loading: true, opening: false, error: "" })

  onMount(() => {
    void sdk.client.companion.list({ throwOnError: true }).then(
      (result) => setState({ profiles: result.data, loading: false }),
      (error) => setState({ error: error instanceof Error ? error.message : String(error), loading: false }),
    )
  })

  async function open(profile: Choice) {
    if (state.opening) return
    setState("opening", true)
    const client = createOpencodeClient({
      baseUrl: sdk.url,
      directory: profile.directory,
      fetch: sdk.fetch,
      signal: sdk.signal,
      headers: sdk.headers,
    })
    await client.session
      .list({ roots: true }, { throwOnError: true })
      .then(async (sessions) => {
        const previous = latestCompanionSession(sessions.data, profile.id, profile.directory)
        const session =
          previous ??
          (await client.session.create({ mode: "chat", companionID: profile.id }, { throwOnError: true })).data
        if (sdk.directory && sameDirectory(sdk.directory, profile.directory)) {
          route.navigate({ type: "session", sessionID: session.id })
          dialog.clear()
          return
        }
        await navigation?.switchTo(profile.directory, session.id)
      })
      .catch((error) =>
        toast.show({ variant: "error", message: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => setState("opening", false))
  }

  return (
    <DialogSelect
      title={state.opening ? "正在打开 Chat…" : "Chat · 选择伙伴"}
      placeholder="搜索伙伴"
      emptyContent={
        state.loading ? "正在读取伙伴档案…" : state.error || "还没有伙伴档案。先运行 redcode companion import <路径>。"
      }
      options={state.profiles.map((profile) => ({
        value: profile.id,
        title: profile.name,
        description: profile.id,
        disabled: state.opening,
      }))}
      onSelect={(option) => {
        const profile = state.profiles.find((item) => item.id === option.value)
        if (profile) void open(profile)
      }}
    />
  )
}
