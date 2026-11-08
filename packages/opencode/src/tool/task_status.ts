import * as Tool from "./tool"
import DESCRIPTION from "./task_status.md" with { type: "text" }
import { BackgroundCancel } from "@/background/cancel"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { RETRY_MAX_ATTEMPTS } from "@/session/retry"
import { ConfigChildStall } from "@/config/child-stall"
import { Config } from "@/config/config"
import { PositiveInt } from "@redcode-ai/core/schema"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Clock, Effect, Exit, Option, Schema } from "effect"
import { steerTask } from "./task"

const DEFAULT_TIMEOUT = 60_000
const POLL_MS = 300

const Parameters = Schema.Struct({
  task_id: SessionID.annotate({ description: "The task_id returned by the task tool" }),
  wait: Schema.optional(Schema.Boolean).annotate({
    description: "When true, wait until the task reaches a terminal state or timeout",
  }),
  timeout_ms: Schema.optional(PositiveInt).annotate({
    description: "Maximum milliseconds to wait when wait=true (default: 60000)",
  }),
  // 260918 Red 后台 task 需要按 parentSessionId 级联取消，不能只停止状态轮询；
  // 决策: docs/notes/implemented/bug-fix/2026-09-18-background-task-cancellation-and-worktree-cleanup.md
  cancel: Schema.optional(Schema.Boolean).annotate({
    description: "When true, cancel the task and its nested background tasks before checking status",
  }),
  // 261014 Red 单条控制输入的安全上限，不裁剪用户原文。
  message: Schema.optional(Schema.String).annotate({
    description: "Send plain-text guidance to your running child task without interrupting it. Cannot combine with wait, timeout_ms, or cancel. Maximum 16384 UTF-8 bytes.",
  }),
})

type State = BackgroundJob.Status
type InspectResult = { state: State; text: string }
type StatusMetadata = {
  task_id: SessionID
  state: State
  timed_out: boolean
  message_id?: MessageID
  delivery?: "queued" | "delivered"
}

function format(input: { taskID: SessionID; state: State; text: string }) {
  const tag = input.state === "completed" || input.state === "running" ? "task_result" : "task_error"
  return [`task_id: ${input.taskID}`, `state: ${input.state}`, "", `<${tag}>`, input.text, `</${tag}>`].join("\n")
}

function errorText(error: NonNullable<MessageV2.Assistant["error"]>) {
  const data = Reflect.get(error, "data")
  const message = data && typeof data === "object" ? Reflect.get(data, "message") : undefined
  if (typeof message === "string" && message) return message
  return error.name
}

// 261023 Red 子代理状态段超限警告：同一 busy/retry 段停留超过 warnMs 就在输出里附加
// 提醒，绝不据此终止——超长工具、长推理、权限等待也会触发，判断权留给主对话。
// 实测背景（261023）：模型额度耗尽后重试循环让任务 running 长达 27 分钟，
// 主线只会看到 "Task is still running."。导出为纯函数供测试直调。
export function stallWarning(
  status: { type: "busy" | "retry"; since?: number },
  now: number,
  warnMs: number,
): string | undefined {
  if (status.since === undefined) return undefined
  const held = now - status.since
  if (held < warnMs) return undefined
  const minutes = Math.max(1, Math.round(held / 60_000))
  return (
    `Warning: this task has been in "${status.type}" for ~${minutes} min without reaching a terminal state. ` +
    `Long tool calls or extended reasoning can look like this; if the child model may be stuck (quota or rate limit), ` +
    `consider task_status with cancel: true.`
  )
}

function inspectMessage(message: MessageV2.WithParts): InspectResult | undefined {
  if (message.info.role !== "assistant") return
  const text = message.parts.findLast((part) => part.type === "text")?.text ?? ""
  if (message.info.error) return { state: "error", text: text || errorText(message.info.error) }
  if (message.info.finish && !["tool-calls", "unknown"].includes(message.info.finish))
    return { state: "completed", text }
  return { state: "running", text: text || "Task is still running." }
}

