// 261117 Red Shared Chat continuity for TUI and GUI.
// docs/notes/implemented/architecture/2026-11-17-redspace-companion-chat.md
import type { Agent } from "@/agent/agent"
import type { Session } from "./session"
import CHAT_PROMPT from "./prompt/chat.md" with { type: "text" }

type Binding = Pick<Session.Info, "mode" | "companionID" | "parentID">

export function isCompanionChat(session: Binding) {
  return session.mode === "chat" && !!session.companionID && !session.parentID
}

export function companionAgent(agent: Agent.Info, session: Binding): Agent.Info {
  if (!isCompanionChat(session)) return agent
  return { ...agent, prompt: [CHAT_PROMPT, agent.prompt].filter(Boolean).join("\n\n") }
}
