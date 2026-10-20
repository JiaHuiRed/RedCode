import { Schema } from "effect"

export * as ConfigReasoningStall from "./reasoning-stall"

// 261020 Red 纯思考兜底改由配置拥有方解析。原来的判据是硬编码 30,000 字符，在 max 推理
// 档上把正常的长思考当成了卡死（261007–261020 实测 53 次，正文分片精确停在 30,00x 字符）。
// 主判据改为「静默时长」：供应商不再吐新分片才算卡死；字符量退居防无限流的高额兜底。
export const Info = Schema.Struct({
  idleMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 1_800_000 }))).annotate({
    description:
      "Silence (ms) with no provider event before a reasoning-only turn is treated as stalled (default: 300000). Very low values cut normal long thinking.",
  }),
  maxChars: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 10_000, maximum: 2_000_000 }))).annotate({
    description:
      "Backstop on reasoning characters accumulated in one step, for providers that stream forever (default: 200000).",
  }),
})

export type Input = typeof Info.Type
export type Limits = Required<Input>

export function resolve(input?: Input): Limits {
  const value = Schema.decodeUnknownSync(Info)(input ?? {})
  return {
    idleMs: value.idleMs ?? 300_000,
    maxChars: value.maxChars ?? 200_000,
  }
}
