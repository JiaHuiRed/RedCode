import type { Session } from "@redcode-ai/sdk/v2"
import { sameDirectory } from "./validate-session"

// 261117 Red 模式切换只改导航；恢复和快捷槽按持久身份筛选，详见 docs/notes/implemented/architecture/2026-11-17-redspace-companion-chat.md。
export function sessionsForMode(sessions: Session[], companionID?: string) {
  return sessions.filter((session) =>
    companionID ? session.mode === "chat" && session.companionID === companionID : session.mode !== "chat",
  )
}

export function latestCodeSession(sessions: Session[]) {
  return sessionsForMode(sessions)
    .filter((session) => !session.parentID && session.time.archived === undefined)
    .toSorted((a, b) => b.time.updated - a.time.updated)[0]
}

export function latestCompanionSession(sessions: Session[], companionID: string, directory: string) {
  return sessionsForMode(sessions, companionID)
    .filter(
      (session) =>
        !session.parentID && session.time.archived === undefined && sameDirectory(session.directory, directory),
    )
    .toSorted((a, b) => b.time.updated - a.time.updated)[0]
}
