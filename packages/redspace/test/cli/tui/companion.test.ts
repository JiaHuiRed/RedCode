import { expect, test } from "bun:test"
import type { Session } from "@redcode-ai/sdk/v2"
import path from "node:path"
import {
  companionLabel,
  latestCodeSession,
  latestCompanionSession,
  sessionsForMode,
} from "../../../src/cli/cmd/tui/companion"

const directory = path.join(process.cwd(), "personal")
const session = (id: string, updated: number, fields: Partial<Session> = {}): Session => ({
  id,
  slug: id,
  projectID: "global",
  directory,
  title: id,
  version: "test",
  mode: "chat",
  companionID: "mira",
  time: { created: 1, updated },
  ...fields,
})

test("Chat display names follow the profile while unloaded profiles retain Soul fallbacks", () => {
  expect(companionLabel({ name: "New name" }, "Frozen Soul", "partner-id")).toBe("New name")
  expect(companionLabel(undefined, "Frozen Soul", "partner-id")).toBe("Frozen Soul")
  expect(companionLabel(undefined, undefined, "partner-id")).toBe("partner-id")
})

test("Code continuation includes legacy sessions and excludes Chat, archived and child sessions", () => {
  const sessions = [
    session("code", 1, { mode: "code", companionID: undefined }),
    session("legacy", 2, { mode: undefined, companionID: undefined }),
    session("chat", 3),
    session("child", 4, { mode: "code", companionID: undefined, parentID: "code" }),
    session("archived", 5, { mode: "code", companionID: undefined, time: { created: 1, updated: 5, archived: 0 } }),
  ]
  expect(latestCodeSession(sessions)?.id).toBe("legacy")
  expect(latestCodeSession([session("only-chat", 1)])).toBeUndefined()
})

test("session lists and pinned slots keep the active mode and companion", () => {
  const sessions = [
    session("code", 1, { mode: "code", companionID: undefined }),
    session("legacy", 2, { mode: undefined, companionID: undefined }),
    session("mira", 3),
    session("other", 4, { companionID: "other" }),
  ]
  expect(sessionsForMode(sessions).map((session) => session.id)).toEqual(["code", "legacy"])
  expect(sessionsForMode(sessions, "mira").map((session) => session.id)).toEqual(["mira"])
})

test("Chat resumes the newest active root session for the exact companion and workspace", () => {
  const sessions = [
    session("old", 1),
    session("new", 5),
    session("code", 6, { mode: "code", companionID: undefined }),
    session("legacy", 7, { mode: undefined, companionID: undefined }),
    session("other", 8, { companionID: "other" }),
    session("child", 9, { parentID: "new" }),
    session("archived", 10, { time: { created: 1, updated: 10, archived: 0 } }),
    session("elsewhere", 11, { directory: path.join(process.cwd(), "other-workspace") }),
  ]
  expect(latestCompanionSession(sessions, "mira", directory)?.id).toBe("new")
  expect(latestCompanionSession(sessions, "missing", directory)).toBeUndefined()
})
