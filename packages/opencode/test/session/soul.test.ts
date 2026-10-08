import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { Info } from "../../src/soul/schema"
import { PromptCaches } from "../../src/session/prompt-caches"
import { render, sessionSoul, sessionTitlePrefix } from "../../src/session/soul"
import type { Interface as SoulService } from "../../src/soul"
import { testEffect } from "../lib/effect"
import { Session as SessionNs } from "@/session/session"
import { Soul } from "@/soul"
import { BackgroundJob } from "@/background/job"
import { Bus } from "@/bus"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { TestInstance } from "../fixture/fixture"
import { Database, eq } from "@/storage/db"
import { SessionTable, SoulVersionTable } from "@/session/session.sql"
import path from "node:path"

const info = (overrides: Partial<Info> = {}): Info => ({
  id: "karina",
  name: "Karina",
  displayName: "敏敏",
  commitPrefix: "Karina",
  path: "/souls/karina.md",
  content: "Voice body",
  ...overrides,
})

const it = testEffect(
  Layer.mergeAll(
    Soul.defaultLayer,
    SessionNs.layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(Storage.defaultLayer),
      Layer.provide(SyncEvent.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
    ),
  ),
)

function service(initial?: Info) {
  let current = initial
  let defaultID = "karina"
  const souls: SoulService = {
    list: () => Effect.succeed([]),
    issues: () => Effect.succeed([]),
    details: () => Effect.die(new Error("Session tests must not read GUI Soul details")),
    defaultForClient: () => Effect.succeed(defaultID),
    get: (id) => {
      return Effect.succeed(id === current?.id ? current : undefined)
    },
  }
  return {
    souls,
    set: (value: Info | undefined) => (current = value),
    setDefault: (value: string) => (defaultID = value),
  }
}

