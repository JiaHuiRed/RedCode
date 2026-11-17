import type { WorkspaceID } from "@/control-plane/schema"
import { Flag } from "@redcode-ai/core/flag/flag"
import { Effect, Scope } from "effect"

/**
 * Scoped override for `Flag.REDCODE_WORKSPACE_ID`. Saves the previous value
 * on entry and restores it via finalizer when the surrounding scope closes —
 * preserves the original try/finally semantics regardless of test outcome.
 */
export function withFixedWorkspaceID(id: WorkspaceID): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const previous = Flag.REDCODE_WORKSPACE_ID
    Flag.REDCODE_WORKSPACE_ID = id
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        Flag.REDCODE_WORKSPACE_ID = previous
      }),
    )
  })
}
