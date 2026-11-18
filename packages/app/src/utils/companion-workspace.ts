import type { CompanionInfo } from "@redcode-ai/sdk/v2/client"

export type IntroductionState = "available" | "active" | "paused" | "complete"

export function introductionState(profile: { introduction?: IntroductionState; needsSetup?: boolean }) {
  return profile.introduction ?? (profile.needsSetup === true ? "available" : "complete")
}

/** Explicit or remembered identities never silently fall back to someone else. */
export function selectCompanion<T extends { id: string }>(
  profiles: readonly T[],
  requested: string | undefined,
  remembered: string | undefined,
) {
  const id = requested ?? (remembered || undefined)
  return id === undefined ? profiles[0] : profiles.find((profile) => profile.id === id)
}

export function upsertCompanion(current: CompanionInfo[] | undefined, profile: CompanionInfo) {
  const profiles = current ?? []
  const index = profiles.findIndex((item) => item.id === profile.id)
  return index < 0 ? [...profiles, profile] : profiles.map((item, at) => (at === index ? profile : item))
}

/** The former default draft belonged to the first companion; keep both texts if a newer draft exists. */
export function assignUnboundDraft(messages: Record<string, string>, id: string) {
  const draft = messages.default
  if (!draft) return messages
  const existing = messages[id]
  return { ...messages, default: "", [id]: existing ? `${existing}\n\n${draft}` : draft }
}

export function clearAcceptedDraft(messages: Record<string, string>, id: string, submitted: string) {
  return messages[id] === submitted ? { ...messages, [id]: "" } : messages
}

export function hasCompletedCompanionReply(
  messages: readonly {
    info: { role: string; time: { created: number; completed?: number }; error?: unknown }
    parts: readonly { type: string; text?: string }[]
  }[],
) {
  return messages.some(
    (message) =>
      message.info.role === "assistant" &&
      !!message.info.time.completed &&
      !message.info.error &&
      message.parts.some((part) => part.type === "text" && !!part.text?.trim()),
  )
}