export const TaskStatusTool = Tool.define(
  "task_status",
  Effect.gen(function* () {
    const jobs = yield* BackgroundJob.Service
    const canceller = yield* BackgroundCancel.Service
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service
    const flags = yield* RuntimeFlags.Service

    // 261104 Red 落盘快照不含 output（子代理全文可达数 MB），重启恢复的 completed 任务
    // 本身没有输出文本。结果仍在子会话里，按最新 assistant 消息补回来，避免返回空文本。
    const jobText = Effect.fn("TaskStatusTool.jobText")(function* (taskID: SessionID, job: BackgroundJob.Info) {
      if (job.output) return job.output
      if (job.error) return job.error
      if (job.status === "running") return "Task is still running."
      if (job.status === "cancelled") return "Task was cancelled."
      if (job.status !== "completed") return ""
      const latest = yield* sessions
        .findMessage(taskID, (item) => item.info.role === "assistant")
        .pipe(Effect.orDie)
      if (Option.isNone(latest)) return ""
      const message = inspectMessage(latest.value)
      return message?.state === "completed" ? message.text : ""
    })

    const inspect: (taskID: SessionID, warnMs: number) => Effect.Effect<InspectResult> = Effect.fn(
      "TaskStatusTool.inspect",
    )(function* (taskID: SessionID, warnMs: number) {
      const job = yield* jobs.get(taskID)
      if (job) {
        let text = yield* jobText(taskID, job)
        if (job.status === "running") {
          const current = yield* status.get(taskID)
          if (current.type === "busy" || current.type === "retry") {
            const warning = stallWarning(current, yield* Clock.currentTimeMillis, warnMs)
            if (warning) text = `${text}\n\n${warning}`
          }
        }
        return { state: job.status, text }
      }

      const current = yield* status.get(taskID)
      if (current.type === "busy" || current.type === "retry") {
        let text =
          current.type === "retry"
            ? `Task is retrying (attempt ${current.attempt}/${RETRY_MAX_ATTEMPTS}): ${current.message}`
            : "Task is still running."
        const warning = stallWarning(current, yield* Clock.currentTimeMillis, warnMs)
        if (warning) text += `\n\n${warning}`
        return { state: "running", text }
      }

      const latestAssistant = yield* sessions
        .findMessage(taskID, (item) => item.info.role === "assistant")
        .pipe(Effect.orDie)
      if (Option.isSome(latestAssistant)) {
        const latest = inspectMessage(latestAssistant.value)
        if (!latest) return { state: "error", text: "Task is not running in this process." }
        if (latest.state === "running")
          return { state: "error", text: "Task is not running in this process and has no final output." }
        return latest
      }
      return { state: "error", text: "Task is not running in this process and has not produced output." }
    })

    const waitForTerminal: (
      taskID: SessionID,
      timeout: number,
      warnMs: number,
    ) => Effect.Effect<{ result: InspectResult; timedOut: boolean }> = Effect.fn("TaskStatusTool.waitForTerminal")(
      function* (taskID: SessionID, timeout: number, warnMs: number) {
        const result = yield* inspect(taskID, warnMs)
        if (result.state !== "running") return { result, timedOut: false }
        if (timeout <= 0) return { result, timedOut: true }
        const sleep = Math.min(POLL_MS, timeout)
        yield* Effect.sleep(`${sleep} millis`)
        return yield* waitForTerminal(taskID, timeout - sleep, warnMs)
      },
    )

    const run = Effect.fn("TaskStatusTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (!flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(new Error("task_status requires REDCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"))
      }

      // 261023 Red 每次调用读取阈值（与 processor 读 reasoningStall 同惯例）：配置可运行期变更，
      // 解析含范围校验（30s–1h），默认 6 分钟。
      const config = yield* Config.Service
      const warnMs = ConfigChildStall.resolve((yield* config.get()).experimental?.childStall).warnMs

      if (params.message !== undefined) {
        const messageText = params.message
        if (params.wait || params.cancel || params.timeout_ms !== undefined)
          return yield* Effect.fail(new Error(
            'Steering cannot be combined with wait, timeout_ms, or cancel. ' +
            'To inspect status, omit message entirely: {"task_id":"<task_id>","wait":false}. ' +
            'To send guidance, omit wait, timeout_ms, and cancel: {"task_id":"<task_id>","message":"<guidance>"}. ' +
            'An empty message is not an omitted field.',
          ))
        if (!params.message.trim() || Buffer.byteLength(params.message, "utf8") > 16_384)
          return yield* Effect.fail(new Error("Steering message must be nonblank and at most 16384 UTF-8 bytes"))
        const child = yield* sessions.get(params.task_id)
        if (child.parentID !== ctx.sessionID || child.id === ctx.sessionID)
          return yield* Effect.fail(new Error("Only the task's direct parent session may steer it"))
        const job = yield* jobs.get(params.task_id)
        if (job?.type !== "task" || job.status !== "running")
          return yield* Effect.fail(new Error("Only a running child task can be steered"))
        const sent = yield* Effect.try({
          try: () => steerTask(params.task_id, ctx.sessionID, messageText, ctx.callID),
          catch: (error) => error instanceof Error ? error : new Error("Task steering failed"),
        })
        const deadline = (yield* Clock.currentTimeMillis) + DEFAULT_TIMEOUT
        // 261014 Red 回执以持久化消息为准；不等待模型完成，也不将排队谎报为已消费。
        while (true) {
          const message = yield* MessageV2.get({ sessionID: params.task_id, messageID: sent.messageID })
            .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)))
          if (message?.info.role === "user") {
            const delivery = message.info.delivery === "delivered" ? "delivered" : "queued"
            const metadata: StatusMetadata = {
              task_id: params.task_id, state: "running", timed_out: false, message_id: sent.messageID, delivery,
            }
            return {
              title: "Task steering",
              metadata,
              output: `task_id: ${params.task_id}\nmessage_id: ${sent.messageID}\ndelivery: ${delivery}`,
            }
          }
          const exit = sent.fiber.pollUnsafe()
          if (exit && Exit.isFailure(exit))
            return yield* Effect.fail(new Error("Task steering failed before the message was persisted"))
          if ((yield* Clock.currentTimeMillis) >= deadline)
            return yield* Effect.fail(new Error("Timed out waiting for task steering persistence"))
          yield* Effect.sleep(`${POLL_MS} millis`)
        }
      }

      const session = yield* sessions.get(params.task_id).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      if (!session) {
        return {
          title: "Task status",
          metadata: {
            task_id: params.task_id,
            state: "error" as const,
            timed_out: false,
          },
          output: format({
            taskID: params.task_id,
            state: "error",
            text: `Task not found: ${params.task_id}`,
          }),
        }
      }

      if (params.cancel) {
        // 261105 Red 取消后 SessionStatus 归位下沉到 BackgroundCancel，与 HTTP 后台面板同一条路径。
        yield* canceller.cancelTree(params.task_id)
      }

      const waited =
        params.wait === true
          ? yield* jobs.wait({ id: params.task_id, timeout: params.timeout_ms ?? DEFAULT_TIMEOUT })
          : { info: yield* jobs.get(params.task_id), timedOut: false }
      const info = waited.info
      // 261108 Red 审计 RC-P2-03：此前只要 jobs.get 拿得到 info 就直接用 jobText，
      // 把 inspect 里的重试/停滞诊断整段绕过去了 —— 后台任务跑 27 分钟也只回一句
      // "Task is still running."。非 wait 分支统一走 inspect：它自己会取 job，并在
      // busy/retry 时补 stallWarning；wait 分支已在等终态，不需要再判停滞。
      const inspected =
        params.wait === true
          ? info
            ? {
                result: {
                  state: info.status,
                  text: yield* jobText(params.task_id, info),
                },
                timedOut: waited.timedOut,
              }
            : yield* waitForTerminal(params.task_id, params.timeout_ms ?? DEFAULT_TIMEOUT, warnMs)
          : { result: yield* inspect(params.task_id, warnMs), timedOut: false }
      const text = inspected.timedOut
        ? `Timed out after ${params.timeout_ms ?? DEFAULT_TIMEOUT}ms while waiting for task completion.`
        : inspected.result.text

      return {
        title: "Task status",
        metadata: {
          task_id: params.task_id,
          state: inspected.result.state,
          timed_out: inspected.timedOut,
        },
        output: format({
          taskID: params.task_id,
          state: inspected.result.state,
          text,
        }),
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context): Effect.Effect<{
        title: string; metadata: StatusMetadata; output: string
      }> =>
        // Config 依赖在此收口：registry 为工具提供 Config.defaultLayer，这里的 provide 让
        // execute 的 R 归零（memoMap 缓存 layer，不重复构建）。
        run(params, ctx).pipe(Effect.provide(Config.defaultLayer), Effect.orDie),
    }
  }),
)
