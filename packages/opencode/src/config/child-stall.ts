import { Schema } from "effect"

export * as ConfigChildStall from "./child-stall"

// 261023 Red 子代理状态段超限警告。实测（261023）：execute 子代理的模型额度耗尽后，
// 网关错误被判可重试——无 retry-after 头时每次挂满首事件超时（75s）再退避重试，有头时
// 单次可放行 10 分钟（RETRY_MAX_DELAY），任务表 running 长达 27 分钟；期间 task_status
// 只回 "Task is still running."，主对话无从判断该不该取消。这里只管「警告」：
// 超长工具、长推理、权限等待也会触发，判断权留给主对话，绝不据此终止。
export const Info = Schema.Struct({
  warnMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 30_000, maximum: 3_600_000 })),
  ).annotate({
    description:
      "Warn (never abort) when a child task stays in the same busy/retry segment longer than this many milliseconds (default: 360000).",
  }),
})

export type Input = typeof Info.Type
export type Limits = Required<Input>

export function resolve(input?: Input): Limits {
  const value = Schema.decodeUnknownSync(Info)(input ?? {})
  return {
    warnMs: value.warnMs ?? 360_000,
  }
}
