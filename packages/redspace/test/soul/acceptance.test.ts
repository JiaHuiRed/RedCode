import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Soul } from "@/soul"
import { Session as SessionNs } from "@/session/session"
import { Bus } from "@/bus"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { PromptCaches } from "@/session/prompt-caches"
import { render, sessionSoul, sessionTitlePrefix } from "@/session/soul"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    SessionNs.layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(Storage.defaultLayer),
      Layer.provide(SyncEvent.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false, client: "tui" })),
      Layer.provide(BackgroundJob.defaultLayer),
    ),
    CrossSpawnSpawner.defaultLayer,
    Soul.defaultLayer,
  ),
)

const sessionsToClear = new Set<string>()

afterEach(() => {
  for (const id of sessionsToClear) PromptCaches.souls.delete(id)
  sessionsToClear.clear()
})

describe("Soul acceptance", () => {
  it.instance(
    "loads a copied persona into a pinned session snapshot and preserves it across defaults, edits, and removal",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const soulDir = path.join(test.directory, "acceptance-souls")
        yield* Effect.promise(() => fs.mkdir(soulDir, { recursive: true }))

        const sourcePath = process.env.REDCODE_SOUL_ACCEPTANCE_FILE
        const sourceBytes = sourcePath
          ? yield* Effect.promise(() => fs.readFile(sourcePath))
          : Buffer.from(
              [
                "---",
                "id: acceptance-persona",
                "name: Acceptance Persona",
                "display_name: Acceptance Display",
                "commit_prefix: AcceptanceCommit",
                "avatar: acceptance-avatar",
                "---",
                "",
                "# Acceptance Persona",
                "",
                "Acceptance body v1.",
                "",
              ].join("\n"),
              "utf8",
            )
        const copiedPath = path.join(soulDir, `source-${crypto.randomUUID()}.md`)
        yield* Effect.promise(() => fs.writeFile(copiedPath, sourceBytes))
        expect(yield* Effect.promise(() => fs.readFile(copiedPath))).toEqual(sourceBytes)

        const soul = yield* Soul.Service
        const summaries = yield* soul.list().pipe(Effect.provideService(Soul.directory, soulDir))
        expect(summaries).toHaveLength(1)
        const summary = summaries[0]
        expect(summary.id).toBeTruthy()
        expect("path" in summary).toBe(false)
        expect("content" in summary).toBe(false)
        const info = yield* soul.get(summary.id).pipe(Effect.provideService(Soul.directory, soulDir))
        expect(info).toBeDefined()
        if (!info) return yield* Effect.die(new Error("acceptance Soul was not readable"))
        expect(info?.id).toBe(summary.id)
        expect(info?.path).toBe(copiedPath)
        expect(summary.avatar).toBe(info?.avatar)
        expect(info?.content).toBeTruthy()

        const session = yield* SessionNs.Service
        const original = yield* session
          .create({ soul: summary.id })
          .pipe(Effect.provideService(Soul.directory, soulDir))
        sessionsToClear.add(original.id)
        expect((yield* session.get(original.id)).soul).toBe(summary.id)

        const firstSnapshot = yield* sessionSoul(original.id, original.soul, soul).pipe(
          Effect.provideService(Soul.directory, soulDir),
        )
        expect(firstSnapshot.info?.id).toBe(summary.id)
        const snapshotInfo = firstSnapshot.info
        if (!snapshotInfo) return yield* Effect.die(new Error("acceptance Soul snapshot was not resolved"))
        const displayed = render(snapshotInfo)
        expect(
          yield* sessionTitlePrefix(original.id, original.soul, soul).pipe(
            Effect.provideService(Soul.directory, soulDir),
          ),
        ).toBe(displayed.displayName)
        expect(displayed.prompt).toContain(snapshotInfo.content)
        expect(displayed.prompt).toContain(
          `Identity: ${displayed.displayName}. Commit attribution owner: [${displayed.commitPrefix}].`,
        )
        expect(displayed.displayName).toBe(snapshotInfo.displayName)
        expect(displayed.commitPrefix).toBe(snapshotInfo.commitPrefix)

        const changedDefaultID = `acceptance-default-${crypto.randomUUID()}`
        const changedDefaultPath = path.join(soulDir, `${changedDefaultID}.md`)
        yield* Effect.promise(() =>
          fs.writeFile(
            changedDefaultPath,
            ["---", `id: ${changedDefaultID}`, "name: Acceptance Default", "---", "", "Default-only body.", ""].join(
              "\n",
            ),
          ),
        )
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(soulDir, ".legacy-defaults.json"),
            JSON.stringify({ version: 1, defaults: { tui: changedDefaultID } }),
          ),
        )
        expect(yield* soul.defaultForClient("tui").pipe(Effect.provideService(Soul.directory, soulDir))).toBe(
          changedDefaultID,
        )
        const newlyDefaulted = yield* session.create().pipe(Effect.provideService(Soul.directory, soulDir))
        sessionsToClear.add(newlyDefaulted.id)
        expect(newlyDefaulted.soul).toBe(changedDefaultID)
        expect((yield* session.get(original.id)).soul).toBe(summary.id)
        expect(
          yield* sessionSoul(original.id, original.soul, soul).pipe(Effect.provideService(Soul.directory, soulDir)),
        ).toBe(firstSnapshot)

        const editedBody = `Edited acceptance body ${crypto.randomUUID()}.`
        const editedRaw = sourceBytes
          .toString("utf8")
          .replace(/^(---\r?\n[\s\S]*?\r?\n---\r?\n)[\s\S]*$/, `$1\n${editedBody}\n`)
        expect(editedRaw).not.toBe(sourceBytes.toString("utf8"))
        const editedBytes = Buffer.from(editedRaw, "utf8")
        yield* Effect.promise(() => fs.writeFile(copiedPath, editedBytes))
        expect(
          yield* sessionSoul(original.id, original.soul, soul).pipe(Effect.provideService(Soul.directory, soulDir)),
        ).toBe(firstSnapshot)
        expect(firstSnapshot.prompt).toContain(info.content)
        expect(firstSnapshot.prompt).not.toContain(editedBody)
        const afterEdit = yield* session
          .create({ soul: summary.id })
          .pipe(Effect.provideService(Soul.directory, soulDir))
        sessionsToClear.add(afterEdit.id)
        const editedSnapshot = yield* sessionSoul(afterEdit.id, afterEdit.soul, soul).pipe(
          Effect.provideService(Soul.directory, soulDir),
        )
        expect(editedSnapshot.prompt).toContain(editedBody)

        yield* Effect.promise(() => fs.unlink(copiedPath))
        expect(
          yield* sessionSoul(original.id, original.soul, soul).pipe(Effect.provideService(Soul.directory, soulDir)),
        ).toBe(firstSnapshot)
        const missingID = `acceptance-missing-${crypto.randomUUID()}`
        const missing = yield* sessionSoul(missingID, summary.id, soul).pipe(
          Effect.provideService(Soul.directory, soulDir),
        )
        sessionsToClear.add(missingID)
        expect(missing.info).toBeUndefined()
        if (!missing.prompt) return yield* Effect.die(new Error("missing Soul diagnostic was not rendered"))
        expect(missing.prompt).toContain(`pinned Soul "${summary.id}" is unavailable`)
        expect(Buffer.byteLength(missing.prompt, "utf8")).toBeLessThan(512)
        expect(missing.prompt).not.toContain(summary.displayName)
        expect(missing.prompt).not.toContain("Acceptance Default")
        expect(missing.prompt).not.toContain("Default-only body.")

        const fork = yield* session
          .fork({ sessionID: original.id })
          .pipe(Effect.provideService(Soul.directory, soulDir))
        sessionsToClear.add(fork.id)
        const child = yield* session
          .create({ parentID: original.id })
          .pipe(Effect.provideService(Soul.directory, soulDir))
        sessionsToClear.add(child.id)
        expect(fork.soul).toBe(summary.id)
        expect(child.soul).toBe(summary.id)
        expect((yield* session.get(fork.id)).soul).toBe(summary.id)
        expect((yield* session.get(child.id)).soul).toBe(summary.id)
        yield* session.remove(original.id)
        yield* session.remove(newlyDefaulted.id)
        yield* session.remove(afterEdit.id)
        yield* session.remove(fork.id)
        yield* session.remove(child.id)
      }),
    { timeout: 30000 },
  )
})
