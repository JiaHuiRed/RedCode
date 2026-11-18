import type { CompanionInfo, Session } from "@redcode-ai/sdk/v2/client"

export type PreparedChat = Pick<Session, "id" | "directory" | "companionID">
export type ChatSubmission = {
  sending: boolean
  error: string
  prepared?: PreparedChat
  messageID: string
  submittedText: string
  introductionText: string
  kind: "message" | "introduction"
}

export const emptyChatSubmission = (): ChatSubmission => ({
  sending: false,
  error: "",
  prepared: undefined,
  messageID: "",
  submittedText: "",
  introductionText: "",
  kind: "message",
})

/** Persist retries, never an in-flight lock or a full session snapshot. */
export function restoreChatSubmissions(value: unknown): Record<string, ChatSubmission> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const result: Record<string, ChatSubmission> = {}
  for (const [id, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const item = raw as Partial<ChatSubmission>
    const prepared = item.prepared
    result[id] = {
      ...emptyChatSubmission(),
      ...(prepared &&
      typeof prepared.id === "string" &&
      typeof prepared.directory === "string" &&
      typeof prepared.companionID === "string"
        ? { prepared: { id: prepared.id, directory: prepared.directory, companionID: prepared.companionID } }
        : {}),
      messageID: typeof item.messageID === "string" ? item.messageID : "",
      submittedText: typeof item.submittedText === "string" ? item.submittedText : "",
      introductionText: typeof item.introductionText === "string" ? item.introductionText : "",
      kind: item.kind === "introduction" ? "introduction" : "message",
    }
  }
  return result
}

type Dependencies = {
  ready: () => boolean
  profile: () => CompanionInfo | undefined
  text: () => string
  currentID: () => string | undefined
  epoch: () => number
  mounted: () => boolean
  get: (id: string) => ChatSubmission | undefined
  set: (id: string, value: Partial<ChatSubmission>) => void
  initialize: () => Promise<CompanionInfo>
  prepare: (profile: CompanionInfo) => Promise<void>
  activate: (profile: CompanionInfo) => Promise<CompanionInfo>
  createSession: (profile: CompanionInfo) => Promise<Session>
  getSession: (session: PreparedChat) => Promise<Session>
  submit: (session: Session, messageID: string, text: string) => Promise<unknown>
  receivedProfile: (profile: CompanionInfo) => void
  selectInitialized: (id: string) => void
  assignDraft: (id: string) => void
  clearDraft: (id: string, submitted: string) => void
  accepted: (session: Session) => void
  navigate: (session: Session) => void
  introductionText: (profile: CompanionInfo | undefined) => string
  nextMessageID: () => string
  error: (error: unknown) => string
  invalidSession: () => string
}

/** Shared production controller: every awaited result keeps its original companion and navigation intent. */
export function createChatHomeSubmit(input: Dependencies) {
  return async (kind: ChatSubmission["kind"] = "message") => {
    if (!input.ready() || input.get("default")?.sending) return
    let profile = input.profile()
    let scope = profile?.id ?? "default"
    if (input.get(scope)?.sending) return
    const snapshot = input.text()
    const text =
      kind === "message" ? snapshot.trim() : input.get(scope)?.introductionText || input.introductionText(profile)
    if (!text) return
    const epoch = input.epoch()
    input.set(scope, { sending: true, error: "", kind, ...(kind === "introduction" ? { introductionText: text } : {}) })
    try {
      if (!profile) {
        profile = await input.initialize()
        input.set(profile.id, { ...input.get(scope)! })
        input.set(scope, emptyChatSubmission())
        scope = profile.id
        input.assignDraft(profile.id)
        input.receivedProfile(profile)
        if (input.mounted() && input.epoch() === epoch) input.selectInitialized(profile.id)
      }
      await input.prepare(profile)
      if (kind === "introduction") {
        profile = await input.activate(profile)
        input.receivedProfile(profile)
      }
      const prepared = input.get(scope)?.prepared
      const session = prepared ? await input.getSession(prepared) : await input.createSession(profile)
      if (session.mode !== "chat" || session.companionID !== profile.id || session.directory !== profile.directory) {
        input.set(scope, { prepared: undefined, messageID: "", submittedText: "" })
        throw new Error(input.invalidSession())
      }
      if (!prepared)
        input.set(scope, {
          prepared: { id: session.id, directory: session.directory, companionID: profile.id },
          messageID: "",
          submittedText: "",
        })
      const attempt = input.get(scope)!
      const messageID = attempt.messageID && attempt.submittedText === text ? attempt.messageID : input.nextMessageID()
      input.set(scope, { messageID, submittedText: text })
      await input.submit(session, messageID, text)
      input.accepted(session)
      if (kind === "message") input.clearDraft(scope, snapshot)
      input.set(scope, { prepared: undefined, messageID: "", submittedText: "", introductionText: "" })
      if (input.mounted() && input.epoch() === epoch && input.currentID() === profile.id) input.navigate(session)
    } catch (error) {
      input.set(scope, { error: input.error(error) })
    } finally {
      input.set(scope, { sending: false })
    }
  }
}
