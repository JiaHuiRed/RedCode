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
import { Cause, Clock, Effect, Exit, Option, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"

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

const id = "task"
const BACKGROUND_DESCRIPTION = [
  "",
  "",
  [
    "Background mode: background=true launches the subagent asynchronously and returns immediately instead of blocking.",
    "Without it, the ENTIRE session — including the user's ability to send new messages — is frozen until the subagent's",
    "full run finishes, even for a simple exploration task. Prefer background=true by default for any task whose result",
    "you don't need for your very next step: dispatching one chunk of a larger exploration/research job at a time across",
    "several turns, work the user didn't ask you to wait on, or anything where you or the user might want to keep talking",
    "while it runs. Only use the blocking (non-background) form when your next action genuinely depends on that specific",
    "result. Use task_status(task_id=..., wait=false) to poll, or wait=true to block until done, once you actually need it.",
  ].join(" "),
].join("\n")

const Isolation = Schema.optional(Schema.Literal("worktree")).annotate({
  description:
    'When set to "worktree", run the subagent in an isolated git worktree (separate working directory + branch) so its file edits do not touch the parent workspace. Use for risky or parallel changes.',
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

function output(sessionID: SessionID, text: string) {
  return [
    `task_id: ${sessionID} (for resuming to continue this task if needed)`,
    "",
    "<task_result>",
    text,
    "</task_result>",
  ].join("\n")
}

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
      const runInBackground = params.background === true
      if (runInBackground && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require REDCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }
      const isolated = params.isolation === "worktree"
      if (runInBackground && isolated) {
        return yield* Effect.fail(new Error("Background subagents cannot be combined with worktree isolation"))
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
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          permission: [
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
          ],
        }))

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
      const runCancel = yield* EffectBridge.make()

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        // 260818 Red 子代理超时兑底：agent 配置 timeout_ms + fallback_model 时，
        // 主模型跑超时 → cancel 当前子代理会话 → 换 fallback 模型在**同一会话**重跑。
        // 放在 runTask 内部 = background 与 foreground 分支共享同一行为。
        const runWithModel = Effect.fn("TaskTool.runWithModel")(function* (useModel: {
          modelID: ModelID
          providerID: ProviderID
        }) {
          const parts = yield* ops.resolvePromptParts(params.prompt)
          const result = yield* ops.prompt({
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
          })
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

        const timeoutMs = next.timeoutMs && next.timeoutMs > 0 ? Math.round(next.timeoutMs) : undefined
        const attempt = (useModel: { modelID: ModelID; providerID: ProviderID }) =>
          timeoutMs
            ? runWithModel(useModel).pipe(Effect.timeoutOption(`${timeoutMs} millis`))
            : runWithModel(useModel).pipe(Effect.map(Option.some))

        const first = yield* attempt(model)
        if (Option.isSome(first)) return first.value

        // 主模型超时：cancel 当前运行，避免残留的进行中请求继续占住会话
        yield* ops.cancel(nextSession.id).pipe(Effect.ignore)
        if (next.fallbackModel) {
          const fallback = yield* attempt(next.fallbackModel)
          if (Option.isSome(fallback)) return fallback.value
          return yield* Effect.fail(
            new Error(
              `Subagent timed out after ${timeoutMs}ms on both primary (${model.modelID}) and fallback (${next.fallbackModel.modelID})`,
            ),
          )
        }
        return yield* Effect.fail(new Error(`Subagent timed out after ${timeoutMs}ms (no fallback model configured)`))
      })

      // 260903 cc 等父会话空闲的上限。原来是无上限的 300ms 递归：会话若因别的原因永不 idle，
      // 它就永远等下去，而且**不留任何痕迹**——不超时、不报错、不记日志，与本仓冻结族
      // （docs/notes/.../2026-09-03-sse-abort-on-stream-end.md）同一种气味。
      // 超时**不丢结果**：inject() 已经先把合成结果落进会话了（noReply），这里等的只是
      // "自动替用户按下继续"这一步。所以超时的正确行为是放弃续跑 + 告诉用户结果已就绪，
      // 把静默挂起变成可见且可操作的状态。
      // 30 分钟：单轮跑这么久已属异常，而更短会误杀正当的长任务（本仓压缩阈值 400K，
      // 一轮几十次工具调用是常态）。
      // 用 Clock.currentTimeMillis 而不是 Date.now()：前者能被 TestClock 拨动，这个上限才写得了测试。
      // 「存在但没人验过的开关」在本仓有过前车（appProcess.run 的 timeout），与 background/job.ts 一致。
      const RESUME_IDLE_TIMEOUT_MS = 30 * 60_000
      type ResumeInput = { userID: MessageID; state: "completed" | "error"; deadline?: number }
      const resumeWhenIdle: (input: ResumeInput) => Effect.Effect<void> =
        Effect.fn("TaskTool.resumeWhenIdle")(function* (input: ResumeInput) {
          const deadline = input.deadline ?? (yield* Clock.currentTimeMillis) + RESUME_IDLE_TIMEOUT_MS
          const latest = yield* sessions
            .findMessage(ctx.sessionID, (item) => item.info.role === "user")
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
        })

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
                text,
              }),
            },
          ],
        })
        yield* continueIfIdle({ userID: message.info.id, state })
      })

      const existing = yield* background.get(nextSession.id)
      if (existing?.status === "running") {
        return yield* Effect.fail(
          new Error(`Task ${nextSession.id} is already running. Use task_status to check progress.`),
        )
      }

      if (runInBackground) {
        const info = yield* background.start({
          id: nextSession.id,
          type: id,
          title: params.description,
          metadata,
          run: runTask().pipe(
            Effect.tap((text) => inject("completed", text).pipe(Effect.ignore)),
            Effect.catchCause((cause) =>
              (Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : inject("error", errorText(Cause.squash(cause))).pipe(Effect.ignore)
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
              const { worktree, result: text } = yield* ops.runIsolated({ name: params.description }, runTask())
              return {
                title: params.description,
                metadata: {
                  ...metadata,
                  worktree: worktree.directory,
                  ...(worktree.branch ? { branch: worktree.branch } : {}),
                },
                output: isolatedOutput(nextSession.id, text, worktree),
              }
            }
            const text = yield* runTask()
            return {
              title: params.description,
              metadata,
              output: output(nextSession.id, text),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit)) yield* cancel
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
