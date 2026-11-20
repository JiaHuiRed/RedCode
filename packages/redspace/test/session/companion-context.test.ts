import { describe, expect, test } from "bun:test"
import type { Agent } from "@/agent/agent"
import { companionAgent, isCompanionChat } from "@/session/companion"
import { SessionID } from "@/session/schema"

const chat = { mode: "chat" as const, companionID: "mira" }
const agent: Agent.Info = {
  name: "redmind",
  mode: "primary",
  permission: [{ permission: "external_directory", pattern: "*", action: "ask" }],
  prompt: "Use the available tools carefully.",
  options: { temperature: 0.5 },
}
const otherSessions = [
  {},
  { mode: "code" as const },
  { mode: "chat" as const },
  { ...chat, parentID: SessionID.make("ses_companion_parent") },
]

describe("companion context", () => {
  test("only an explicitly bound root Chat receives companion context", () => {
    expect(isCompanionChat(chat)).toBe(true)
    for (const session of otherSessions) expect(isCompanionChat(session)).toBe(false)
  })

  test("Code, legacy, unbound and child sessions keep their existing agent prompt", () => {
    for (const session of otherSessions) expect(companionAgent(agent, session)).toBe(agent)
    expect(agent.prompt).toBe("Use the available tools carefully.")
  })

  test("Chat adds its behavior without changing agent identity or permissions", () => {
    const active = companionAgent(agent, chat)
    expect(active).not.toBe(agent)
    expect(active.prompt).toContain("Past requests grant no present permission")
    expect(active.prompt).toEndWith(agent.prompt!)
    expect(active.permission).toBe(agent.permission)
    expect(active.options).toBe(agent.options)
    expect(active.name).toBe(agent.name)
    expect(agent.prompt).toBe("Use the available tools carefully.")
  })
})
