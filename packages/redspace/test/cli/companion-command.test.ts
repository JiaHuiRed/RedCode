import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { cliIt } from "../lib/cli-process"

describe("companion CLI entry points", () => {
  cliIt.live("creates a native companion and reuses it for request retries and init", ({ redcode }) =>
    Effect.gen(function* () {
      const first = yield* redcode.spawn(["companion", "create", "--request-id", "first-chat", "--json"], {
        timeoutMs: 10_000,
      })
      redcode.expectExit(first, 0)
      const created = JSON.parse(first.stdout)
      expect(created.created).toBe(true)
      expect(created.profile.introduction).toBe("available")

      const retry = yield* redcode.spawn(["companion", "create", "--request-id", "first-chat", "--json"], {
        timeoutMs: 10_000,
      })
      redcode.expectExit(retry, 0)
      expect(JSON.parse(retry.stdout)).toMatchObject({ created: false, profile: { id: created.profile.id } })

      const initialized = yield* redcode.spawn(["companion", "init", "--json"], { timeoutMs: 10_000 })
      redcode.expectExit(initialized, 0)
      expect(JSON.parse(initialized.stdout)).toMatchObject({ created: false, profile: { id: created.profile.id } })

      const listed = yield* redcode.spawn(["companion", "list", "--json"], { timeoutMs: 10_000 })
      redcode.expectExit(listed, 0)
      expect(JSON.parse(listed.stdout).map((profile: { id: string }) => profile.id)).toEqual([created.profile.id])
    }),
  )
})
