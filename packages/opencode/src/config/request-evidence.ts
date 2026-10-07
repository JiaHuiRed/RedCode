import { Schema } from "effect"

export * as ConfigRequestEvidence from "./request-evidence"

export const HARD_MAX_BODY_BYTES = 64 * 1024 * 1024

// 261007 Red 限制由配置拥有方解析；上限是诊断内存安全边界，不随模型窗口无限增长。
export const Info = Schema.Struct({
  maxBodyBytes: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: HARD_MAX_BODY_BYTES })),
  ).annotate({ description: "Maximum request body bytes hashed for diagnostics (default: 16777216; maximum: 67108864)." }),
  maxMessages: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16384 })),
  ).annotate({ description: "Maximum request messages or diagnostic section entries (default: 4096; maximum: 16384)." }),
  maxPendingCompressions: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 128 })),
  ).annotate({ description: "Maximum pending compression receipts per diagnostic bucket (default: 16; maximum: 128)." }),
})

export type Input = typeof Info.Type
export type Limits = Required<Input>

export function resolve(input?: Input): Limits {
  const value = Schema.decodeUnknownSync(Info)(input ?? {})
  return {
    maxBodyBytes: value.maxBodyBytes ?? 16 * 1024 * 1024,
    maxMessages: value.maxMessages ?? 4096,
    maxPendingCompressions: value.maxPendingCompressions ?? 16,
  }
}
