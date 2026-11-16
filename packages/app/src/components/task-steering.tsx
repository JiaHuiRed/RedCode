import { createEffect, createMemo, createResource, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@redcode-ai/ui/button"
import { useSDK } from "@/context/sdk"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import { errorMessage } from "@/utils/session-helpers"

export function TaskSteering(props: { sessionID: string; parentID?: string; title?: string }) {
  const sdk = useSDK()
  const language = useLanguage()
  const [draft, setDraft, , ready] = persisted(
    { ...Persist.session(sdk.directory, props.sessionID, "task-steer:prompt"), evictOnQuota: false },
    createStore({ text: "", requestID: "", requestText: "", sentText: "", messageID: "" }),
  )
  const [state, setState] = createStore({
    sending: false,
    delivery: "" as "" | "queued" | "delivered",
    error: "",
    receiptError: "",
  })
  const [jobs, { refetch }] = createResource(async () => {
    const response = await sdk.client.background.list()
    if (response.error) throw response.error
    return response.data ?? []
  })
  const job = createMemo(() => jobs.latest?.find((item) => item.type === "task" && item.sessionID === props.sessionID))
  const running = createMemo(() => job()?.status === "running")
  const size = createMemo(() => new TextEncoder().encode(draft.text).length)
  const readReceipt = async () => {
    const messageID = draft.messageID
    if (!messageID) return
    const response = await sdk.client.session.message({ sessionID: props.sessionID, messageID })
    if (response.error) throw response.error
    if (draft.messageID !== messageID) return
    const info = response.data?.info
    if (info?.role === "user") setState({
      delivery: info.delivery === "delivered" ? "delivered" : "queued",
      receiptError: "",
    })
  }
  onMount(() => {
    const timer = setInterval(() => {
      void refetch()
      void readReceipt().catch((error) => setState("receiptError", errorMessage(error, language.t("common.requestFailed"))))
    }, 2000)
    onCleanup(() => clearInterval(timer))
  })
  createEffect(() => {
    if (!ready() || !draft.messageID) return
    void readReceipt().catch((error) => setState("receiptError", errorMessage(error, language.t("common.requestFailed"))))
  })
  const unsubscribe = sdk.event.on("message.updated", (event) => {
    const info = event.properties.info
    if (info.id !== draft.messageID || info.sessionID !== props.sessionID || info.role !== "user") return
    setState("delivery", info.delivery === "delivered" ? "delivered" : "queued")
  })
  onCleanup(unsubscribe)

  const send = async () => {
    if (state.sending || !running() || !draft.text.trim() || size() > 16_384) return
    const text = draft.text
    const requestID = draft.requestText === text && draft.requestID ? draft.requestID : crypto.randomUUID()
    setDraft({ requestID, requestText: text })
    setState({ sending: true, error: "", delivery: "" })
    const response = await sdk.client.background.steer({
      sessionID: props.sessionID,
      message: text,
      requestID,
    }).catch((error: unknown) => {
      setState({ sending: false, error: errorMessage(error, language.t("common.requestFailed")) })
      return undefined
    })
    if (!response) return
    if (response.error || !response.data) {
      setState({ sending: false, error: errorMessage(response.error, language.t("common.requestFailed")) })
      return
    }
    setDraft({ messageID: response.data.messageID, sentText: text, requestID: "", requestText: "" })
    if (draft.text === text) setDraft("text", "")
    setState({ sending: false, delivery: response.data.state, receiptError: "" })
  }

  return (
    <section class="flex min-w-0 flex-col gap-2" data-component="task-steering">
      <div class="text-base font-medium text-text-strong">{language.t("task.steer.title")}</div>
      <div class="text-sm text-text-weak break-all">
        {job()?.title ?? props.title ?? props.sessionID}
        <Show when={props.parentID ?? job()?.parentSessionID}>
          {(id) => <div>{language.t("task.steer.parent", { id: id() })}</div>}
        </Show>
      </div>
      <p class="text-sm text-text-weak">{language.t("task.steer.hint")}</p>
      <textarea
        class="min-h-24 w-full resize-y rounded-md border border-border-weak-base bg-surface-base p-3 text-base text-text-base"
        aria-label={language.t("task.steer.title")}
        value={draft.text}
        disabled={!ready() || state.sending}
        onInput={(event) => setDraft("text", event.currentTarget.value)}
      />
      <Show when={jobs.error || state.error || state.receiptError}>
        <div role="alert" class="text-sm text-v2-state-fg-danger">
          {state.error || state.receiptError || errorMessage(jobs.error, language.t("common.requestFailed"))}
        </div>
      </Show>
      <Show when={size() > 16_384}>
        <div role="alert" class="text-sm text-v2-state-fg-danger">{language.t("task.steer.tooLong")}</div>
      </Show>
      <Show when={jobs.latest && !running()}>
        <p class="text-sm text-text-weak">{language.t("task.steer.ended")}</p>
      </Show>
      <Show when={draft.messageID && state.delivery}>
        <div role="status" class="text-sm text-text-weak">
          {language.t(state.delivery === "delivered" ? "task.steer.delivered" :
            jobs.latest && !running() ? "task.steer.notDelivered" : "task.steer.queued")}
          <pre class="max-h-32 overflow-auto whitespace-pre-wrap break-words select-text">{draft.sentText}</pre>
          <Show when={jobs.latest && !running() && state.delivery === "queued" && !draft.text}>
            <Button variant="ghost" size="small" onClick={() => setDraft("text", draft.sentText)}>
              {language.t("task.steer.restoreDraft")}
            </Button>
          </Show>
        </div>
      </Show>
      <div class="flex justify-end">
        <Button
          variant="primary"
          size="small"
          disabled={!ready() || !running() || state.sending || !draft.text.trim() || size() > 16_384}
          onClick={() => void send()}
        >
          {language.t(state.sending ? "task.steer.sending" : state.error ? "common.retry" : "task.steer.send")}
        </Button>
      </div>
    </section>
  )
}
