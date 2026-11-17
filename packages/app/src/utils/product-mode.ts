import type { Session } from "@redcode-ai/sdk/v2/client"
import { compareSessionTime } from "./session-helpers"

export type ProductMode = "chat" | "code"

// Undefined mode belongs to an existing Code session. The persisted binding wins
// for session routes; selecting an entry point never rewrites a session identity.
export function productMode(pathname: string, session?: Pick<Session, "mode">): ProductMode {
  if (pathname === "/chat" || pathname.startsWith("/chat/")) return "chat"
  return session?.mode === "chat" ? "chat" : "code"
}

export function isCodeSession(session: Pick<Session, "mode">) {
  return session.mode !== "chat"
}

export function companionSessions(sessions: Session[], companionID: string) {
  return sessions
    .filter(
      (session) =>
        session.mode === "chat" && session.companionID === companionID && !session.parentID && !session.time.archived,
    )
    .sort(compareSessionTime)
}

export function newConversationHref(mode: ProductMode, directorySlug?: string, companionID?: string) {
  if (mode === "chat") return companionID ? `/chat?companion=${encodeURIComponent(companionID)}` : "/chat"
  return directorySlug ? `/${directorySlug}/session` : "/"
}