describe("session.soul", () => {
  afterEach(() => {
    for (const sessionID of [
      "title-session",
      "soul-session",
      "deleted-session",
      "missing-session",
      "unknown-session",
      "plain-session",
      "oversized-session",
      "parent-session",
      "child-session",
    ]) {
      PromptCaches.souls.delete(sessionID)
    }
  })

  test("renders identity and commit attribution from Soul metadata", async () => {
    const rendered = render(info())
    expect(rendered.displayName).toBe("敏敏")
    expect(rendered.commitPrefix).toBe("Karina")
    expect(rendered.prompt).toContain("# 敏敏 [Karina]")
    expect(rendered.prompt).toContain("Identity: 敏敏. Commit attribution owner: [Karina].")
    expect(await Effect.runPromise(sessionTitlePrefix("title-session", "karina", service(info()).souls))).toBe("敏敏")
  })

  test("falls back commit prefix through displayName, name, then AI", () => {
    expect(render(info({ commitPrefix: "", displayName: "Shown" })).commitPrefix).toBe("Shown")
    expect(render(info({ commitPrefix: "", displayName: "" })).commitPrefix).toBe("Karina")
    expect(render(info({ commitPrefix: "", displayName: "", name: "" })).commitPrefix).toBe("AI")
  })

  test("caps metadata labels so the wrapper stays bounded", () => {
    const rendered = render(info({ displayName: "名".repeat(300), commitPrefix: "前".repeat(300) }))
    expect(Buffer.byteLength(rendered.displayName, "utf8")).toBeLessThanOrEqual(256)
    expect(Buffer.byteLength(rendered.commitPrefix, "utf8")).toBeLessThanOrEqual(256)
  })

  test("pins Soul content per session across edits, defaults, and model switches", async () => {
    const registry = service(info())
    const first = await Effect.runPromise(sessionSoul("soul-session", "karina", registry.souls))
    registry.set(info({ displayName: "Edited name", content: "edited body" }))
    registry.setDefault("yuqi")
    expect(await Effect.runPromise(registry.souls.defaultForClient("tui"))).toBe("yuqi")
    const otherModel = await Effect.runPromise(sessionSoul("soul-session", "karina", registry.souls))
    expect(otherModel).toBe(first)
    expect(otherModel.prompt).toContain("Voice body")
    expect(otherModel.prompt).not.toContain("edited body")
    expect(otherModel.id).toBe("karina")
    expect(await Effect.runPromise(sessionTitlePrefix("soul-session", "karina", registry.souls))).toBe("敏敏")
  })

  test("missing pinned files retain the cached body and never select another Soul", async () => {
    const registry = service(info())
    const original = await Effect.runPromise(sessionSoul("deleted-session", "karina", registry.souls))
    registry.set(undefined)
    const stillPinned = await Effect.runPromise(sessionSoul("deleted-session", "yuqi", registry.souls))
    expect(stillPinned).toBe(original)
    expect(stillPinned.prompt).toContain("Voice body")
    expect(stillPinned.id).toBe("karina")
  })

  test("missing and unknown pinned Soul use a minimal no-soul snapshot", async () => {
    const registry = service()
    const missing = await Effect.runPromise(sessionSoul("missing-session", "deleted", registry.souls))
    const unknown = await Effect.runPromise(sessionSoul("unknown-session", "not-in-registry", registry.souls))
    const none = await Effect.runPromise(sessionSoul("plain-session", undefined, registry.souls))
    expect(missing.prompt).toContain('pinned Soul "deleted" is unavailable')
    expect(unknown.prompt).toContain("do not infer identity from client")
    expect(none.prompt).toContain("No Soul is bound")
    expect(none.id).toBe("")
  })

  test("oversized Soul is rejected without exposing its body", async () => {
    const registry = service(info({ content: "x".repeat(16 * 1024 + 1) }))
    const snapshot = await Effect.runPromise(sessionSoul("oversized-session", "karina", registry.souls))
    expect(snapshot.prompt).toContain("is unavailable")
    expect(snapshot.prompt).not.toContain("x".repeat(100))
  })

  test("child session can pin inherited attribution independently", async () => {
    const registry = service(info())
    const parent = await Effect.runPromise(sessionSoul("parent-session", "karina", registry.souls))
    const child = await Effect.runPromise(sessionSoul("child-session", parent.id, registry.souls))
    expect(child.prompt).toBe(parent.prompt)
    expect(child).not.toBe(parent)
  })

  it.instance("freezes Soul before session publication and restores the frozen body after restart", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "karina.md")
      yield* Effect.promise(() =>
        Bun.write(file, "---\nid: karina\nname: V1\ndisplay_name: Name V1\ncommit_prefix: CommitV1\n---\n\nOriginal body V1"),
      )
      const service = yield* SessionNs.Service
      const parent = yield* service.create({ soul: "karina" }).pipe(Effect.provideService(Soul.directory, test.directory))
      const stored = Database.use((db) => db.select().from(SoulVersionTable).get())
      expect(parent.soulBodyHash).toBeTruthy()
      expect(stored?.body).toContain("Original body V1")

      yield* Effect.promise(() =>
        Bun.write(file, "---\nid: karina\nname: V2\ndisplay_name: Name V2\ncommit_prefix: CommitV2\n---\n\nOriginal body V2"),
      )
      PromptCaches.souls.delete(parent.id)
      const souls = yield* Soul.Service
      const restored = yield* sessionSoul(parent.id, parent.soul, souls).pipe(
        Effect.provideService(Soul.directory, test.directory),
      )
      expect(restored.prompt).toContain("# Name V1 [CommitV1]")
      expect(restored.prompt).toContain("Original body V1")
      expect(restored.prompt).not.toContain("Original body V2")
      PromptCaches.souls.delete(parent.id)
      const withoutHint = yield* sessionSoul(parent.id, undefined, souls)
      expect(withoutHint.prompt).toBe(restored.prompt)
      PromptCaches.souls.delete(parent.id)
      const wrongHint = yield* sessionSoul(parent.id, "yuqi", souls)
      expect(wrongHint.id).toBe("karina")
      expect(wrongHint.prompt).toBe(restored.prompt)

      const next = yield* service.create({ soul: "karina" }).pipe(Effect.provideService(Soul.directory, test.directory))
      yield* Effect.promise(() =>
        Bun.write(file, "---\nid: karina\nname: V2 metadata\n---\n\nOriginal body V2"),
      )
      const metadataOnly = yield* service.create({ soul: "karina" }).pipe(Effect.provideService(Soul.directory, test.directory))
      expect(metadataOnly.soulBodyHash).not.toBe(next.soulBodyHash)
      yield* Effect.promise(() =>
        Bun.write(file, "---\nid: karina\nname: V2\ndisplay_name: Name V2\ncommit_prefix: CommitV2\n---\n\nOriginal body V2"),
      )
      const duplicate = yield* service.create({ soul: "karina" }).pipe(Effect.provideService(Soul.directory, test.directory))
      expect(next.soulBodyHash).not.toBe(parent.soulBodyHash)
      expect(duplicate.soulBodyHash).toBe(next.soulBodyHash)
      expect(
        Database.use((db) =>
          db
            .select()
            .from(SoulVersionTable)
            .where(eq(SoulVersionTable.hash, parent.soulBodyHash!))
            .get()?.body,
        ),
      ).toContain("Original body V1")
      yield* Effect.sync(() =>
        Database.use((db) =>
          db.delete(SoulVersionTable).where(eq(SoulVersionTable.hash, parent.soulBodyHash!)).run(),
        ),
      )
      PromptCaches.souls.delete(parent.id)
      const fallback = yield* sessionSoul(parent.id, parent.soul, souls).pipe(
        Effect.provideService(Soul.directory, test.directory),
      )
      expect(fallback.prompt).toContain("Original body V2")
      expect(
        Database.use((db) =>
          db.select({ soul_body_hash: SessionTable.soul_body_hash }).from(SessionTable).where(eq(SessionTable.id, parent.id)).get(),
        )?.soul_body_hash,
      ).toBe(parent.soulBodyHash)

      const child = yield* service.create({ parentID: parent.id })
      const fork = yield* service.fork({ sessionID: parent.id })
      expect(child.soulBodyHash).toBe(parent.soulBodyHash)
      expect(fork.soulBodyHash).toBe(parent.soulBodyHash)
      yield* service.remove(parent.id)
      yield* service.remove(child.id)
      yield* service.remove(fork.id)
      yield* service.remove(next.id)
      yield* service.remove(metadataOnly.id)
      yield* service.remove(duplicate.id)
      PromptCaches.souls.delete(parent.id)
    }),
  )
})
