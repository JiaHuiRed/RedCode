import { afterAll, afterEach, describe, expect } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Deferred, Effect, Exit, Layer } from "effect"
import { Agent } from "@/agent/agent"
import { BackgroundCancel } from "@/background/cancel"
import { BackgroundJob } from "@/background/job"
import { BackgroundStore } from "@/background/store"
import { Bus } from "@/bus"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { InstanceRef } from "@/effect/instance-ref"
import { ProjectID } from "@/project/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Truncate } from "@/tool/truncate"
import {
  isSteeringMessageValid,
  runSteerableTask,
  steerTaskFromUser,
  steeringTargetRejection,
  type TaskPromptOps,
} from "@/tool/task"
import { TestInstance, disposeAllInstances } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

// 261116 Red 落盘目录指到临时目录：BackgroundJob 启动会写快照，不能碰真实 data 目录。
const store = await mkdtemp(path.join(os.tmpdir(), "redcode-task-steering-store-"))
afterAll(() => rm(store, { recursive: true, force: true }))
afterEach(async () => {
  await disposeAllInstances()
})

const model = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const layer = Layer.mergeAll(
  Agent.defaultLayer,
  BackgroundCancel.defaultLayer,
  BackgroundJob.defaultLayer,
  Bus.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  Session.defaultLayer,
  SessionStatus.defaultLayer,
  Truncate.defaultLayer,
  RuntimeFlags.layer({ experimentalBackgroundSubagents: true }),
  Layer.succeed(BackgroundStore.directory, store),
)

const it = testEffect(layer)

function seedUser(sessions: Session.Interface, sessionID: SessionID, text: string) {
  return Effect.gen(function* () {
    const info: MessageV2.User = {
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      time: { created: Date.now() },
      agent: "build",
      model,
    }
    yield* sessions.updateMessage(info)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: info.id,
      type: "text",
      text,
    })
    return info
  })
}

// 261116 Red 本文件只替换 prompt 的持久化边界（真实 Prompt 的模型 loop 由 prompt.test 覆盖）；
// steering 控制、父记录、幂等与实例归属走 task.ts 的真实实现。
function steeringOps(input: {
  sessions: Session.Interface
  parentSessionID: SessionID
  observed: string[]
  failParent: { value: boolean }
  failAfterParentWrite?: { value: boolean }
}): TaskPromptOps {
  return {
    cancel: () => Effect.void,
    loop: () => Effect.die("unexpected prompt loop in steering test"),
    resolvePromptParts: () => Effect.succeed([]),
    runIsolated: () => Effect.die("unexpected isolation in steering test"),
    prompt: (prompt) =>
      Effect.gen(function* () {
        const instance = yield* InstanceRef
        if (prompt.sessionID === input.parentSessionID) {
          input.observed.push(`parent:${instance?.directory ?? ""}`)
          if (input.failParent.value) return yield* Effect.die(new Error("parent trace write failed"))
        } else {
          input.observed.push(`child:${instance?.directory ?? ""}`)
        }
        const info: MessageV2.User = {
          id: prompt.messageID ?? MessageID.ascending(),
          role: "user",
          sessionID: prompt.sessionID,
          time: { created: Date.now() },
          delivery: prompt.delivery === "queue" ? "queued" : prompt.delivery,
          agent: prompt.agent ?? "build",
          model: prompt.model ?? model,
        }
        yield* input.sessions.updateMessage(info)
        const parts: MessageV2.Part[] = prompt.parts.flatMap((part) =>
          part.type === "text"
            ? [{
                id: PartID.ascending(),
                sessionID: info.sessionID,
                messageID: info.id,
                type: "text" as const,
                text: part.text,
                synthetic: part.synthetic,
                metadata: part.metadata,
              }]
            : [],
        )
        for (const part of parts) yield* input.sessions.updatePart(part)
        if (prompt.sessionID === input.parentSessionID && input.failAfterParentWrite?.value)
          return yield* Effect.die(new Error("parent trace write failed after persist"))
        return { info, parts }
      }),
  }
}

