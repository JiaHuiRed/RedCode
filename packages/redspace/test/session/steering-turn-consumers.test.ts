import { expect, spyOn } from "bun:test"
import { Effect, Layer, Option, Stream } from "effect"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ModelID, ProviderID } from "@/provider/schema"
import { Goal } from "@/session/goal"
import { GoalContinuation } from "@/session/goal-continuation"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionReminders } from "@/session/reminders"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const sessionID = SessionID.make("ses_turn_consumers")
const session = { id: sessionID, agent: "redmind" } as Session.Info
function message(text: string, record = false): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      sessionID,
      role: "user",
      agent: "redmind",
      time: { created: Date.now() },
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
    },
    parts: [
      {
        id: PartID.ascending(),
        sessionID,
        messageID: id,
        type: "text",
        text,
        ...(record ? { synthetic: true, metadata: { task_steer_record: { state: "queued" } } } : {}),
      },
    ],
  }
}

it.live("parent steering records do not pause goal continuation; real user input still does", () =>
  Effect.gen(function* () {
    const messages = [message("original task")]
    let now = Date.now()
    const clock = spyOn(Date, "now").mockImplementation(() => now)
    yield* Effect.addFinalizer(() => Effect.sync(() => clock.mockRestore()))
    let prompts = 0
    const layer = GoalContinuation.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Bus.Service, { subscribe: () => Effect.succeed(Stream.never), publish: () => Effect.void }),
          Layer.mock(Config.Service, {
            get: () => Effect.succeed({ experimental: { goal_auto_continue: true } } as Config.Info),
          }),
          Layer.mock(Goal.Service, {
            get: () => Effect.succeed({ text: "original goal", status: "active", tokens_used: 0, turn_count: 0 }),
            tick: () => Effect.void,
          }),
          Layer.mock(Session.Service, {
            get: () => Effect.succeed(session),
            findMessage: (_id, predicate) =>
              Effect.sync(() => {
                const found = messages.toReversed().find(predicate)
                return found ? Option.some(found) : Option.none()
              }),
          }),
          Layer.mock(SessionPrompt.Service, {
            prompt: () =>
              Effect.sync(() => {
                prompts++
                const next = message("goal continuation")
                messages.push(next)
                return next
              }),
            loop: () => Effect.succeed(messages[0]),
          }),
        ),
      ),
    )
    yield* Effect.gen(function* () {
      const continuation = yield* GoalContinuation.Service
      yield* continuation.maybeContinue(sessionID)
      expect(prompts).toBe(1)
      messages.push(message("user steered child", true))
      now += 31_000
      yield* continuation.maybeContinue(sessionID)
      expect(prompts).toBe(2)
      messages.push(message("new parent task"))
      now += 31_000
      yield* continuation.maybeContinue(sessionID)
      expect(prompts).toBe(2)
    }).pipe(Effect.provide(layer))
  }),
)

it.live("plan reminders belong to the current user turn, leaving the visible trace intact", () =>
  Effect.gen(function* () {
    const original = message("original task")
    const trace = message("user steered child", true)
    yield* SessionReminders.apply({ messages: [original, trace], agent: { name: "plan" } as Agent.Info, session }).pipe(
      Effect.provide(
        Layer.mergeAll(RuntimeFlags.layer({}), AppFileSystem.defaultLayer, Layer.mock(Session.Service, {})),
      ),
    )
    expect(original.parts.length).toBe(2)
    expect(trace.parts.length).toBe(1)
    expect(trace.parts[0]).toMatchObject({
      text: "user steered child",
      metadata: { task_steer_record: { state: "queued" } },
    })
  }),
)
