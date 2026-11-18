import { introductionOf } from "@/companion/schema"
import { errorMessage } from "@/util/error"
import { createMemo, onCleanup, Show } from "solid-js"
import { createStore, unwrap } from "solid-js/store"
import { useLocal } from "../context/local"
import { usePromptRef } from "../context/prompt"
import { useRoute } from "../context/route"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import type { PromptRef } from "./prompt"
import { usePromptStash } from "./prompt/stash"

export function DialogCompanionIntroduction(props: { id: string; prompt: () => PromptRef | undefined }) {
  const sdk = useSDK()
  const local = useLocal()
  const dialog = useDialog()
  const toast = useToast()
  const stash = usePromptStash()
  const route = useRoute()
  const [state, setState] = createStore({ busy: false, error: "" })
  const profile = createMemo(() => local.companion.get(props.id))
  const introduction = () => (profile() ? introductionOf(profile()!) : "complete")
  const target = () =>
    route.data.type === "session"
      ? `session:${route.data.sessionID}`
      : route.data.type === "home"
        ? `home:${route.data.companionID ?? ""}`
        : route.data.id
  let active = true
  onCleanup(() => {
    active = false
  })

  const update = async (value: "active" | "paused" | "complete") => {
    if (state.busy) return
    const prompt = props.prompt()
    const scope = target()
    if (value === "active" && !prompt) {
      setState("error", "输入框尚未准备好，请稍后重试")
      return
    }
    const message = introduction() === "available" ? "我们先认识一下吧。" : "我们继续认识彼此吧。"
    setState({ busy: true, error: "" })
    try {
      const { data } = await sdk.client.companion.update(
        { id: props.id, companionUpdateInput: { introduction: value } },
        { throwOnError: true },
      )
      local.companion.remember(data.profile)
      if (!active) return
      if (value !== "active") {
        dialog.clear()
        return
      }
      if (prompt !== props.prompt() || scope !== target()) {
        setState("error", "当前聊天已切换，请在目标聊天里重新开始")
        return
      }
      const current = structuredClone(unwrap(prompt!.current))
      if (current.input || current.parts.length) {
        stash.push(current)
        toast.show({ variant: "info", message: "原草稿已暂存，可从命令面板的 Stash list 取回", duration: 6000 })
      }
      prompt!.set({ input: message, parts: [], mode: "normal" })
      dialog.clear()
      await prompt!.submit()
    } catch (error) {
      const message = errorMessage(error)
      if (active) setState("error", message)
      else toast.show({ variant: "error", message })
    } finally {
      if (active) setState("busy", false)
    }
  }

  return (
    <DialogSelect
      title={state.busy ? "正在准备相识…" : `${profile()?.name ?? "Chat"} · 相识`}
      renderFilter={false}
      emptyContent={state.busy ? "正在保存…" : state.error}
      options={[
        {
          value: "active",
          title: introduction() === "available" ? "开始认识" : "继续认识",
          description: "发送一条真实的相识消息；已有草稿会暂存到 Stash list",
          disabled: state.busy,
        },
        {
          value: "paused",
          title: "稍后再聊",
          description: "可以直接处理任务，之后用 /introduce 继续",
          disabled: state.busy,
        },
        { value: "complete", title: "完成相识", description: "结束引导，照常继续聊天", disabled: state.busy },
        ...(state.error ? [{ value: "error", title: "未完成操作", description: state.error, readOnly: true }] : []),
      ]}
      onSelect={(option) => {
        if (option.value === "active" || option.value === "paused" || option.value === "complete")
          void update(option.value)
      }}
    />
  )
}

export function CompanionIntroduction(props: { id?: string }) {
  const local = useLocal()
  const prompt = usePromptRef()
  const dialog = useDialog()
  const { theme } = useTheme()
  const profile = createMemo(() => local.companion.get(props.id))
  return (
    <Show when={profile() && introductionOf(profile()!) === "available"}>
      <box paddingLeft={1} paddingRight={1} flexShrink={0}>
        <text fg={theme.textMuted}>可以直接开始聊天，也可以先认识彼此。</text>
        <text
          fg={theme.accent}
          onMouseUp={() => {
            const id = props.id
            if (id) dialog.replace(() => <DialogCompanionIntroduction id={id} prompt={() => prompt.current} />)
          }}
        >
          开始认识 · /introduce
        </text>
      </box>
    </Show>
  )
}
