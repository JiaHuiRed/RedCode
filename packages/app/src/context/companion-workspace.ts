import { createEffect } from "solid-js"
import { createStore } from "solid-js/store"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { checksum } from "@redcode-ai/core/util/encode"
import { useGlobalSDK } from "./global-sdk"
import { useServer } from "./server"
import { Persist, persisted } from "@/utils/persist"
import { emptyChatSubmission, restoreChatSubmissions, type ChatSubmission } from "@/utils/chat-home-submit"
import { assignUnboundDraft, clearAcceptedDraft } from "@/utils/companion-workspace"

type Workspace = {
  selected: string
  createRequestID: string
  submissions: Record<string, ChatSubmission>
  drafts: Record<string, string>
  legacyDraftsMigrated: boolean
}

/** One shared selection and retry key for the Chat page and its settings dialog. */
export function useCompanionWorkspace() {
  const sdk = useGlobalSDK()
  const server = useServer()
  const queryClient = useQueryClient()
  const identity = server.key ?? sdk.url
  const key = ["companion-workspace", identity] as const
  const [legacyDrafts, , , legacyReady] = persisted(
    { ...Persist.global(`chat.home.drafts.${checksum(identity)}`), evictOnQuota: false },
    createStore({ messages: {} as Record<string, string> }),
  )
  const [saved, setSaved, , storageReady] = persisted(
    {
      ...Persist.global(`chat.workspace.${checksum(identity)}`),
      evictOnQuota: false,
      migrate: (raw) => {
        const value = raw as Partial<Workspace> | undefined
        return {
          selected: typeof value?.selected === "string" ? value.selected : "",
          createRequestID: typeof value?.createRequestID === "string" ? value.createRequestID : "",
          submissions: restoreChatSubmissions(value?.submissions),
          drafts:
            value?.drafts && typeof value.drafts === "object"
              ? Object.fromEntries(Object.entries(value.drafts).filter((entry) => typeof entry[1] === "string"))
              : {},
          legacyDraftsMigrated: value?.legacyDraftsMigrated === true,
        }
      },
      serialize: (raw) => {
        const value = raw as Workspace
        return JSON.stringify({ ...value, submissions: restoreChatSubmissions(value.submissions) })
      },
    },
    createStore<Workspace>({
      selected: "",
      createRequestID: "",
      submissions: {},
      drafts: {},
      legacyDraftsMigrated: false,
    }),
  )
  const shared = useQuery(() => ({
    queryKey: key,
    queryFn: () => ({
      selected: saved.selected,
      createRequestID: saved.createRequestID,
      submissions: saved.submissions,
      drafts: saved.legacyDraftsMigrated ? saved.drafts : { ...legacyDrafts.messages, ...saved.drafts },
      legacyDraftsMigrated: true,
    }),
    enabled: storageReady() && legacyReady(),
    staleTime: Infinity,
    gcTime: Infinity,
  }))
  createEffect(() => {
    const value = shared.data
    if (storageReady() && value) setSaved(value)
  })
  const update = (change: (current: Workspace) => Workspace) => {
    const value = queryClient.setQueryData<Workspace>(key, (current) => change(current ?? saved))
    if (storageReady() && value) setSaved(value)
  }
  return {
    ready: () => storageReady() && legacyReady() && !!shared.data,
    selected: () => shared.data?.selected,
    select: (id: string) => update((current) => ({ ...current, selected: id })),
    submission: (id: string) => shared.data?.submissions[id],
    drafts: () => shared.data?.drafts ?? {},
    draft: (id: string) => shared.data?.drafts[id] ?? "",
    setDraft: (id: string, text: string) =>
      update((current) => ({ ...current, drafts: { ...current.drafts, [id]: text } })),
    assignDraft: (id: string) => update((current) => ({ ...current, drafts: assignUnboundDraft(current.drafts, id) })),
    clearDraft: (id: string, submitted: string) =>
      update((current) => ({ ...current, drafts: clearAcceptedDraft(current.drafts, id, submitted) })),
    setSubmission: (id: string, value: Partial<ChatSubmission>) =>
      update((current) => ({
        ...current,
        submissions: {
          ...current.submissions,
          [id]: { ...emptyChatSubmission(), ...current.submissions[id], ...value },
        },
      })),
    requestID: () => {
      const existing = shared.data?.createRequestID
      if (existing) return existing
      const id = crypto.randomUUID()
      update((current) => ({ ...current, createRequestID: id }))
      return id
    },
    finishRequest: (id: string) => {
      if (shared.data?.createRequestID === id) update((current) => ({ ...current, createRequestID: "" }))
    },
  }
}
