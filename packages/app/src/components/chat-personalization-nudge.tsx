import { createEffect, createMemo, Show, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import type { CompanionInfo, Session } from "@redcode-ai/sdk/v2/client"
import { Button } from "@redcode-ai/ui/button"
import { IconButton } from "@redcode-ai/ui/icon-button"
import { useDialog } from "@redcode-ai/ui/context/dialog"
import { checksum } from "@redcode-ai/core/util/encode"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import { Identifier } from "@/utils/id"
import { errorMessage } from "@/utils/session-helpers"
import { recordCompanionMessageAccepted } from "@/utils/companion-onboarding"
import { hasCompletedCompanionReply, introductionState, upsertCompanion } from "@/utils/companion-workspace"
import { requireCompanionModel, sendCompanionMessage } from "@/utils/chat-send-ack"

const CompanionNudge: Component<{ session: Session }> = (props) => {
  const sdk = useGlobalSDK()
  const server = useServer()
  const sync = useSync()
  const language = useLanguage()
  const dialog = useDialog()
  const queryClient = useQueryClient()
  const id = props.session.companionID!
  const [state, setState] = createStore({ busy: false, error: "", messageID: "", message: "" })
  const [preference, setPreference, , ready] = persisted(
    Persist.global(`chat.personalization.dismissed.${checksum(server.key ?? sdk.url)}.${id}`),
    createStore({ dismissed: false }),
  )
  const profiles = useQuery(() => ({
    queryKey: ["companion", sdk.url, "list"],
    queryFn: async () => (await sdk.client.companion.list({ throwOnError: true })).data,
  }))
  const profile = createMemo(() => profiles.data?.find((item) => item.id === id))
  const introduction = () => (profile() ? introductionState(profile()!) : "complete")
  const liveMessages = createMemo(() =>
    (sync.data.message[props.session.id] ?? []).map((info) => ({ info, parts: sync.data.part[info.id] ?? [] })),
  )
  const idle = () =>
    sync.data.session_status_ready &&
    (sync.data.session_status[props.session.id]?.type ?? "idle") === "idle" &&
    !sync.data.session_working(props.session.id)
  const history = useQuery(() => ({
    queryKey: ["companion", sdk.url, id, "replied", props.session.id],
    enabled: ready() && !preference.dismissed && introduction() === "available",
    staleTime: Infinity,
    queryFn: async () =>
      (
        await sdk.client.session.messages(
          { directory: props.session.directory, sessionID: props.session.id, limit: 10 },
          { throwOnError: true },
        )
      ).data,
  }))
  const replied = () => hasCompletedCompanionReply(liveMessages()) || hasCompletedCompanionReply(history.data ?? [])
  const invite = () => ready() && !preference.dismissed && introduction() === "available" && idle() && replied()

  let refreshed = ""
  createEffect(() => {
    const stamp = liveMessages()
      .flatMap((message) =>
        message.parts.flatMap((part) =>
          part.type === "tool" && part.tool === "companion_profile" && part.state.status === "completed"
            ? [`${part.id}:${part.state.time.end}`]
            : [],
        ),
      )
      .join("|")
    if (!stamp || stamp === refreshed) return
    refreshed = stamp
    void queryClient.invalidateQueries({ queryKey: ["companion", sdk.url, "list"] })
    void queryClient.invalidateQueries({ queryKey: ["companion", sdk.url, "detail", id] })
  })

  const update = async (introduction: "active" | "paused" | "complete") => {
    const { data } = await sdk.client.companion.update(
      { id, companionUpdateInput: { introduction } },
      { throwOnError: true },
    )
    queryClient.setQueryData(["companion", sdk.url, "detail", id], data)
    queryClient.setQueryData<CompanionInfo[]>(["companion", sdk.url, "list"], (current) =>
      upsertCompanion(current, data.profile),
    )
    return data
  }
  const decide = async (next: "paused" | "complete") => {
    if (state.busy) return
    setState({ busy: true, error: "" })
    try {
      await update(next)
      setPreference("dismissed", true)
    } catch (error) {
      setState("error", errorMessage(error, language.t("common.requestFailed")))
    } finally {
      setState("busy", false)
    }
  }
  const begin = async () => {
    if (state.busy || !idle()) return
    const session = { id: props.session.id, directory: props.session.directory, mode: "chat" as const, companionID: id }
    setState({
      busy: true,
      error: "",
      messageID: state.messageID || Identifier.ascending("message"),
      message: state.message || language.t("chat.introduction.message"),
    })
    try {
      await requireCompanionModel(sdk.client, session.directory, language.t("chat.companion.noModels"))
      await update("active")
      await sendCompanionMessage({
        client: sdk.client,
        listen: sdk.event.on,
        session,
        messageID: state.messageID,
        text: state.message,
        timeoutMessage: language.t("chat.companion.unconfirmed"),
      })
      recordCompanionMessageAccepted(queryClient, sdk.url, session)
      setPreference("dismissed", true)
      setState({ messageID: "", message: "" })
    } catch (error) {
      setState("error", errorMessage(error, language.t("common.requestFailed")))
    } finally {
      setState("busy", false)
    }
  }
  const openSettings = (initialTab: "providers" | "models") =>
    void import("./dialog-settings").then((module) =>
      dialog.show(() => <module.DialogSettings initialTab={initialTab} />),
    )
  return (
    <Show when={invite() || introduction() === "active" || state.error}>
      <aside
        data-component="chat-personalization-nudge"
        class="mb-3 flex items-start gap-3 rounded-xl border border-border-weak-base bg-surface-base p-4"
      >
        <div class="min-w-0 flex-1">
          <p class="text-13-regular text-text-weak">
            {language.t(introduction() === "active" ? "chat.introduction.optional" : "chat.native.nudge")}
          </p>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <Show when={invite()}>
              <Button size="small" variant="secondary" disabled={state.busy} onClick={() => void begin()}>
                {language.t("chat.introduction.start")}
              </Button>
              <Button size="small" variant="ghost" disabled={state.busy} onClick={() => void decide("paused")}>
                {language.t("chat.native.later")}
              </Button>
            </Show>
            <Show when={introduction() === "active"}>
              <Button size="small" variant="ghost" disabled={state.busy} onClick={() => void decide("paused")}>
                {language.t("chat.introduction.pause")}
              </Button>
              <Button size="small" variant="secondary" disabled={state.busy} onClick={() => void decide("complete")}>
                {language.t("chat.introduction.finish")}
              </Button>
            </Show>
          </div>
          <Show when={state.error}>
            <div role="alert" class="mt-3 flex flex-col gap-2 text-13-regular text-text-on-critical-base">
              <p>{state.error}</p>
              <div class="flex flex-wrap gap-2">
                <Show when={state.messageID}>
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={state.busy || !idle()}
                    onClick={() => void begin()}
                  >
                    {language.t("common.retry")}
                  </Button>
                </Show>
                <Button size="small" variant="ghost" onClick={() => openSettings("providers")}>
                  {language.t("chat.companion.providers")}
                </Button>
                <Button size="small" variant="ghost" onClick={() => openSettings("models")}>
                  {language.t("chat.companion.models")}
                </Button>
              </div>
            </div>
          </Show>
        </div>
        <Show when={invite()}>
          <IconButton
            icon="close"
            variant="ghost"
            aria-label={language.t("chat.native.dismiss")}
            disabled={state.busy}
            onClick={() => void decide("paused")}
          />
        </Show>
      </aside>
    </Show>
  )
}

export const ChatPersonalizationNudge: Component<{ session?: Session }> = (props) => (
  <Show when={props.session?.mode === "chat" && props.session.companionID ? props.session : undefined} keyed>
    {(session) => <CompanionNudge session={session} />}
  </Show>
)
