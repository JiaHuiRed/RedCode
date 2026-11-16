import { isUserTurn } from "@redcode-ai/core/util/message-turn"
import * as Tool from "./tool"
import DESCRIPTION from "./task.md" with { type: "text" }
import { ToolJsonSchema } from "./json-schema"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { Plugin } from "@/plugin"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { ModelID, ProviderID } from "../provider/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { SessionStatus } from "@/session/status"
import { Config } from "@/config/config"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Option, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Storage } from "@/storage/storage"
import { profileCapabilitySet } from "./capability"
import {
  boundedTaskText,
  compileExploreTaskPacket,
  createChildResultPacket,
  createChildTaskRecord,
  type ChildTaskRecord,
} from "./task-runtime"
import * as Log from "@redcode-ai/core/util/log"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
  loop(input: SessionPrompt.LoopInput): Effect.Effect<MessageV2.WithParts>
  // 260610 Red 在隔离 worktree 实例下运行 run，返回该 worktree 信息 + run 结果
  runIsolated<A, E>(
    input: { name: string; startCommand?: string },
    run: Effect.Effect<A, E>,
  ): Effect.Effect<{ worktree: { name: string; directory: string; branch?: string }; result: A }, E>
}

type SteeringTrace = Deferred.Deferred<void, Error>

type SteeringSend = {
  messageID: MessageID
  fiber: Fiber.Fiber<unknown, unknown>
  // 261116 Red 只等「父会话关联记录已落库」，不等子任务模型结束。
  trace: SteeringTrace
  replayed: boolean
}

type SteeringMessage = {
  message: string
  messageID: MessageID
  fiber?: Fiber.Fiber<unknown, unknown>
  trace: SteeringTrace
  persisted: boolean
  traceSucceeded: boolean
  traceFailed: boolean
  // 261116 Red 父 trace 失败后的修复入口：只补父记录，不重跑子消息。
  repair?: () => Effect.Effect<void, unknown>
}

type Steering = {
  parentSessionID: SessionID
  requests: Map<string, SteeringMessage>
  send: (message: string, options?: { callID?: string; requestID?: string; source?: "agent" | "user" }) => SteeringSend
}

const steering = new Map<SessionID, Steering>()

// 261116 Red 用户引导的硬预算：正文 16,384 UTF-8 bytes，requestID 只做内存幂等键。
export const STEERING_MESSAGE_MAX_BYTES = 16_384
export const STEERING_REQUEST_ID_MAX_BYTES = 256

export function isSteeringMessageValid(message: string) {
  return message.trim().length > 0 && Buffer.byteLength(message, "utf8") <= STEERING_MESSAGE_MAX_BYTES
}

// 261116 Red 用户来源不伪装成父代理工具调用：正文前缀让模型看见来源与冲突优先级，metadata
// 留机读字段。冲突语义按产品约定——同一任务的明确目标冲突以用户最新要求为准，但仍在既有
// 项目/工具/子代理权限内执行。
function userSteeringText(message: string) {
  return [
    "[User steering from the user reviewing this subagent, not from the parent agent.",
    "If it conflicts with the current task goal, this latest user requirement takes priority.",
    "It applies at the next safe step; do not interrupt a running tool.]",
    "",
    message,
  ].join("\n")
}

function userSteeringNotice(input: {
  taskID: SessionID
  title: string | undefined
  message: string
  state: "queued" | "delivered"
  requestID: string
}) {
  return [
    `User steering sent to background task ${input.taskID}${input.title ? ` (${input.title})` : ""}.`,
    `state: ${input.state}`,
    `request_id: ${input.requestID}`,
    "",
    input.message,
  ].join("\n")
}

