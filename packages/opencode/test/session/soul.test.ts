import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { Info } from "../../src/soul/schema"
import { PromptCaches } from "../../src/session/prompt-caches"
import { render, sessionSoul, sessionTitlePrefix } from "../../src/session/soul"
import type { Interface as SoulService } from "../../src/soul"

const info = (overrides: Partial<Info> = {}): Info => ({
  id: "karina",
  name: "Karina",
  displayName: "敏敏",
  commitPrefix: "Karina",
  path: "/souls/karina.md",
  content: "Voice body",
  ...overrides,
})

function service(initial?: Info) {
  let current = initial
  let defaultID = "karina"
  const souls: SoulService = {
    list: () => Effect.succeed([]),
    issues: () => Effect.succeed([]),
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
})
