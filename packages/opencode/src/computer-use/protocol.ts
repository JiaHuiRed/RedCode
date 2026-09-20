import { Schema } from "effect"
import { MessageV2 } from "@/session/message-v2"

export const Observation = Schema.Struct({
  id: Schema.String,
  timestamp: Schema.Number,
  focusedWindow: Schema.optional(Schema.String),
  screen: Schema.optional(Schema.String),
  width: Schema.Int,
  height: Schema.Int,
  screenshot: MessageV2.FilePart,
}).annotate({ identifier: "ComputerUseObservation" })
export type Observation = Schema.Schema.Type<typeof Observation>

export const ActionOutcome = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("confirmed"),
    observationInvalidated: Schema.Literal(true),
  }),
  Schema.Struct({
    status: Schema.Literal("not_sent"),
    observationInvalidated: Schema.Literal(false),
  }),
  Schema.Struct({
    status: Schema.Literal("rejected"),
    reason: Schema.String,
    observationInvalidated: Schema.Boolean,
  }),
  Schema.Struct({
    status: Schema.Literal("ambiguous"),
    observationInvalidated: Schema.Literal(true),
  }),
]).annotate({ identifier: "ComputerUseActionOutcome" })
export type ActionOutcome = Schema.Schema.Type<typeof ActionOutcome>

export const ObservationBarrierReason = Schema.Literals([
  "action",
  "ambiguous",
  "cancelled",
  "timeout",
  "reconnect",
  "driver_restart",
  "lease_reacquired",
  "stale_observation",
])
export type ObservationBarrierReason = Schema.Schema.Type<typeof ObservationBarrierReason>

export const ObservationBarrier = Schema.Struct({
  reason: ObservationBarrierReason,
}).annotate({ identifier: "ComputerUseObservationBarrier" })
export type ObservationBarrier = Schema.Schema.Type<typeof ObservationBarrier>

export function createObservationBarrier(reason: ObservationBarrierReason): ObservationBarrier {
  return { reason }
}

export function canMutate(input: {
  observation: Pick<Observation, "id" | "focusedWindow" | "screen"> | undefined
  expectedObservationId: string
  focusedWindow?: string
  screen?: string
  barrier?: ObservationBarrier
}): boolean {
  if (input.barrier !== undefined || input.observation?.id !== input.expectedObservationId) return false
  if (input.observation.focusedWindow !== undefined && input.observation.focusedWindow !== input.focusedWindow) {
    return false
  }
  return input.observation.screen === undefined || input.observation.screen === input.screen
}

export * as ComputerUseProtocol from "./protocol"
