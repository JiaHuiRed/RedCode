// 260613 Red chat room API handlers
// 260615 Red multi-agent group chat orchestration
import { Chat } from "@/chat"
import * as InstanceState from "@/effect/instance-state"
import { Effect, Cause, Scope } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import * as Session from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionPrompt } from "@/session/prompt"

// 260615 Red persona system prompts for group chat agents
const TUI_PERSONA = [
  "You are TUI (敏敏/柳智敏), the Terminal Agent in RedCode Office.",
  "You specialize in backend, CLI tools, build systems, and code architecture.",
  "You are in a group chat with User and GUI (小宋). Respond concisely.",
  "Be collaborative — acknowledge what GUI is working on, avoid file conflicts.",
  "When you complete work, briefly summarize what you did and what files you touched.",
  "Keep responses focused and actionable. Use Chinese when the user writes in Chinese.",
].join("\n")

const GUI_PERSONA = [
  "You are GUI (小宋/宋雨琦), the Desktop Agent in RedCode Office.",
  "You specialize in frontend, UI/UX, Electron, SolidJS components, and visual design.",
  "You are in a group chat with User and TUI (敏敏). Respond concisely.",
  "Be collaborative — acknowledge what TUI is working on, avoid file conflicts.",
  "When you complete work, briefly summarize what you did and what files you touched.",
  "Keep responses focused and actionable. Use Chinese when the user writes in Chinese.",
].join("\n")

// 260615 Red find or create a persistent session for an office agent
function findOrCreateOfficeSession(
  sessionSvc: Session.Interface,
  title: string,
) {
  return Effect.gen(function* () {
    const all = yield* sessionSvc.list({ scope: "global" })
    const existing = all.find((s) => s.title === title && !s.time.archived)
    if (existing) return existing
    return yield* sessionSvc.create({ title })
  })
}

// 260615 Red dispatch user message to an agent and post response to chat room
function dispatchToAgent(
  promptSvc: SessionPrompt.Interface,
  sessionId: SessionID,
  userText: string,
  roomId: string,
  sender: "tui" | "gui",
  persona: string,
  contextMessages: string,
) {
  return Effect.gen(function* () {
    const systemOverride = [
      persona,
      "",
      "<group-chat-context>",
      contextMessages,
      "</group-chat-context>",
    ].join("\n")

    const result = yield* promptSvc.prompt({
      sessionID: sessionId,
      system: systemOverride,
      parts: [{ type: "text" as const, text: userText }],
    })

    // 260615 Red extract text response from assistant message parts
    const texts: string[] = []
    for (const part of result.parts) {
      if (part.type === "text" && part.text) {
        texts.push(part.text)
      }
    }
    const responseText = texts.join("\n").trim()

    if (responseText) {
      Chat.sendMessage({
        roomId,
        sender,
        text: responseText,
        sessionId: sessionId,
      })
    }

    return responseText
  })
}

// 260615 Red build context string from recent chat room messages
function buildChatContext(roomId: string): string {
  const messages = Chat.getMessages(roomId, { limit: 20 })
  return (messages ?? []).reverse().map((m) => {
    const sender = m.sender === "user" ? "User" : m.sender === "tui" ? "TUI(敏敏)" : "GUI(小宋)"
    return `${sender}: ${m.text ?? ""}`
  }).join("\n")
}

export const chatHandlers = HttpApiBuilder.group(InstanceHttpApi, "chat", (handlers) =>
  Effect.gen(function* () {
    const sessionSvc = yield* Session.Service
    const promptSvc = yield* SessionPrompt.Service
    const scope = yield* Scope.Scope

    return handlers
      .handle("ensureRoom", ({ params, payload }) =>
        Effect.gen(function* () {
          const ctx = yield* InstanceState.context
          const roomId = Chat.ensureRoom(ctx.project.id, params.roomId, payload.type)
          return {
            id: roomId,
            project_id: ctx.project.id,
            type: payload.type,
            time_created: Date.now(),
            time_updated: Date.now(),
          }
        }),
      )
      .handle("messages", ({ params, query }) =>
        Effect.try({
          try: () => Chat.getMessages(params.roomId, {
            limit: query.limit,
            before: query.before,
          }),
          catch: () => new Error("failed"),
        }).pipe(Effect.catch(() => Effect.succeed([] as Chat.MessageRow[]))),
      )
      .handle("send", ({ params, payload }) =>
        Effect.gen(function* () {
          const ctx = yield* InstanceState.context
          Chat.ensureRoom(ctx.project.id, params.roomId, "group")
          const msg = Chat.sendMessage({
            roomId: params.roomId,
            sender: payload.sender,
            text: payload.text,
            contentType: payload.contentType,
            sessionId: payload.sessionId,
          })

          // 260615 Red trigger multi-agent processing for user messages in office room
          if (params.roomId === "office" && payload.sender === "user" && payload.text?.trim()) {
            yield* triggerOfficeAgents(sessionSvc, promptSvc, scope, params.roomId, payload.text)
          }

          return msg
        }),
      )
  }),
)

// 260615 Red trigger both office agents to respond to a user message
function triggerOfficeAgents(
  sessionSvc: Session.Interface,
  promptSvc: SessionPrompt.Interface,
  scope: Scope.Scope,
  roomId: string,
  userText: string,
) {
  return Effect.gen(function* () {
    const contextLines = buildChatContext(roomId)

    const tuiSession = yield* findOrCreateOfficeSession(sessionSvc, "Office Group — TUI")
    const guiSession = yield* findOrCreateOfficeSession(sessionSvc, "Office Group — GUI")

    // 260615 Red dispatch TUI first, then GUI (sequential so GUI sees TUI's response)
    const processBoth = Effect.gen(function* () {
      yield* dispatchToAgent(
        promptSvc, tuiSession.id, userText, roomId, "tui", TUI_PERSONA, contextLines,
      ).pipe(Effect.catch(() => Effect.succeed("")))

      // 260615 Red refresh context after TUI responds so GUI sees TUI's answer
      const updatedContext = buildChatContext(roomId)

      yield* dispatchToAgent(
        promptSvc, guiSession.id, userText, roomId, "gui", GUI_PERSONA, updatedContext,
      ).pipe(Effect.catch(() => Effect.succeed("")))
    })

    // 260615 Red fork to background so HTTP response returns immediately
    yield* processBoth.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("office multi-agent dispatch failed").pipe(
          Effect.annotateLogs({ cause: Cause.pretty(cause) }),
        ),
      ),
      Effect.forkIn(scope, { startImmediately: true }),
    )
  })
}
