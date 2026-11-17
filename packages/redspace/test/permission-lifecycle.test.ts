import { expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Option } from "effect"
import { Bus } from "../src/bus"
import { Permission } from "../src/permission"
import { PermissionID } from "../src/permission/schema"
import { SessionID } from "../src/session/schema"
import { testEffect } from "./lib/effect"

let asked!: Deferred.Deferred<void, never>
let replied!: Deferred.Deferred<void, never>
let releaseReply!: Deferred.Deferred<void, never>

const bus = Layer.effect(
  Bus.Service,
  Effect.gen(function* () {
    asked = yield* Deferred.make<void>()
    replied = yield* Deferred.make<void>()
    releaseReply = yield* Deferred.make<void>()
    return Bus.Service.of({
      publish: (def) => {
        if (def.type === Permission.Event.Asked.type) return Deferred.succeed(asked, undefined)
        if (def.type === Permission.Event.Replied.type) {
          return Effect.gen(function* () {
            yield* Deferred.succeed(replied, undefined)
            yield* Deferred.await(releaseReply)
          })
        }
        return Effect.void
      },
      subscribe: () => Effect.die("unused"),
      subscribeAll: () => Effect.die("unused"),
      subscribeCallback: () => Effect.die("unused"),
      subscribeAllCallback: () => Effect.die("unused"),
    })
  }),
)

const it = testEffect(Permission.layer.pipe(Layer.provide(bus)))

it.instance("completes the requester before publishing the terminal event", () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const requestID = PermissionID.ascending()
    const requester = yield* permission
      .ask({
        id: requestID,
        sessionID: SessionID.descending(),
        permission: "bash",
        patterns: ["*"],
        metadata: {},
        always: [],
        ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
      })
      .pipe(Effect.forkChild)

    yield* Deferred.await(asked)
    const reply = yield* permission.reply({ requestID, reply: "once" }).pipe(Effect.forkChild)
    yield* Deferred.await(replied)

    const requesterCompleted = yield* Effect.exit(Fiber.join(requester)).pipe(Effect.timeoutOption("100 millis"))
    yield* Deferred.succeed(releaseReply, undefined)
    yield* Fiber.join(reply)

    expect(Option.isSome(requesterCompleted)).toBe(true)
    if (Option.isNone(requesterCompleted)) return
    expect(Exit.isSuccess(requesterCompleted.value)).toBe(true)
    yield* Fiber.interrupt(requester)
  }),
)
