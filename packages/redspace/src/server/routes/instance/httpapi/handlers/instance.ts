import { Agent } from "@/agent/agent"
import { Command } from "@/command"
import { resolveTemplate } from "@/command/template"
import * as InstanceState from "@/effect/instance-state"
import { Format } from "@/format"
import { Global } from "@redcode-ai/core/global"
import { Instruction } from "@/session/instruction"
import { LSP } from "@/lsp/lsp"
import { Vcs } from "@/project/vcs"
import { Skill } from "@/skill"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/http-api"
import { InstanceHttpApi } from "../api"
import { ApiVcsApplyError } from "../groups/instance"
import { markInstanceForDisposal } from "../lifecycle"

export const instanceHandlers = HttpApiBuilder.group(InstanceHttpApi, "instance", (handlers) =>
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const command = yield* Command.Service
    const format = yield* Format.Service
    const instruction = yield* Instruction.Service
    const lsp = yield* LSP.Service
    const skill = yield* Skill.Service
    const vcs = yield* Vcs.Service

    const dispose = Effect.fn("InstanceHttpApi.dispose")(function* () {
      yield* markInstanceForDisposal(yield* InstanceState.context)
      return true
    })

    const getPath = Effect.fn("InstanceHttpApi.path")(function* () {
      const ctx = yield* InstanceState.context
      return {
        home: Global.Path.home,
        state: Global.Path.state,
        config: Global.Path.config,
        worktree: ctx.worktree,
        directory: ctx.directory,
      }
    })

    const getVcs = Effect.fn("InstanceHttpApi.vcs")(function* () {
      const [branch, default_branch] = yield* Effect.all([vcs.branch(), vcs.defaultBranch()], {
        concurrency: "unbounded",
      })
      return { branch, default_branch }
    })

    const getVcsStatus = Effect.fn("InstanceHttpApi.vcsStatus")(function* () {
      return yield* vcs.status()
    })

    const getVcsDiff = Effect.fn("InstanceHttpApi.vcsDiff")(function* (ctx: { query: { mode: Vcs.Mode } }) {
      return yield* vcs.diff(ctx.query.mode)
    })

    const getVcsDiffRaw = Effect.fn("InstanceHttpApi.vcsDiffRaw")(function* () {
      return yield* vcs.diffRaw()
    })

    const applyVcs = Effect.fn("InstanceHttpApi.vcsApply")(function* (ctx: { payload: Vcs.ApplyInput }) {
      return yield* vcs.apply(ctx.payload).pipe(
        Effect.mapError(
          (error) =>
            new ApiVcsApplyError({
              name: "VcsApplyError",
              data: {
                message: error.message,
                reason: error.reason,
              },
            }),
        ),
      )
    })

    const getCommand = Effect.fn("InstanceHttpApi.command")(function* () {
      const list = yield* command.list()
      // 261024 Red MCP prompt 命令的 template 是懒 Promise，响应体 JSON 校验会把它拒成
      // "Expected JSON value at [14][\"template\"]"，/command 整条 400 → GUI 每个项目
      // bootstrap 都弹「无法重新加载」。在边界落地成字符串（预算+兜底见 @/command/template）；
      // 提交路径 session/prompt.ts 仍直接 await 原始 Promise，不受影响。
      return yield* Effect.all(
        list.map((cmd) =>
          Effect.promise(async () => ({ ...cmd, template: await resolveTemplate(cmd.template) })),
        ),
      )
    })

    const getAgent = Effect.fn("InstanceHttpApi.agent")(function* () {
      return yield* agent.list()
    })

    const getSkill = Effect.fn("InstanceHttpApi.skill")(function* () {
      return yield* skill.all()
    })

    const getInstructions = Effect.fn("InstanceHttpApi.instructions")(function* () {
      // fs 错误（指令文件读挂）映射 500：注入清单是只读观测面，不另立错误 schema。
      return yield* instruction.describe().pipe(
        Effect.catch(() => Effect.fail(new HttpApiError.InternalServerError({}))),
      )
    })

    const getLsp = Effect.fn("InstanceHttpApi.lsp")(function* () {
      return yield* lsp.status()
    })

    const getFormatter = Effect.fn("InstanceHttpApi.formatter")(function* () {
      return yield* format.status()
    })

    return handlers
      .handle("dispose", dispose)
      .handle("path", getPath)
      .handle("vcs", getVcs)
      .handle("vcsStatus", getVcsStatus)
      .handle("vcsDiff", getVcsDiff)
      .handle("vcsDiffRaw", getVcsDiffRaw)
      .handle("vcsApply", applyVcs)
      .handle("command", getCommand)
      .handle("agent", getAgent)
      .handle("skill", getSkill)
      .handle("instructions", getInstructions)
      .handle("lsp", getLsp)
      .handle("formatter", getFormatter)
  }),
)
