import { Schema } from "effect"

export * as ConfigToolInputGuard from "./tool-input-guard"

// 261022 Red 参数输入与本地执行分开计账，决策：docs/notes/implemented/bug-fix/2026-10-22-tool-input-stream-guard.md
export const Info = Schema.Struct({
  maxPendingCalls: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4096 }))),
  idleMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 1_800_000 }))),
})

export type Input = typeof Info.Type
export type Limits = Required<Input>

export function resolve(input?: Input): Limits {
  const value = Schema.decodeUnknownSync(Info)(input ?? {})
  return {
    maxPendingCalls: value.maxPendingCalls ?? 64,
    idleMs: value.idleMs ?? 120_000,
  }
}