// 261014 Red 控制通道只在任务执行期存在；捕获子任务的 InstanceRef/隔离边界，而非父实例。
// 决策：docs/notes/implemented/feature/2026-10-14-subagent-steering.md
// 261116 Red 用户引导复用同一控制通道，但父记录必须在父真实实例里写：isolated child 的
// bridge 只用于子消息；parentInstance 在 TaskTool.execute 的父上下文捕获。回执分两段：
// 子消息持久化后马上写父记录并完成 trace，prompt 的 loop 仍由任务收尾 join，不阻塞父记录。
// 决策：docs/notes/implemented/feature/2026-11-16-experience-roadmap-v2.md
export const runSteerableTask = (
  input: {
    sessionID: SessionID
    parentSessionID: SessionID
    ops: TaskPromptOps
    sessions: Session.Interface
    parentInstance?: InstanceContext
  },
  run: Effect.Effect<MessageV2.WithParts, unknown>,
) => Effect.gen(function* () {
  const bridge = yield* EffectBridge.make()
  const pending: Array<Fiber.Fiber<MessageV2.WithParts, unknown>> = []
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => {
      steering.set(input.sessionID, {
        parentSessionID: input.parentSessionID,
        requests: new Map(),
        send(message, options) {
          const requestID = options?.requestID
          const source = options?.source ?? "agent"
          const existing = requestID ? steering.get(input.sessionID)?.requests.get(requestID) : undefined
          if (existing) {
            if (existing.message !== message)
              throw new Error(`Steering requestID "${requestID}" was already used for different guidance to this task`)
            if (!existing.fiber) throw new Error("Steering request is still being registered")
            // 261116 Red 父 trace 失败但子消息已落库：同 requestID 重试只修复父记录，
            // 不重跑模型、不重复子消息。
            if (existing.traceFailed && existing.persisted && existing.repair) {
              const trace = Deferred.makeUnsafe<void, Error>()
              existing.trace = trace
              existing.traceSucceeded = false
              existing.traceFailed = false
              const fiber = bridge.fork(
                existing.repair().pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      existing.traceSucceeded = true
                    }),
                  ),
                  Effect.tap(() => Deferred.succeed(trace, undefined).pipe(Effect.ignore)),
                  Effect.onError((cause) => {
                    existing.traceFailed = true
                    const squashed = Cause.squash(cause)
                    const error = squashed instanceof Error ? squashed : new Error(String(squashed))
                    return Deferred.fail(trace, error).pipe(Effect.ignore)
                  }),
                ),
              )
              return { messageID: existing.messageID, fiber, trace, replayed: true }
            }
            return { messageID: existing.messageID, fiber: existing.fiber, trace: existing.trace, replayed: true }
          }
          const messageID = MessageID.ascending()
          const text = source === "user" ? userSteeringText(message) : message
          const trace = Deferred.makeUnsafe<void, Error>()
          const record: SteeringMessage = {
            message,
            messageID,
            trace,
            persisted: false,
            traceSucceeded: false,
            traceFailed: false,
          }
          const fiber = bridge.fork(Effect.gen(function* () {
            const latest = yield* input.sessions.findMessage(input.sessionID, (item) => item.info.role === "user")
            if (Option.isNone(latest) || latest.value.info.role !== "user")
              return yield* Effect.fail(new Error("Task has no active user message to steer"))
            const user = latest.value.info
            // 261116 Red 先把 prompt 作为子 fiber 启动：它内部的 loop 会跨到任务后续步骤，
            // 不能在这里同步等待；父记录只等子消息持久化。
            const promptFiber = yield* Effect.forkChild(input.ops.prompt({
              sessionID: input.sessionID,
              messageID,
              agent: user.agent,
              model: user.model,
              variant: user.model.variant,
              delivery: "steer",
              parts: [{
                type: "text",
                text,
                metadata: {
                  task_steer: {
                    parent_session_id: input.parentSessionID,
                    call_id: options?.callID,
                    request_id: requestID,
                    source,
                    priority: source === "user" ? "user_override" : "task_goal",
                  },
                },
              }],
            }))
            const deadline = (yield* Clock.currentTimeMillis) + 10_000
            let childMessage: MessageV2.WithParts | undefined
            while (true) {
              childMessage = yield* MessageV2.get({ sessionID: input.sessionID, messageID }).pipe(
                Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
              )
              if (childMessage?.info.role === "user") {
                record.persisted = true
                break
              }
              const exit = promptFiber.pollUnsafe()
              if (exit && Exit.isFailure(exit))
                return yield* Effect.fail(
                  new Error(`Steering failed before the message was persisted: ${Cause.pretty(exit.cause)}`),
                )
              if ((yield* Clock.currentTimeMillis) >= deadline)
                return yield* Effect.fail(new Error("Timed out waiting for steering message persistence"))
              yield* Effect.sleep("50 millis")
            }
            if (childMessage?.info.role !== "user")
              return yield* Effect.fail(new Error("Steering message did not persist"))
            if (source !== "user" || !requestID) {
              record.traceSucceeded = true
              yield* Deferred.succeed(trace, undefined).pipe(Effect.ignore)
              return yield* Fiber.join(promptFiber)
            }
            const [child, parent] = yield* Effect.all([
              input.sessions.get(input.sessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined))),
              input.sessions.get(input.parentSessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined))),
            ])
            // 261116 Red 父记录按 requestID 做幂等查找：父 prompt 已落库但返回失败时，
            // 重试更新原记录而不是再造一条。
            const findParentTrace = Effect.gen(function* () {
              const messages = yield* input.sessions.messages({ sessionID: input.parentSessionID })
              for (const candidate of messages) {
                const part = candidate.parts.find(
                  (item): item is MessageV2.TextPart =>
                    item.type === "text" &&
                    item.metadata?.task_steer_record?.request_id === requestID &&
                    item.metadata?.task_steer_record?.task_session_id === input.sessionID,
                )
                if (part) return part
              }
              return undefined
            })
            const writeParentTrace = (nextState: "queued" | "delivered") =>
              Effect.gen(function* () {
                const existingTrace = yield* findParentTrace
                if (existingTrace) {
                  yield* input.sessions.updatePart({
                    ...existingTrace,
                    text: userSteeringNotice({
                      taskID: input.sessionID,
                      title: child?.title,
                      message,
                      state: nextState,
                      requestID,
                    }),
                    metadata: {
                      ...existingTrace.metadata,
                      task_steer_record: {
                        ...(existingTrace.metadata?.task_steer_record as Record<string, unknown> | undefined),
                        state: nextState,
                      },
                    },
                  })
                  return existingTrace
                }
                // 261116 Red 父记录在父真实实例/目录执行；isolated child 的 provider 不能把
                // noReply 写进子 worktree 的实例上下文。失败不吞：trace 会失败并让 HTTP 如实报错。
                const parentPrompt = input.ops.prompt({
                  sessionID: input.parentSessionID,
                  noReply: true,
                  agent: parent?.agent,
                  parts: [{
                    type: "text",
                    synthetic: true,
                    text: userSteeringNotice({
                      taskID: input.sessionID,
                      title: child?.title,
                      message,
                      state: nextState,
                      requestID,
                    }),
                    metadata: {
                      task_steer_record: {
                        task_session_id: input.sessionID,
                        parent_session_id: input.parentSessionID,
                        request_id: requestID,
                        source: "user",
                        priority: "user_override",
                        state: nextState,
                      },
                    },
                  }],
                })
                const parentInstance = input.parentInstance
                const parentTrace = yield* (parentInstance === undefined
                  ? parentPrompt
                  : parentPrompt.pipe(Effect.provideService(InstanceRef, parentInstance)))
                const part = parentTrace.parts.find(
                  (item): item is MessageV2.TextPart =>
                    item.type === "text" && item.metadata?.task_steer_record !== undefined,
                )
                if (!part) return yield* Effect.fail(new Error("Parent steering trace part is missing"))
                return part
              })
            const repair = Effect.gen(function* () {
              const current = yield* MessageV2.get({ sessionID: input.sessionID, messageID }).pipe(
                Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
              )
              const nextState: "queued" | "delivered" =
                current?.info.role === "user" && current.info.delivery === "delivered" ? "delivered" : "queued"
              return { part: yield* writeParentTrace(nextState), state: nextState }
            })
            record.repair = () => repair.pipe(Effect.asVoid)
            const { part: tracePart, state } = yield* repair
            record.traceSucceeded = true
            yield* Deferred.succeed(trace, undefined).pipe(Effect.ignore)
            const updateTrace = (nextState: "queued" | "delivered") =>
              input.sessions.updatePart({
                ...tracePart,
                text: userSteeringNotice({
                  taskID: input.sessionID,
                  title: child?.title,
                  message,
                  state: nextState,
                  requestID,
                }),
                metadata: {
                  ...tracePart.metadata,
                  task_steer_record: {
                    ...(tracePart.metadata?.task_steer_record as Record<string, unknown> | undefined),
                    state: nextState,
                  },
                },
              })
            if (state === "queued") {
              yield* Effect.forkChild(Effect.gen(function* () {
                while (true) {
                  const current = yield* MessageV2.get({ sessionID: input.sessionID, messageID }).pipe(
                    Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
                  )
                  if (current?.info.role === "user" && current.info.delivery === "delivered") {
                    yield* updateTrace("delivered").pipe(
                      Effect.catchCause(() =>
                        Effect.sync(() =>
                          log.warn("failed to update parent steering trace delivery", {
                            sessionID: input.parentSessionID,
                            taskSessionID: input.sessionID,
                            requestID,
                          }),
                        ),
                      ),
                    )
                    return
                  }
                  if (promptFiber.pollUnsafe() !== undefined) return
                  yield* Effect.sleep("250 millis")
                }
              }))
            }
            // 261116 Red 最后一步竞态：watcher 可能随 send fiber 关闭被打断；join 后
            // 同步读最终 delivery（成功/失败都读），保证 delivered 时父记录不会永远 queued。
            const outcome = yield* Effect.exit(Fiber.join(promptFiber))
            if (state === "queued") {
              const final = yield* MessageV2.get({ sessionID: input.sessionID, messageID }).pipe(
                Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
              )
              if (final?.info.role === "user" && final.info.delivery === "delivered")
                yield* updateTrace("delivered").pipe(
                  Effect.catchCause(() =>
                    Effect.sync(() =>
                      log.warn("failed to update final parent steering trace delivery", {
                        sessionID: input.parentSessionID,
                        taskSessionID: input.sessionID,
                        requestID,
                      }),
                    ),
                  ),
                )
            }
            if (Exit.isSuccess(outcome)) return outcome.value
            return yield* Effect.failCause(outcome.cause)
          }).pipe(
            Effect.onError((cause) => {
              const squashed = Cause.squash(cause)
              const error = squashed instanceof Error ? squashed : new Error(String(squashed))
              const requests = steering.get(input.sessionID)?.requests
              // 261116 Red 只在子消息未落库时撤销幂等登记；已落库的投递保留同一条记录，
              // 重试不会重复写子消息（父记录失败也不制造第二条）。
              if (!record.persisted && requestID && requests?.get(requestID)?.messageID === messageID)
                requests.delete(requestID)
              record.traceFailed = !record.traceSucceeded
              return Deferred.fail(trace, error).pipe(Effect.ignore)
            }),
          ))
          record.fiber = fiber
          if (requestID) steering.get(input.sessionID)?.requests.set(requestID, record)
          pending.push(fiber)
          return { messageID, fiber, trace, replayed: false }
        },
      })
    }),
    () => Effect.gen(function* () {
      let result = yield* run
      // 261014 Red 收尾先关闭准入；已接受的投递等待原 runner 并复用既有收尾重试，不能丢回执。
      steering.delete(input.sessionID)
      for (const fiber of pending) {
        // 261116 Red 单条引导（含父记录 trace）失败不应把子任务本身判失败；失败已通过
        // task_status / HTTP 回执返回给发起方。
        const outcome = yield* Effect.exit(Fiber.join(fiber))
        if (!Exit.isSuccess(outcome)) continue
        const delivered = outcome.value
        if (MessageV2.compareTime(delivered.info, result.info) > 0) result = delivered
      }
      return result
    }),
    () => Effect.gen(function* () {
      steering.delete(input.sessionID)
      for (const fiber of pending) yield* Fiber.interrupt(fiber)
    }),
  )
})

