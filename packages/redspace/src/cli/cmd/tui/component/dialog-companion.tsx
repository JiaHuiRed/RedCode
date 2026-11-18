import { createOpencodeClient } from "@redcode-ai/sdk/v2"
import type { CompanionInfo, Session } from "@redcode-ai/sdk/v2"
import { Limits } from "@/companion/schema"
import { errorMessage } from "@/util/error"
import { createStore } from "solid-js/store"
import { onCleanup, onMount } from "solid-js"
import { useSDK } from "../context/sdk"
import { useLocal } from "../context/local"
import { useKV } from "../context/kv"
import { useProjectNavigation } from "../context/project-navigation"
import { useRoute } from "../context/route"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { latestCompanionSession } from "../companion"
import { sameDirectory } from "../validate-session"

export function DialogCompanion() {
  const sdk = useSDK()
  const local = useLocal()
  const kv = useKV()
  const navigation = useProjectNavigation()
  const route = useRoute()
  const dialog = useDialog()
  const [state, setState] = createStore({
    loading: true,
    opening: false,
    error: "",
    prepared: undefined as Session | undefined,
  })
  const requestKey = `tui.companion.create.${sdk.url}`
  const pendingRequest = () => {
    const value = kv.get(requestKey)
    return typeof value === "string" ? value : undefined
  }
  let active = true
  onCleanup(() => {
    active = false
  })
  const reload = async () => {
    setState({ loading: true, error: "" })
    await local.companion.refresh()
    if (active) setState("loading", false)
  }

  onMount(() => {
    void reload()
  })

  async function enter(profile: CompanionInfo, fresh = false) {
    const same = !!sdk.directory && sameDirectory(sdk.directory, profile.directory)
    const client = same
      ? sdk.client
      : createOpencodeClient({
          baseUrl: sdk.url,
          directory: profile.directory,
          fetch: sdk.fetch,
          signal: sdk.signal,
          headers: sdk.headers,
        })
    const prepared = state.prepared?.companionID === profile.id ? state.prepared : undefined
    const previous = fresh
      ? prepared
      : latestCompanionSession(
          (await client.session.list({ roots: true }, { throwOnError: true })).data,
          profile.id,
          profile.directory,
        )
    if (!active) return false
    const session =
      previous ?? (await client.session.create({ mode: "chat", companionID: profile.id }, { throwOnError: true })).data
    if (!active) return false
    setState("prepared", session)
    if (same) {
      route.navigate({ type: "session", sessionID: session.id })
      dialog.clear()
      return true
    }
    if (!navigation) throw new Error("当前连接不支持切换伙伴工作区")
    return navigation.switchTo(profile.directory, session.id)
  }

  async function select(id: string) {
    if (state.opening || state.loading || !kv.ready) return
    if (id === "action:retry") return reload()
    setState({ opening: true, error: "" })
    try {
      if (id === "action:create") {
        const requestID = pendingRequest() ?? crypto.randomUUID()
        kv.set(requestKey, requestID)
        const { data } = await sdk.client.companion.create(
          { companionCreateInput: { requestID } },
          { throwOnError: true },
        )
        if (!active) return
        local.companion.remember(data.profile)
        if (await enter(data.profile, data.created)) kv.set(requestKey, undefined)
        return
      }
      const profile = local.companion.get(id)
      if (profile) await enter(profile)
    } catch (error) {
      if (active) setState("error", errorMessage(error))
    } finally {
      if (active) setState("opening", false)
    }
  }

  return (
    <DialogSelect
      title={state.opening ? "正在打开 Chat…" : "Chat · 选择伙伴"}
      placeholder="搜索伙伴"
      emptyContent={state.loading ? "正在读取伙伴…" : state.opening ? "正在准备聊天…" : "没有找到这位伙伴"}
      options={[
        ...local.companion.list().map((profile) => ({
          value: profile.id,
          title: profile.name,
          description: profile.id,
          disabled: state.opening,
        })),
        ...(!state.loading && !local.companion.error()
          ? [
              {
                value: "action:create",
                title: pendingRequest() ? "继续新建的伙伴" : "＋ 新建伙伴",
                description: pendingRequest()
                  ? "重试上次创建，不会重复占用名额"
                  : local.companion.list().length >= Limits.companions
                    ? "最多可以有两位伙伴"
                    : "开始一段新的聊天，之后再慢慢认识",
                disabled: state.opening || !kv.ready,
                readOnly: !pendingRequest() && local.companion.list().length >= Limits.companions,
              },
            ]
          : []),
        ...(state.error || local.companion.error()
          ? [
              {
                value: "action:retry",
                title: "刷新伙伴列表",
                description: state.error || local.companion.error(),
                disabled: state.opening || state.loading,
              },
            ]
          : []),
      ]}
      onSelect={(option) => {
        void select(option.value)
      }}
    />
  )
}
