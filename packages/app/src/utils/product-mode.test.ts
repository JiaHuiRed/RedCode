import { describe, expect, test } from "bun:test"
import type { Session } from "@redcode-ai/sdk/v2/client"
import { companionSessions, isCodeSession, newConversationHref, productMode } from "./product-mode"

function session(input: Partial<Session>): Session {
  return {
    id: "ses_default",
    slug: "conversation",
    projectID: "global",
    directory: "/companions/profile/workspace",
    title: "Conversation",
    version: "0.19.0",
    time: { created: 1, updated: 1 },
    ...input,
  }
}

describe("Chat and Code navigation", () => {
  test("a restored Chat session determines mode without a Chat URL or saved UI preference", () => {
    expect(productMode("/encoded/session/ses_1", session({ mode: "chat", companionID: "first" }))).toBe("chat")
    expect(productMode("/chat")).toBe("chat")
    expect(productMode("/", session({ mode: "code" }))).toBe("code")
    expect(productMode("/encoded/session/legacy", session({}))).toBe("code")
  })

  test("new conversation keeps Chat away from the Code Soul picker", () => {
    expect(newConversationHref("chat", "private-archive")).toBe("/chat")
    expect(newConversationHref("chat", "private-archive", "existing friend")).toBe("/chat?companion=existing%20friend")
    expect(newConversationHref("code", "project")).toBe("/project/session")
    expect(newConversationHref("code")).toBe("/")
  })

  test("Code views keep legacy sessions and omit personal conversations sharing the global project", () => {
    const sessions = [
      session({ id: "legacy" }),
      session({ id: "code", mode: "code" }),
      session({ id: "chat", mode: "chat", companionID: "first" }),
    ]
    expect(sessions.filter(isCodeSession).map((item) => item.id)).toEqual(["legacy", "code"])
  })

  test("continue lists only this companion's live root conversations in latest activity order", () => {
    const sessions = [
      session({ id: "older", mode: "chat", companionID: "first", time: { created: 1, updated: 2 } }),
      session({ id: "other", mode: "chat", companionID: "second", time: { created: 1, updated: 9 } }),
      session({ id: "child", mode: "chat", companionID: "first", parentID: "older" }),
      session({ id: "archived", mode: "chat", companionID: "first", time: { created: 1, updated: 8, archived: 8 } }),
      session({
        id: "archived-zero",
        mode: "chat",
        companionID: "first",
        time: { created: 1, updated: 8, archived: 0 },
      }),
      session({ id: "code", mode: "code", soul: "same-soul", time: { created: 1, updated: 10 } }),
      session({ id: "latest", mode: "chat", companionID: "first", time: { created: 3, updated: 7 } }),
    ]
    expect(companionSessions(sessions, "first").map((item) => item.id)).toEqual(["latest", "older"])
    expect(sessions[0]?.id).toBe("older")
  })
})