function steeringControl(taskID: SessionID, parentSessionID: SessionID) {
  const control = steering.get(taskID)
  if (!control || control.parentSessionID !== parentSessionID)
    throw new Error("Task is not accepting steering messages")
  return control
}

export function steerTask(taskID: SessionID, parentSessionID: SessionID, message: string, callID?: string) {
  return steeringControl(taskID, parentSessionID).send(message, { callID, source: "agent" })
}

// 261116 Red 用户入口复用同一个 task 实例控制通道；source=user 只改来源标记与父记录，
// 不伪造父代理 ctx，也不走工具调用。
export function steerTaskFromUser(input: {
  taskID: SessionID
  parentSessionID: SessionID
  message: string
  requestID: string
}) {
  if (!isSteeringMessageValid(input.message))
    throw new Error("Steering message must be nonblank and at most 16384 UTF-8 bytes")
  if (!input.requestID.trim()) throw new Error("Steering requestID must be nonblank")
  if (Buffer.byteLength(input.requestID, "utf8") > STEERING_REQUEST_ID_MAX_BYTES)
    throw new Error(`Steering requestID must be at most ${STEERING_REQUEST_ID_MAX_BYTES} UTF-8 bytes`)
  return steeringControl(input.taskID, input.parentSessionID).send(input.message, {
    requestID: input.requestID,
    source: "user",
  })
}

