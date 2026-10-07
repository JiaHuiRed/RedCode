// 260630 Red P1-b: 从 prompt.ts 提取的共享工具函数
import { Cause, Effect, Exit, Option } from "effect"
import { SessionID } from "../schema"
import { ModelID, ProviderID } from "../../provider/schema"
import { Provider } from "@/provider/provider"
import type { Bus } from "../../bus"
import * as Session from "../session"
import { NamedError } from "@redcode-ai/core/util/error"
import { eq } from "@/storage/db"
import * as Database from "@/storage/db"
import { SessionTable } from "../session.sql"

export function makeShared(deps: { provider: Provider.Interface; bus: Bus.Interface; sessions: Session.Interface }) {
  const { provider, bus, sessions } = deps

  const getModel = Effect.fn("SessionPrompt.getModel")(function* (
    providerID: ProviderID,
    modelID: ModelID,
    sessionID: SessionID,
  ) {
    const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
    if (Exit.isSuccess(exit)) return exit.value
    const err = Cause.squash(exit.cause)
    if (Provider.ModelNotFoundError.isInstance(err)) {
      const hint = err.suggestions?.length ? ` Did you mean: ${err.suggestions.join(", ")}?` : ""
      yield* bus.publish(Session.Event.Error, {
        sessionID,
        error: new NamedError.Unknown({
          message: `Model not found: ${err.providerID}/${err.modelID}.${hint}`,
        }).toObject(),
      })
    }
    return yield* Effect.die(err)
  })

  const currentModel = Effect.fnUntraced(function* (sessionID: SessionID) {
    const current = Database.use((db) =>
      db.select({ model: SessionTable.model }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get(),
    )
    if (current?.model) {
      return {
        providerID: ProviderID.make(current.model.providerID),
        modelID: ModelID.make(current.model.id),
        ...(current.model.variant && current.model.variant !== "default" ? { variant: current.model.variant } : {}),
      }
    }
    const match = yield* sessions
      .findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
      .pipe(Effect.orDie)
    if (Option.isSome(match) && match.value.info.role === "user") return match.value.info.model
    return yield* provider.defaultModel().pipe(Effect.orDie)
  })

  return { getModel, currentModel }
}
