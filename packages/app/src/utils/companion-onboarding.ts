import type { QueryClient } from "@tanstack/solid-query"
import type { Session } from "@redcode-ai/sdk/v2/client"

export const companionAcceptedKey = (server: string, companion: string) =>
  ["companion", server, companion, "message-accepted"] as const

/** Called only after the real send endpoint accepts the message. Optimistic messages do not qualify. */
export function recordCompanionMessageAccepted(
  queryClient: Pick<QueryClient, "setQueryData">,
  server: string,
  session: Pick<Session, "mode" | "companionID">,
) {
  if (session.mode !== "chat" || !session.companionID) return
  queryClient.setQueryData(companionAcceptedKey(server, session.companionID), true)
}