export type SteeringTargetRejection = "cross_project" | "not_child" | "not_running"

// 261116 Red HTTP 入口的实际归属校验：项目 ID 由 middleware 提供的实例上下文给出，
// 不信任客户端路径参数；父子关系取目标会话的真实 parentID。
export function steeringTargetRejection(input: {
  child: Session.Info
  parent: Session.Info | undefined
  projectID: Session.Info["projectID"]
  job: BackgroundJob.Info | undefined
}): SteeringTargetRejection | undefined {
  if (input.child.projectID !== input.projectID) return "cross_project"
  if (!input.child.parentID || input.child.parentID === input.child.id || !input.parent) return "not_child"
  if (input.parent.projectID !== input.projectID) return "cross_project"
  if (input.job?.type !== "task" || input.job.status !== "running") return "not_running"
  return undefined
}

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "",
  "",
  [
    "Background mode: background=true returns immediately and keeps the session responsive.",
    "Otherwise the session waits for the full subagent run and cannot accept new messages.",
    "Prefer background mode; block only when your very next action requires the result.",
    "Use task_status(task_id=..., wait=false) to poll, or wait=true when ready to join.",
  ].join(" "),
].join("\n")

const Isolation = Schema.optional(Schema.Literal("worktree")).annotate({
  description:
    'When set to "worktree", run the subagent in an isolated git worktree (separate working directory + branch). Only for parallel experimental branch work intended to be discarded: the isolated child cannot write to absolute paths in the parent workspace (by design), and its changes are not merged back — integration is the caller\'s job. Read-only agents such as explore reject isolation.',
})

const BaseParameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
  isolation: Isolation,
})

export const Parameters = Schema.Struct({
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      "This should only be set if you mean to resume a previous task (you can pass a prior task_id and the task will continue the same subagent session as before instead of creating a fresh one)",
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
  background: Schema.optional(Schema.Boolean).annotate({
    description: "When true, launch the subagent in the background and return immediately",
  }),
  isolation: Isolation,
})

function output(sessionID: SessionID, text: string, resumable = true) {
  return [
    resumable
      ? `task_id: ${sessionID} (for resuming to continue this task if needed)`
      : `task_id: ${sessionID} (explore tasks cannot be resumed; dispatch a new explore task instead)`,
    "",
    "<task_result>",
    text,
    "</task_result>",
  ].join("\n")
}

const log = Log.create({ service: "tool.task" })

function isolatedOutput(sessionID: SessionID, text: string, worktree: { directory: string; branch?: string }) {
  return [
    `task_id: ${sessionID} (for resuming to continue this task if needed)`,
    `worktree: ${worktree.directory}${worktree.branch ? ` (branch ${worktree.branch})` : ""}`,
    "",
    "<task_result>",
    text,
    "</task_result>",
  ].join("\n")
}

function backgroundOutput(sessionID: SessionID) {
  return [
    `task_id: ${sessionID} (for polling this task with task_status)`,
    "state: running",
    "",
    "<task_result>",
    "Background task started. Continue your current work and call task_status when you need the result.",
    "</task_result>",
  ].join("\n")
}

