import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import type { Goal as GoalSvc } from "../session/goal"

// 260801 Red Goal 工具：/goal 从纯 prompt 指令升级为落库状态。
// 模型调用 goal_set 钉目标、goal_done 自证完成、goal_clear 清掉。
// 服务经 ctx.extra.goal 注入（同 promptOps 模式），避免把 Goal.Service
// 拉进工具注册层的依赖链（测试环境的 Layer 类型会因此报错）。

function goalFromCtx(ctx: Tool.Context): GoalSvc.Interface | undefined {
  return ctx.extra?.goal as GoalSvc.Interface | undefined
}

export const GoalSetTool = Tool.define<typeof SetParams, SetMetadata, never>(
  "goal_set",
  Effect.gen(function* () {
    return {
      description:
        "Pin the active session goal. Use this when the user types /goal <text> or asks to pin an objective — the goal is persisted and injected into the system prompt every turn until cleared or marked done. Sub-tasks become todos; check them off as you complete them.",
      parameters: SetParams,
      execute: (params: Schema.Schema.Type<typeof SetParams>, ctx: Tool.Context<SetMetadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "goal",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          const goal = goalFromCtx(ctx)
          if (!goal)
            return yield* Effect.sync(() => {
              throw new Error("Goal tool requires goal service in ctx.extra")
            })
          yield* goal.set({ sessionID: ctx.sessionID, text: params.text })

          return {
            title: "Goal pinned",
            output: `Goal pinned: ${params.text}`,
            metadata: { text: params.text },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof SetParams, SetMetadata>
  }),
)

export const GoalDoneTool = Tool.define<typeof DoneParams, DoneMetadata, never>(
  "goal_done",
  Effect.gen(function* () {
    return {
      description:
        "Mark the current session goal as completed. Use this when the pinned goal has been fully achieved — evidence in the conversation must cover the goal. Marking done stops automatic goal continuation.",
      parameters: DoneParams,
      execute: (_params: Schema.Schema.Type<typeof DoneParams>, ctx: Tool.Context<DoneMetadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "goal",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          const goal = goalFromCtx(ctx)
          if (!goal)
            return yield* Effect.sync(() => {
              throw new Error("Goal tool requires goal service in ctx.extra")
            })
          const current = yield* goal.get(ctx.sessionID)
          if (!current) {
            return { title: "No goal", output: "No active goal to mark done.", metadata: {} }
          }
          yield* goal.done(ctx.sessionID)
          return {
            title: "Goal done",
            output: `Goal completed: ${current.text}`,
            metadata: { text: current.text },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof DoneParams, DoneMetadata>
  }),
)

export const GoalClearTool = Tool.define<typeof ClearParams, ClearMetadata, never>(
  "goal_clear",
  Effect.gen(function* () {
    return {
      description:
        "Clear the current session goal without marking it done. Use this when the user types /goal clear or says the goal is no longer relevant.",
      parameters: ClearParams,
      execute: (_params: Schema.Schema.Type<typeof ClearParams>, ctx: Tool.Context<ClearMetadata>) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "goal",
            patterns: ["*"],
            always: ["*"],
            metadata: {},
          })

          const goal = goalFromCtx(ctx)
          if (!goal)
            return yield* Effect.sync(() => {
              throw new Error("Goal tool requires goal service in ctx.extra")
            })
          yield* goal.clear(ctx.sessionID)
          return {
            title: "Goal cleared",
            output: "Goal cleared.",
            metadata: {},
          }
        }),
    } satisfies Tool.DefWithoutID<typeof ClearParams, ClearMetadata>
  }),
)

const SetParams = Schema.Struct({
  text: Schema.String.annotate({ description: "The goal text to pin, e.g. '完成 GUI 三栏宽度 bug 修复'" }),
})

type SetMetadata = {
  text: string
}

const DoneParams = Schema.Struct({})

type DoneMetadata = {
  text?: string
}

const ClearParams = Schema.Struct({})

type ClearMetadata = Record<string, never>