const readChildMessage = (sessionID: SessionID, messageID: MessageID) =>
  MessageV2.get({ sessionID, messageID }).pipe(
    Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
  )

describe("user task steering", () => {
  it.instance("writes one user-sourced child message and one bounded parent trace while the task is still running", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const instance = yield* InstanceRef
      if (!instance) return yield* Effect.die("InstanceRef missing")
      const parent = yield* sessions.create({})
      const child = yield* sessions.create({ parentID: parent.id })
      yield* seedUser(sessions, child.id, "initial task")
      const childDirectory = path.join(test.directory, "child-directory")
      const childInstance = { ...instance, directory: childDirectory, worktree: childDirectory }
      const observed: string[] = []
      const ops = steeringOps({
        sessions,
        parentSessionID: parent.id,
        observed,
        failParent: { value: false },
      })
      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: parent.id },
        run: runSteerableTask(
          { sessionID: child.id, parentSessionID: parent.id, ops, sessions, parentInstance: instance },
          Effect.never,
        ).pipe(
          Effect.map((result) => result.parts.findLast((part) => part.type === "text")?.text ?? ""),
          Effect.provideService(InstanceRef, childInstance),
        ),
      })

      const sent = steerTaskFromUser({
        taskID: child.id,
        parentSessionID: parent.id,
        message: "只核查 KH 的同步入口，先别看归档",
        requestID: "req-user-1",
      })
      yield* Deferred.await(sent.trace)

      const childMessage = yield* pollWithTimeout(
        readChildMessage(child.id, sent.messageID),
        "child steering message was not persisted",
      )
      expect(childMessage.info.role).toBe("user")
      if (childMessage.info.role !== "user") return yield* Effect.die("expected a user message")
      expect(childMessage.info.delivery).toBe("steer")
      const childText = childMessage.parts.find((part) => part.type === "text")
      if (childText?.type !== "text") return yield* Effect.die("expected child text part")
      expect(childText.text).toContain("User steering from the user")
      expect(childText.text).toContain("latest user requirement takes priority")
      expect(childText.text).toContain("只核查 KH 的同步入口，先别看归档")
      expect(childText.metadata?.task_steer).toMatchObject({
        source: "user",
        priority: "user_override",
        request_id: "req-user-1",
        parent_session_id: parent.id,
      })

      const parentTrace = yield* pollWithTimeout(
        Effect.gen(function* () {
          const messages = yield* sessions.messages({ sessionID: parent.id })
          return messages.find((message) =>
            message.parts.some((part) => part.type === "text" && part.metadata?.task_steer_record !== undefined),
          )
        }),
        "parent steering trace was not written",
      )
      const tracePart = parentTrace.parts.find(
        (part) => part.type === "text" && part.metadata?.task_steer_record !== undefined,
      )
      if (tracePart?.type !== "text") return yield* Effect.die("expected parent trace text part")
      expect(tracePart.text).toContain(child.id)
      expect(tracePart.text).toContain("只核查 KH 的同步入口，先别看归档")
      expect(tracePart.text).toContain("state: queued")
      expect(tracePart.metadata?.task_steer_record).toMatchObject({
        task_session_id: child.id,
        parent_session_id: parent.id,
        request_id: "req-user-1",
        source: "user",
        state: "queued",
      })

      expect(observed).toContain(`child:${childDirectory}`)
      expect(observed).toContain(`parent:${test.directory}`)

      const replay = steerTaskFromUser({
        taskID: child.id,
        parentSessionID: parent.id,
        message: "只核查 KH 的同步入口，先别看归档",
        requestID: "req-user-1",
      })
      expect(replay.replayed).toBe(true)
      expect(replay.messageID).toBe(sent.messageID)
      yield* Deferred.await(replay.trace)
      expect(() =>
        steerTaskFromUser({
          taskID: child.id,
          parentSessionID: parent.id,
          message: "换一条不同的要求",
          requestID: "req-user-1",
        }),
      ).toThrow("different guidance")

      const childUsers = (yield* sessions.messages({ sessionID: child.id })).filter(
        (message) => message.info.role === "user",
      )
      const parentTraces = (yield* sessions.messages({ sessionID: parent.id })).filter((message) =>
        message.parts.some((part) => part.type === "text" && part.metadata?.task_steer_record !== undefined),
      )
      expect(childUsers).toHaveLength(2)
      expect(parentTraces).toHaveLength(1)

      yield* jobs.cancel(child.id)
      expect(() =>
        steerTaskFromUser({
          taskID: child.id,
          parentSessionID: parent.id,
          message: "after finish",
          requestID: "req-user-2",
        }),
      ).toThrow("not accepting")
    }),
  )

  it.instance("fails the trace instead of reporting full success, and keeps the child record unique", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const instance = yield* InstanceRef
      if (!instance) return yield* Effect.die("InstanceRef missing")
      const parent = yield* sessions.create({})
      const child = yield* sessions.create({ parentID: parent.id })
      yield* seedUser(sessions, child.id, "initial task")
      const failParent = { value: true }
      const ops = steeringOps({ sessions, parentSessionID: parent.id, observed: [], failParent })
      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: parent.id },
        run: runSteerableTask({ sessionID: child.id, parentSessionID: parent.id, ops, sessions }, Effect.never).pipe(
          Effect.map((result) => result.parts.findLast((part) => part.type === "text")?.text ?? ""),
        ),
      })

      const sent = steerTaskFromUser({
        taskID: child.id,
        parentSessionID: parent.id,
        message: "only KH sync entry",
        requestID: "req-fail-trace",
      })
      const trace = yield* Deferred.await(sent.trace).pipe(Effect.exit)
      expect(Exit.isFailure(trace)).toBe(true)

      const childMessage = yield* pollWithTimeout(
        readChildMessage(child.id, sent.messageID),
        "child message should still be persisted",
      )
      expect(childMessage.info.role).toBe("user")

      // 261116 Red 父 trace 瞬时失败后，同 requestID 重试只修复父记录：
      // 子消息仍只有一条，父记录也只有一条。
      failParent.value = false
      const replay = steerTaskFromUser({
        taskID: child.id,
        parentSessionID: parent.id,
        message: "only KH sync entry",
        requestID: "req-fail-trace",
      })
      expect(replay.messageID).toBe(sent.messageID)
      expect(replay.replayed).toBe(true)
      yield* Deferred.await(replay.trace)
      const childUsers = (yield* sessions.messages({ sessionID: child.id })).filter(
        (message) => message.info.role === "user",
      )
      expect(childUsers).toHaveLength(2)
      const parentTraces = (yield* sessions.messages({ sessionID: parent.id })).filter((message) =>
        message.parts.some((part) => part.type === "text" && part.metadata?.task_steer_record !== undefined),
      )
      expect(parentTraces).toHaveLength(1)
      const tracePart = parentTraces[0]?.parts.find(
        (part) => part.type === "text" && part.metadata?.task_steer_record !== undefined,
      )
      if (tracePart?.type !== "text") return yield* Effect.die("expected repaired parent trace")
      expect(tracePart.text).toContain("only KH sync entry")
      expect(tracePart.metadata?.task_steer_record).toMatchObject({
        request_id: "req-fail-trace",
        state: "queued",
      })

      const again = steerTaskFromUser({
        taskID: child.id,
        parentSessionID: parent.id,
        message: "only KH sync entry",
        requestID: "req-fail-trace",
      })
      yield* Deferred.await(again.trace)
      expect(
        (yield* sessions.messages({ sessionID: child.id })).filter((message) => message.info.role === "user"),
      ).toHaveLength(2)
      expect(
        (yield* sessions.messages({ sessionID: parent.id })).filter((message) =>
          message.parts.some((part) => part.type === "text" && part.metadata?.task_steer_record !== undefined),
        ),
      ).toHaveLength(1)

      yield* jobs.cancel(child.id)
    }),
  )

  it.instance("repairs a parent trace that persisted before failing, without duplicating records", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const instance = yield* InstanceRef
      if (!instance) return yield* Effect.die("InstanceRef missing")
      const parent = yield* sessions.create({})
      const child = yield* sessions.create({ parentID: parent.id })
      yield* seedUser(sessions, child.id, "initial task")
      const failAfterParentWrite = { value: true }
      const ops = steeringOps({
        sessions,
        parentSessionID: parent.id,
        observed: [],
        failParent: { value: false },
        failAfterParentWrite,
      })
      yield* jobs.start({
        id: child.id,
        type: "task",
        metadata: { parentSessionId: parent.id },
        run: runSteerableTask({ sessionID: child.id, parentSessionID: parent.id, ops, sessions }, Effect.never).pipe(
          Effect.map((result) => result.parts.findLast((part) => part.type === "text")?.text ?? ""),
        ),
      })

      const sent = steerTaskFromUser({
        taskID: child.id,
        parentSessionID: parent.id,
        message: "only KH sync entry",
        requestID: "req-after-write",
      })
      expect(Exit.isFailure(yield* Deferred.await(sent.trace).pipe(Effect.exit))).toBe(true)
      const childMessage = yield* pollWithTimeout(
        readChildMessage(child.id, sent.messageID),
        "child message should still be persisted",
      )
      expect(childMessage.info.role).toBe("user")
      const parentTracesBefore = (yield* sessions.messages({ sessionID: parent.id })).filter((message) =>
        message.parts.some((part) => part.type === "text" && part.metadata?.task_steer_record !== undefined),
      )
      expect(parentTracesBefore).toHaveLength(1)

      failAfterParentWrite.value = false
      const replay = steerTaskFromUser({
        taskID: child.id,
        parentSessionID: parent.id,
        message: "only KH sync entry",
        requestID: "req-after-write",
      })
      expect(replay.messageID).toBe(sent.messageID)
      expect(replay.replayed).toBe(true)
      yield* Deferred.await(replay.trace)
      expect(
        (yield* sessions.messages({ sessionID: child.id })).filter((message) => message.info.role === "user"),
      ).toHaveLength(2)
      expect(
        (yield* sessions.messages({ sessionID: parent.id })).filter((message) =>
          message.parts.some((part) => part.type === "text" && part.metadata?.task_steer_record !== undefined),
        ),
      ).toHaveLength(1)
      yield* jobs.cancel(child.id)
    }),
  )

  it.instance("rejects cross-project, non-child, and non-running targets", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const jobs = yield* BackgroundJob.Service
      const instance = yield* InstanceRef
      if (!instance) return yield* Effect.die("InstanceRef missing")
      const parent = yield* sessions.create({})
      const child = yield* sessions.create({ parentID: parent.id })
      const unrelated = yield* sessions.create({})
      yield* jobs.start({ id: child.id, type: "task", run: Effect.never })
      const job = yield* jobs.get(child.id)
      expect(
        steeringTargetRejection({ child, parent, projectID: instance.project.id, job }),
      ).toBeUndefined()
      expect(
        steeringTargetRejection({ child, parent, projectID: ProjectID.make("other-project"), job }),
      ).toBe("cross_project")
      expect(steeringTargetRejection({ child: unrelated, parent: undefined, projectID: instance.project.id, job })).toBe(
        "not_child",
      )
      expect(
        steeringTargetRejection({
          child,
          parent,
          projectID: instance.project.id,
          job: undefined,
        }),
      ).toBe("not_running")
      expect(isSteeringMessageValid("")).toBe(false)
      expect(isSteeringMessageValid("   ")).toBe(false)
      expect(isSteeringMessageValid("x".repeat(16_385))).toBe(false)
      expect(isSteeringMessageValid("ok")).toBe(true)
      yield* jobs.cancel(child.id)
    }),
  )
})