function backgroundMessage(input: {
  sessionID: SessionID
  description: string
  state: "completed" | "error"
  text: string
}) {
  const tag = input.state === "completed" ? "task_result" : "task_error"
  const title =
    input.state === "completed"
      ? `Background task completed: ${input.description}`
      : `Background task failed: ${input.description}`
  return [title, `task_id: ${input.sessionID}`, `state: ${input.state}`, "", `<${tag}>`, input.text, `</${tag}>`].join(
    "\n",
  )
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service
    const flags = yield* RuntimeFlags.Service
    const plugin = yield* Plugin.Service

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      // 260922 Red serviceOption 此前在 init（ToolRegistry 构建期）求值并闭包捕获——构建
      // 环境是否含 Storage 完全取决于消费方的装配形状（mergeAll 平级成员可见、provide 链
      // 与 defaultLayer 内部 provide 均不可见，探针实测），fac7d556 只补 prompt 层装配，
      // server.ts 等路径下 explore 子代理仍全灭。改为 execute 期动态求值：执行 fiber 的
      // Context ⊇ 装配输出全集，prompt/server/app-runtime 三条路径一律可见。走到这=环境
      // 真缺 Storage，先响一条再 fail。
      const storage = yield* Effect.serviceOption(Storage.Service)
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require REDCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }
      const isolated = params.isolation === "worktree"
      // 261107 Red D1（docs/agent-dispatch-plan.md D1，本方案核心）：explore+isolation
      // 参数校验直接拒绝——只读工种与文件隔离正交，唯一「效果」是读到过时代码视图；
      // 文案写明原因防模型重试。execute+isolation 保留（并行实验分支），其边界在
      // schema description 里声明。
      if (params.subagent_type === "explore" && isolated) {
        return yield* Effect.fail(
          new Error(
            'explore is read-only and does not accept isolation="worktree"; isolation only gates file writes and would just serve a stale code view. Re-dispatch without isolation.',
          ),
        )
      }

      // 沿 parentID 链上溯算嵌套深度，超限直接拒绝——放在权限询问之前，别先弹窗再报错
      const parent = yield* sessions.get(ctx.sessionID)
      {
        let current = parent
        let depth = 0
        while (current.parentID) {
          depth++
          current = yield* sessions.get(current.parentID)
        }
        if (depth >= (cfg.subagent_depth ?? 1)) {
          return yield* Effect.fail(
            new Error(
              `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
            ),
          )
        }
      }

      const explorePacket =
        params.subagent_type === "explore"
          ? compileExploreTaskPacket({ goal: params.prompt, directory: parent.directory })
          : undefined
      if (params.subagent_type === "explore" && !explorePacket) {
        return yield* Effect.fail(new Error("Explore task packet is invalid and was not started"))
      }
      if (explorePacket && params.task_id) {
        // 261107 Red 文案如实：explore 续跑当前不支持（D2 缓办待观察数据），旧文案
        // 「requires its canonical task packet」指向不存在的机制，误导排查。
        return yield* Effect.fail(new Error("Explore tasks cannot be resumed via task_id; dispatch a new explore task instead"))
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      const taskID = params.task_id
      const session = taskID
        ? yield* sessions.get(SessionID.make(taskID)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const parentAgent = parent.agent
        ? yield* agent.get(parent.agent).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      const nextSession =
        session ??
        (yield* Effect.gen(function* () {
          const permission = [
            ...deriveSubagentSessionPermission({
              parentSessionPermission: parent.permission ?? [],
              parentAgent,
              subagent: next,
            }),
            ...(cfg.experimental?.primary_tools?.map((item) => ({
              pattern: "*",
              action: "allow" as const,
              permission: item,
            })) ?? []),
            // 261011 Red bash 从硬 deny 摘除：explore 的 bash 改由 md 白名单收口（仅六个 git
            // 只读子命令，docs/agent-dispatch-plan.md D4）。运行层仍硬 deny 其余写类工具——
            // 只读红线不依赖权限层单一闸门。曾经 bash: allow 是假门票（443c92b1 的 guard 在
            // findLast 末位掀翻声明），本次是 guard 与白名单同步摘/加，缺一则另一侧失效。
            ...(explorePacket
              ? ["edit", "write", "apply_patch", "task", "commit", "push"].map((permission) => ({
                  pattern: "*",
                  action: "deny" as const,
                  permission,
                }))
              : []),
          ]
          return yield* sessions
            .create({
              parentID: ctx.sessionID,
              title: params.description + ` (@${next.name} subagent)`,
              permission,
            })
        }))

      if (explorePacket) {
        if (Option.isNone(storage)) {
          log.warn("explore packet without storage service", { sessionID: nextSession.id })
          yield* sessions.remove(nextSession.id).pipe(Effect.ignore)
          return yield* Effect.fail(new Error("Explore task runtime storage is unavailable"))
        }
        yield* storage.value
          .write(
            ["task-runtime", String(nextSession.id)],
            createChildTaskRecord({
              taskID: nextSession.id,
              parentSessionID: ctx.sessionID,
              childSessionID: nextSession.id,
              packet: explorePacket,
              // 261017 Red 与读取端 fallback 共用 profile；命令授权仍由继承权限与 Git 白名单裁决。
              capabilities: [...profileCapabilitySet("explore")],
              profile: "explore",
              createdAt: Date.now(),
            }),
          )
          .pipe(
            Effect.tapError(() => sessions.remove(nextSession.id).pipe(Effect.ignore)),
          )
      }
      const projectResult = (text: string) => (explorePacket ? boundedTaskText(text) : text)
      const runtimeKey = ["task-runtime", String(nextSession.id)]
      const startedAt = Date.now()
      const persistResult = Effect.fn("TaskTool.persistResult")(function* (input: {
        status: "ready_for_review" | "failed" | "cancelled"
        summary: string
        termination: "normal" | "cancelled" | "timeout" | "scope_denied" | "persistence_failed"
      }) {
        if (!explorePacket) return
        if (Option.isNone(storage)) return yield* Effect.fail(new Error("Explore task runtime storage is unavailable"))
        yield* storage.value.update<ChildTaskRecord>(runtimeKey, (record) => {
          record.result = createChildResultPacket({
            packet: explorePacket,
            status: input.status,
            summary: input.summary,
            elapsedMs: Date.now() - startedAt,
            termination: input.termination,
          })
        })
      })
      type TrackedRun = {
        result: string
        output: string
        worktree?: { directory: string; branch?: string }
      }
      const runTracked = (run: Effect.Effect<TrackedRun, unknown>) =>
        run.pipe(
          Effect.tap(({ result }) =>
            persistResult({
              status: "ready_for_review",
              summary: result,
              termination: "normal",
            }),
          ),
        )

      yield* plugin
        .trigger(
          "subagent.start",
          {
            sessionID: nextSession.id,
            parentSessionID: ctx.sessionID,
            agent: next.name,
            title: params.description,
          },
          {},
        )
        .pipe(Effect.catch(() => Effect.void))

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(Effect.orDie)
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))

      const model = next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        ...(runInBackground ? { background: true } : {}),
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))
      // 261116 Red 父记录要写回父真实实例/目录；在 runIsolated 包住 runTask 之前捕获。
      const parentInstance = yield* InstanceRef
      const runCancel = yield* EffectBridge.make()

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        // 260909 Red 请求级 stall guard 已在 session/llm.ts：它区分首响应、流静默与本地工具执行。
        // task 层不能再按整个子代理寿命计时，否则长任务会在正常推进时被误杀。
        // 决策：docs/notes/implemented/bug-fix/2026-09-09-subagent-request-watchdog.md
        const runWithModel = Effect.fn("TaskTool.runWithModel")(function* (useModel: {
          modelID: ModelID
          providerID: ProviderID
        }) {
          const parts = yield* ops.resolvePromptParts(params.prompt)
          const result = yield* runSteerableTask(
            { sessionID: nextSession.id, parentSessionID: ctx.sessionID, ops, sessions, parentInstance },
            ops.prompt({
            messageID: MessageID.ascending(),
            sessionID: nextSession.id,
            model: {
              modelID: useModel.modelID,
              providerID: useModel.providerID,
            },
            agent: next.name,
            tools: {
              ...(next.permission.some((rule) => rule.permission === "todowrite") ? {} : { todowrite: false }),
              ...(next.permission.some((rule) => rule.permission === id) ? {} : { task: false }),
              ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
            },
            parts,
            }),
          )
          // 261108 Red 子代理失败必须传播（审计 RC-P1-02）：此前只取最后一段文本，
          // 子代理以 API 错误 / 工具熔断 / 中断收尾时同样返回空串，父代理把它当成功继续。
          // 空文本本身不算失败（合法无输出），只有消息自带 error 才算。
          const info = result.info
          if (info.role === "assistant" && info.error) {
            const reason =
              ("data" in info.error && info.error.data && typeof info.error.data === "object"
                ? (info.error.data as { message?: string }).message
                : undefined) ?? info.error.name
            return yield* Effect.fail(new Error(`子代理 ${next.name} 执行失败：${reason}`))
          }
          const text = result.parts.findLast((item) => item.type === "text")?.text ?? ""
          yield* plugin
            .trigger(
              "subagent.stop",
              {
                sessionID: nextSession.id,
                parentSessionID: ctx.sessionID,
                agent: next.name,
                output: text,
              },
              {},
            )
            .pipe(Effect.catch(() => Effect.void))
          return text
        })

        return yield* runWithModel(model)
      })

      // 260903 cc 等父会话空闲的上限。原来是无上限的 300ms 递归：会话若因别的原因永不 idle，
      // 它就永远等下去，而且**不留任何痕迹**——不超时、不报错、不记日志，与本仓冻结族
     // （docs/notes/implemented/bug-fix/2026-09-03-sse-abort-on-stream-end.md）同一种气味。
      // 超时**不丢结果**：inject() 已经先把合成结果落进会话了（noReply），这里等的只是
      // "自动替用户按下继续"这一步。所以超时的正确行为是放弃续跑 + 告诉用户结果已就绪，
      // 把静默挂起变成可见且可操作的状态。
      // 30 分钟：单轮跑这么久已属异常，而更短会误杀正当的长任务（本仓压缩阈值 400K，
      // 一轮几十次工具调用是常态）。
      // 用 Clock.currentTimeMillis 而不是 Date.now()：前者能被 TestClock 拨动，这个上限才写得了测试。
      // 「存在但没人验过的开关」在本仓有过前车（appProcess.run 的 timeout），与 background/job.ts 一致。
      const RESUME_IDLE_TIMEOUT_MS = 30 * 60_000
      type ResumeInput = { userID: MessageID; state: "completed" | "error"; deadline?: number }
      const resumeWhenIdle: (input: ResumeInput) => Effect.Effect<void> = Effect.fn("TaskTool.resumeWhenIdle")(
        function* (input: ResumeInput) {
          const deadline = input.deadline ?? (yield* Clock.currentTimeMillis) + RESUME_IDLE_TIMEOUT_MS
          const latest = yield* sessions
            .findMessage(ctx.sessionID, (item) => isUserTurn(item.info, item.parts))
            .pipe(Effect.orDie)
          if (Option.isNone(latest)) return
          if (latest.value.info.id !== input.userID) return
          if ((yield* status.get(ctx.sessionID)).type !== "idle") {
            if ((yield* Clock.currentTimeMillis) >= deadline) {
              yield* Effect.logWarning("background task result injected but session never went idle", {
                sessionID: ctx.sessionID,
                taskSessionID: nextSession.id,
                description: params.description,
                state: input.state,
                waitedMs: RESUME_IDLE_TIMEOUT_MS,
              })
              yield* bus.publish(TuiEvent.ToastShow, {
                title: "Background task result waiting",
                message: `Background task "${params.description}" finished, but this session stayed busy for 30 minutes so it was not resumed automatically. The result is already in the conversation — send any message to pick it up.`,
                variant: "warning",
                duration: 8000,
              })
              return
            }
            yield* Effect.sleep("300 millis")
            return yield* resumeWhenIdle({ ...input, deadline })
          }
          yield* bus.publish(TuiEvent.ToastShow, {
            title: input.state === "completed" ? "Background task complete" : "Background task failed",
            message:
              input.state === "completed"
                ? `Background task "${params.description}" finished. Resuming the main thread.`
                : `Background task "${params.description}" failed. Resuming the main thread.`,
            variant: input.state === "completed" ? "success" : "error",
            duration: 5000,
          })
          yield* ops
            .loop({ sessionID: ctx.sessionID })
            .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
        },
      )

      const continueIfIdle = Effect.fn("TaskTool.continueIfIdle")(function* (input: {
        userID: MessageID
        state: "completed" | "error"
      }) {
        yield* resumeWhenIdle(input).pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        const message = yield* ops.prompt({
          sessionID: ctx.sessionID,
          noReply: true,
          agent: currentParent.agent ?? ctx.agent,
          parts: [
            {
              type: "text",
              synthetic: true,
              text: backgroundMessage({
                sessionID: nextSession.id,
                description: params.description,
                state,
                text: projectResult(text),
              }),
            },
          ],
        })
        yield* continueIfIdle({ userID: message.info.id, state })
      })

      // 261017 Red 子任务执行状态与回传状态分开；回传失败保留原结果供 task_status 恢复，不重跑。
      // 决策：docs/notes/implemented/bug-fix/2026-10-17-background-result-delivery-evidence.md
      const deliverResult = (state: "completed" | "error", text: string) =>
        inject(state, text).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
            log.warn("background task result delivery failed", {
              sessionID: ctx.sessionID,
              taskSessionID: nextSession.id,
              state,
            })
            // 261017 Red 总线已销毁等通知失败只保留前面的持久日志，不覆盖子任务结果。
            return bus.publish(TuiEvent.ToastShow, {
              title: "Background task result delivery failed",
              message: `Background result delivery could not be confirmed. Check the parent conversation first; if the result is missing, use task_status with task_id "${nextSession.id}" to recover it. Automatic continuation was not started.`,
              variant: "warning",
              duration: 8000,
            }).pipe(Effect.ignoreCause)
          }),
        )

      const existing = yield* background.get(nextSession.id)
      if (existing?.status === "running") {
        return yield* Effect.fail(
          new Error(`Task ${nextSession.id} is already running. Use task_status to check progress.`),
        )
      }

      if (runInBackground) {
        // 260904 Red 隔离必须包在后台 job 内，否则后台任务会误跑进 parent instance。
        // 决策: docs/notes/implemented/bug-fix/2026-09-04-isolated-subagent-startup.md
        const childRun = isolated
          ? ops
              .runIsolated({ name: params.description }, runTask())
              .pipe(
                Effect.map(({ result, worktree }) => ({
                  result,
                  output: isolatedOutput(nextSession.id, result, worktree),
                  worktree,
                })),
              )
          : runTask().pipe(Effect.map((result) => ({ result, output: result })))
        const backgroundRun = runTracked(childRun).pipe(Effect.map(({ output }) => projectResult(output)))
        const info = yield* background.start({
          id: nextSession.id,
          type: id,
          title: params.description,
          metadata,
          run: backgroundRun.pipe(
            Effect.tap((text) => deliverResult("completed", text)),
            Effect.catchCause((cause) =>
              (Cause.hasInterruptsOnly(cause)
                ? persistResult({
                    status: "cancelled",
                    summary: "Explore child was cancelled before producing a final result.",
                    termination: "cancelled",
                  }).pipe(Effect.catch(() => Effect.void))
                : persistResult({
                    status: "failed",
                    summary: errorText(Cause.squash(cause)),
                    termination: "normal",
                  }).pipe(
                    Effect.andThen(deliverResult("error", projectResult(errorText(Cause.squash(cause))))),
                    Effect.catch(() => deliverResult("error", projectResult(errorText(Cause.squash(cause))))),
                  )
              ).pipe(Effect.andThen(Effect.failCause(cause))),
            ),
          ),
        })

        return {
          title: params.description,
          metadata: {
            ...metadata,
            jobId: info.id,
          },
          output: backgroundOutput(nextSession.id),
        }
      }

      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            if (isolated) {
              const childRun = ops
                .runIsolated({ name: params.description }, runTask())
                .pipe(
                  Effect.map(({ result, worktree }) => ({
                    result,
                    output: isolatedOutput(nextSession.id, result, worktree),
                    worktree,
                  })),
                )
              const { output: text, worktree } = yield* runTracked(childRun)
              if (!worktree) return yield* Effect.fail(new Error("Isolated child did not return its worktree"))
              return {
                title: params.description,
                metadata: {
                  ...metadata,
                  worktree: worktree.directory,
                  ...(worktree.branch ? { branch: worktree.branch } : {}),
                },
                output: projectResult(text),
              }
            }
            const { output: text } = yield* runTracked(runTask().pipe(Effect.map((result) => ({ result, output: result }))))
            return {
              title: params.description,
              metadata,
              output: output(nextSession.id, projectResult(text), next.name !== "explore"),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit)) {
              yield* cancel
              yield* persistResult({
                status: "cancelled",
                summary: "Explore child was cancelled before producing a final result.",
                termination: "cancelled",
              }).pipe(Effect.catch(() => Effect.void))
            }
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    return {
      description: flags.experimentalBackgroundSubagents ? DESCRIPTION + BACKGROUND_DESCRIPTION : DESCRIPTION,
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
