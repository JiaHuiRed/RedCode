import { InstanceState } from "@/effect/instance-state"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Effect, Latch, Layer, Scope, Context } from "effect"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
    onCancelled?: Effect.Effect<void>,
  ) => Effect.Effect<MessageV2.WithParts>
  readonly markStopped: (sessionID: SessionID) => Effect.Effect<void>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<MessageV2.WithParts, Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@redcode/SessionRunState") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, { runner: Runner.Runner<MessageV2.WithParts>; cancelled: boolean }>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            for (const frame of runners.values()) frame.cancelled = true
            yield* Effect.forEach(runners.values(), (frame) => frame.runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
          }),
        )
        return { runners, scope }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      const next = Runner.make<MessageV2.WithParts>(data.scope, {
        onIdle: Effect.gen(function* () {
          data.runners.delete(sessionID)
          yield* status.set(sessionID, { type: "idle" })
        }),
        onBusy: status.set(sessionID, { type: "busy" }),
        onInterrupt,
      })
      const frame = { runner: next, cancelled: false }
      data.runners.set(sessionID, frame)
      return frame
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.runner.busy) yield* busyError(sessionID)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.runner.busy) existing.cancelled = true
      yield* background.cancelTree(sessionID)
      if (!existing || !existing.runner.busy) {
        yield* status.set(sessionID, { type: "idle" })
        return
      }
      yield* existing.runner.cancel
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
      onCancelled?: Effect.Effect<void>,
    ) {
      const frame = yield* runner(sessionID, onInterrupt)
      const result = yield* frame.runner.ensureRunning(work)
      if (frame.cancelled && onCancelled) yield* onCancelled
      return result
    })

    const markStopped = Effect.fn("SessionRunState.markStopped")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const frame = data.runners.get(sessionID)
      if (frame?.runner.busy) frame.cancelled = true
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
      ready?: Latch.Latch,
    ) {
      const frame = yield* runner(sessionID, onInterrupt)
      return yield* frame.runner
        .startShell(work, ready)
        .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
    })

    return Service.of({ assertNotBusy, cancel, ensureRunning, markStopped, startShell })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
)

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export * as SessionRunState from "./run-state"
