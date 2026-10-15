import { Schema } from "effect"

export const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })).annotate({
  description: "Identical tool failures before one final correction opportunity (default: 2; maximum: 20).",
})

export function resolve(input?: number): number {
  return Schema.decodeUnknownSync(Limit)(input ?? 2)
}
