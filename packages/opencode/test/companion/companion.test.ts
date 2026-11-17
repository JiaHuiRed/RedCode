import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js"
import fs from "node:fs/promises"
import path from "node:path"
import { Companion } from "@/companion/companion"
import { Soul } from "@/soul"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(Companion.defaultLayer, Soul.defaultLayer, CrossSpawnSpawner.defaultLayer))
const fixture = {
  "workspace/SOUL.md": "# Example Companion\n\nWarm, curious, and remembers shared history.\n",
  "workspace/MEMORY.md": "# Long-term memory\n\nWe named our shared project RedGarden.\n",
  "workspace/memory/2026-03-09.md": "# First day\n\nWe planted a maple tree together.\n",
  "workspace/AGENTS.md": "# Legacy instructions\n\nLegacy runtime instructions must remain inactive.\n",
  "workspace/.agents/skills/example/SKILL.md": "# An old installed skill\n",
  "openclaw.json": JSON.stringify({
    agents: { list: [{ id: "main", identity: { name: "Maple" } }], defaults: { userTimezone: "Asia/Hong_Kong" } },
    models: { providers: { example: { apiKey: "fixture-secret-must-not-be-copied" } } },
  }),
}

type Fixture = { source: string; root: string; souls: string }

function setup(body: (value: Fixture) => Effect.Effect<void, unknown, Companion.Service | Soul.Service>) {
  return Effect.gen(function* () {
    const temp = yield* tmpdirScoped()
    const value = {
      source: path.join(temp, "old-home"),
      root: path.join(temp, "companions"),
      souls: path.join(temp, "souls"),
    }
    yield* Effect.promise(async () => {
      for (const [relative, content] of Object.entries(fixture)) {
        const file = path.join(value.source, relative)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, content)
      }
    })
    yield* body(value).pipe(
      Effect.provideService(Companion.directory, value.root),
      Effect.provideService(Soul.directory, value.souls),
    )
  })
}

describe("companion archive", () => {
  it.live(
    "returns the canonical workspace when the companion root is a directory alias",
    setup((value) =>
      Effect.gen(function* () {
        const alias = path.join(path.dirname(value.root), "companion-alias")
        yield* Effect.promise(async () => {
          await fs.mkdir(value.root, { recursive: true })
          await fs.symlink(value.root, alias, process.platform === "win32" ? "junction" : "dir")
        })
        const service = yield* Companion.Service
        yield* Effect.gen(function* () {
          const imported = yield* service.importArchive({ source: value.source, id: "maple" })
          const canonical = yield* Effect.promise(() => fs.realpath(imported.profile.directory))
          expect(imported.profile.directory).toBe(canonical)
          expect((yield* service.get("maple"))?.directory).toBe(canonical)
          expect((yield* service.list())[0]?.directory).toBe(canonical)
          const repeated = yield* service.importArchive({ source: value.source, id: "maple" })
          expect(repeated.imported).toBe(false)
          expect(repeated.profile.directory).toBe(canonical)
        }).pipe(Effect.provideService(Companion.directory, alias))
      }),
    ),
  )

  it.live(
    "imports the existing identity and personal sources without activating old instructions or copying credentials",
    setup((value) =>
      Effect.gen(function* () {
        const service = yield* Companion.Service
        const result = yield* service.importArchive({ source: value.source, id: "maple" })
        expect(result.imported).toBe(true)
        expect(result.profile.name).toBe("Maple")
        expect(result.profile.soulID).toBe("maple")
        expect(result.profile.timezone).toBe("Asia/Hong_Kong")
        expect(result.profile.files).toBe(5)
        expect((yield* (yield* Soul.Service).get("maple"))?.content).toContain("remembers shared history")
        expect(yield* Effect.promise(() => fs.readFile(path.join(result.profile.directory, "MEMORY.md"), "utf8"))).toBe(
          fixture["workspace/MEMORY.md"],
        )
        expect(
          yield* Effect.promise(() => fs.readFile(path.join(value.root, "maple/source/workspace/AGENTS.md"), "utf8")),
        ).toBe(fixture["workspace/AGENTS.md"])
        expect(
          yield* Effect.promise(() =>
            fs.access(path.join(result.profile.directory, "AGENTS.md")).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
        expect(
          yield* Effect.promise(() =>
            fs.access(path.join(result.profile.directory, ".agents")).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false)
        const manifest = yield* Effect.promise(() => fs.readFile(path.join(value.root, "maple/profile.json"), "utf8"))
        expect(manifest).not.toContain("fixture-secret")
        expect(yield* service.list()).toHaveLength(1)
      }),
    ),
  )

  it.live(
    "reimport is idempotent and never overwrites memories written after the move",
    setup((value) =>
      Effect.gen(function* () {
        const service = yield* Companion.Service
        yield* service.importArchive({ source: value.source, id: "maple" })
        const written = yield* service.remember({
          id: "maple",
          text: "Today we finished the garden.",
          idempotencyKey: "session-one:turn-one",
        })
        const repeated = yield* service.importArchive({ source: value.source, id: "maple" })
        expect(repeated.imported).toBe(false)
        expect((yield* service.read({ id: "maple", path: written.path })).text).toContain("finished the garden")
        yield* Effect.promise(() =>
          fs.appendFile(path.join(value.source, "workspace/MEMORY.md"), "A changed archive.\n"),
        )
        const conflict = yield* service.importArchive({ source: value.source, id: "maple" }).pipe(Effect.flip)
        expect(conflict._tag).toBe("CompanionConflict")
        expect((yield* service.read({ id: "maple", path: "MEMORY.md" })).text).not.toContain("changed archive")
      }),
    ),
  )

  it.live(
    "keeps the default identity stable when an archive gains memories",
    setup((value) =>
      Effect.gen(function* () {
        const service = yield* Companion.Service
        const first = yield* service.importArchive({ source: value.source, name: "Custom display name" })
        const repeated = yield* service.importArchive({ source: value.source })
        expect(repeated.imported).toBe(false)
        expect(repeated.profile.id).toBe(first.profile.id)
        expect(repeated.profile.name).toBe("Custom display name")
        yield* Effect.promise(() =>
          fs.appendFile(path.join(value.source, "workspace/MEMORY.md"), "New historical source.\n"),
        )
        expect((yield* service.importArchive({ source: value.source }).pipe(Effect.flip))._tag).toBe(
          "CompanionConflict",
        )
        expect(yield* service.list()).toHaveLength(1)
      }),
    ),
  )

  it.live(
    "reads a new service from disk, recalls original passages, and preserves independently bound profiles",
    setup((value) =>
      Effect.gen(function* () {
        const service = yield* Companion.Service
        yield* service.importArchive({ source: value.source, id: "maple" })
        yield* service.remember({
          id: "maple",
          text: "我们一起吃了辣子鸡。",
          source: "session:one/message:one",
          idempotencyKey: "turn-one",
        })
        const recalled = yield* Effect.gen(function* () {
          const fresh = yield* Companion.Service
          const profile = yield* fresh.get("maple")
          expect(profile?.name).toBe("Maple")
          expect((yield* fresh.bootstrap("maple")).text).toContain("辣子鸡")
          return yield* fresh.search({ id: "maple", query: "辣子鸡" })
        }).pipe(Effect.provide(Companion.defaultLayer))
        expect(recalled.results[0].text).toContain("辣子鸡")
        expect(recalled.results[0].startLine).toBeGreaterThan(0)
        yield* service.importArchive({ source: value.source, id: "other", name: "Other" })
        expect((yield* service.search({ id: "other", query: "辣子鸡" })).results).toEqual([])
      }),
    ),
  )

  it.live(
    "bounds UTF-8 bootstrap and reads the newest end of the most recent diary",
    setup((value) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          fs.writeFile(path.join(value.source, "workspace/MEMORY.md"), "共同经历。".repeat(10000)),
        )
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(value.source, "workspace/memory/2026-10-07.md"),
            "EARLY\n" + "较早的记录。".repeat(2000) + "\nLATEST_EVENT\n",
          ),
        )
        const service = yield* Companion.Service
        yield* service.importArchive({ source: value.source, id: "maple" })
        const bootstrap = yield* service.bootstrap("maple")
        expect(Buffer.byteLength(bootstrap.text)).toBeLessThanOrEqual(Companion.Limits.bootstrap)
        expect(bootstrap.text).toContain("LATEST_EVENT")
        expect(bootstrap.text).not.toContain("EARLY")
        expect(bootstrap.text).not.toContain("\uFFFD")
        expect(bootstrap.text).toContain("truncated")
        expect(bootstrap.sources).toContain("memory/2026-03-09.md")
      }),
    ),
  )

  it.live(
    "imports a wrapped ZIP byte-for-byte and reports legacy encoding and deferred conversations",
    setup((value) =>
      Effect.gen(function* () {
        const archive = path.join(value.source, "personal.zip")
        const invalid = new Uint8Array([0x61, 0xff, 0x62])
        yield* Effect.promise(async () => {
          const writer = new ZipWriter(new Uint8ArrayWriter())
          for (const [name, content] of Object.entries(fixture))
            await writer.add(`.openclaw/${name}`, new Uint8ArrayReader(Buffer.from(content)), { useWebWorkers: false })
          await writer.add(".openclaw/workspace/memory/2026-10-08.md", new Uint8ArrayReader(invalid), {
            useWebWorkers: false,
          })
          await writer.add(".openclaw/agents/main/sessions/old.jsonl", new Uint8ArrayReader(Buffer.from("{}\n")), {
            useWebWorkers: false,
          })
          await fs.writeFile(archive, await writer.close())
        })
        const service = yield* Companion.Service
        const imported = yield* service.importArchive({ source: archive, id: "maple" })
        expect(imported.profile.warnings.some((warning) => warning.includes("Non-UTF-8"))).toBe(true)
        expect(imported.profile.warnings.some((warning) => warning.includes("historical conversation"))).toBe(true)
        expect(
          new Uint8Array(
            yield* Effect.promise(() =>
              fs.readFile(path.join(value.root, "maple/source/workspace/memory/2026-10-08.md")),
            ),
          ),
        ).toEqual(invalid)
        expect((yield* service.bootstrap("maple")).warnings.some((warning) => warning.includes("UTF-8"))).toBe(true)
        expect((yield* service.read({ id: "maple", path: "memory/2026-10-08.md" }).pipe(Effect.flip))._tag).toBe(
          "CompanionInvalidInput",
        )
      }),
    ),
  )

  it.live(
    "loads bounded identity and user context and searches only the authorized recall sources",
    setup((value) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await fs.writeFile(
            path.join(value.source, "workspace/USER.md"),
            "Violet user likes quiet mornings.\n" + "用户资料。".repeat(1000) + "USER_TAIL",
          )
          await fs.writeFile(
            path.join(value.source, "workspace/IDENTITY.md"),
            "Violet identity remembers our shared name.\n" + "身份资料。".repeat(1000) + "IDENTITY_TAIL",
          )
        })
        const service = yield* Companion.Service
        yield* service.importArchive({ source: value.source, id: "maple" })
        const bootstrap = yield* service.bootstrap("maple")
        expect(bootstrap.sources).toContain("USER.md")
        expect(bootstrap.sources).toContain("IDENTITY.md")
        expect(bootstrap.text).toContain("Violet user")
        expect(bootstrap.text).toContain("Violet identity")
        expect(bootstrap.text).not.toContain("USER_TAIL")
        expect(bootstrap.text).not.toContain("IDENTITY_TAIL")
        expect(Buffer.byteLength(bootstrap.text)).toBeLessThanOrEqual(Companion.Limits.bootstrap)
        expect(yield* service.sources("maple")).toEqual(["IDENTITY.md", "MEMORY.md", "USER.md", "memory/2026-03-09.md"])
        const all = yield* service.search({ id: "maple", query: "Violet" })
        expect(new Set(all.results.map((result) => result.path))).toEqual(new Set(["USER.md", "IDENTITY.md"]))
        const allowed = yield* service.search({ id: "maple", query: "Violet", paths: ["USER.md"] })
        expect(allowed.results.length).toBeGreaterThan(0)
        expect(allowed.results.every((result) => result.path === "USER.md")).toBe(true)
        expect((yield* service.search({ id: "maple", query: "Violet", paths: [] })).results).toEqual([])
        for (const file of ["SOUL.md", "../profile.json", "memory/2099-01-01.md"])
          expect((yield* service.search({ id: "maple", query: "Violet", paths: [file] }).pipe(Effect.flip))._tag).toBe(
            "CompanionInvalidInput",
          )
      }),
    ),
  )

  it.live(
    "continues byte-bounded multiline and long UTF-8 line excerpts without skipping source text",
    setup((value) =>
      Effect.gen(function* () {
        const content =
          "\uFEFF" +
          Array.from({ length: 50 }, (_, index) => `${index}: ${"共同经历。".repeat(100)}\r\n`).join("") +
          "很长的一行：" +
          "一直相伴。".repeat(10000) +
          "\r\nTHE_END"
        yield* Effect.promise(() => fs.writeFile(path.join(value.source, "workspace/MEMORY.md"), content))
        const service = yield* Companion.Service
        yield* service.importArchive({ source: value.source, id: "maple" })
        const first = yield* service.read({ id: "maple", path: "MEMORY.md", offset: 1, limit: 200 })
        expect(first.endLine).toBeLessThan(50)
        expect(first.byteOffset).toBe(0)
        expect(first.nextByteOffset).toBe(Buffer.byteLength(first.text))
        const chunks = [first.text]
        let page = first
        let partial = false
        while (page.nextByteOffset !== undefined) {
          const offset = page.nextByteOffset
          page = yield* service.read({ id: "maple", path: "MEMORY.md", byteOffset: offset, limit: 200 })
          expect(page.byteOffset).toBe(offset)
          expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(Companion.Limits.read)
          expect(page.text).not.toContain("\uFFFD")
          if (page.startLine === 51 && page.endLine === 51) partial = true
          chunks.push(page.text)
        }
        expect(partial).toBe(true)
        expect(page.truncated).toBe(false)
        expect(page.endLine).toBe(52)
        expect(chunks.join("")).toBe(content)
        expect(
          (yield* service.read({ id: "maple", path: "MEMORY.md", offset: 1, byteOffset: 0 }).pipe(Effect.flip))._tag,
        ).toBe("CompanionInvalidInput")
        expect((yield* service.read({ id: "maple", path: "MEMORY.md", byteOffset: 1 }).pipe(Effect.flip))._tag).toBe(
          "CompanionInvalidInput",
        )
      }),
    ),
  )

  it.live(
    "uses the authorized timestamp's diary and refuses directory or file links during append",
    setup((value) =>
      Effect.gen(function* () {
        const service = yield* Companion.Service
        const imported = yield* service.importArchive({ source: value.source, id: "maple" })
        const time = Date.parse("2026-11-17T16:30:00Z")
        const file = Companion.diaryPath(imported.profile.timezone, time)
        expect(file).toBe("memory/2026-11-18.md")
        const saved = yield* service.remember({ id: "maple", text: "A memory with a stable local date.", time })
        expect(saved.path).toBe(file)
        const external = path.join(value.source, "outside")
        yield* Effect.promise(async () => {
          await fs.mkdir(external)
          await fs.writeFile(path.join(external, path.basename(file)), "UNTOUCHED")
          await fs.rename(
            path.join(imported.profile.directory, "memory"),
            path.join(imported.profile.directory, "original-memory"),
          )
          await fs.symlink(external, path.join(imported.profile.directory, "memory"), "junction")
        })
        expect(
          (yield* service.remember({ id: "maple", text: "Must stay private.", time }).pipe(Effect.flip))._tag,
        ).toBe("CompanionInvalidInput")
        expect(yield* Effect.promise(() => fs.readFile(path.join(external, path.basename(file)), "utf8"))).toBe(
          "UNTOUCHED",
        )
        // Windows file symlinks require a privilege not granted on every developer machine; the junction above covers that platform.
        if (process.platform !== "win32") {
          yield* Effect.promise(async () => {
            await fs.unlink(path.join(imported.profile.directory, "memory"))
            await fs.mkdir(path.join(imported.profile.directory, "memory"))
            await fs.symlink(path.join(external, path.basename(file)), path.join(imported.profile.directory, file))
          })
          expect(
            (yield* service.remember({ id: "maple", text: "Must stay private too.", time }).pipe(Effect.flip))._tag,
          ).toBe("CompanionInvalidInput")
          expect(yield* Effect.promise(() => fs.readFile(path.join(external, path.basename(file)), "utf8"))).toBe(
            "UNTOUCHED",
          )
        }
      }),
    ),
  )

  it.live(
    "rejects ZIP traversal before creating a companion",
    setup((value) =>
      Effect.gen(function* () {
        const archive = path.join(value.source, "unsafe.zip")
        const service = yield* Companion.Service
        for (const unsafe of ["workspace/../../escape.md", "workspace/.. /escape.md"]) {
          yield* Effect.promise(async () => {
            const writer = new ZipWriter(new Uint8ArrayWriter())
            await writer.add("workspace/SOUL.md", new Uint8ArrayReader(Buffer.from(fixture["workspace/SOUL.md"])), {
              useWebWorkers: false,
            })
            await writer.add(unsafe, new Uint8ArrayReader(Buffer.from("escape")), { useWebWorkers: false })
            await fs.writeFile(archive, await writer.close())
          })
          expect((yield* service.importArchive({ source: archive, id: "maple" }).pipe(Effect.flip))._tag).toBe(
            "CompanionInvalidInput",
          )
        }
        expect(yield* service.list()).toEqual([])
        expect(yield* (yield* Soul.Service).get("maple")).toBeUndefined()
      }),
    ),
  )

  it.live(
    "keeps concurrent remembers and writes an idempotent entry exactly once",
    setup((value) =>
      Effect.gen(function* () {
        const service = yield* Companion.Service
        yield* service.importArchive({ source: value.source, id: "maple" })
        const results = yield* Effect.all(
          Array.from({ length: 8 }, (_, index) =>
            Effect.gen(function* () {
              const separate = yield* Companion.Service
              return yield* separate.remember({
                id: "maple",
                text: `New memory ${index}.`,
                idempotencyKey: `turn-${index}`,
              })
            }).pipe(Effect.provide(Companion.defaultLayer)),
          ),
          { concurrency: "unbounded" },
        )
        const repeats = yield* Effect.all(
          Array.from({ length: 4 }, () =>
            service.remember({
              id: "maple",
              text: "New memory 0.",
              idempotencyKey: "turn-0",
            }),
          ),
          { concurrency: "unbounded" },
        )
        expect(repeats.every((result) => !result.created)).toBe(true)
        const diary = yield* service.read({ id: "maple", path: results[0].path })
        for (let index = 0; index < 8; index++) expect(diary.text.split(`New memory ${index}.`)).toHaveLength(2)
        expect(
          (yield* service.remember({ id: "maple", text: "Different", idempotencyKey: "turn-0" }).pipe(Effect.flip))
            ._tag,
        ).toBe("CompanionConflict")
      }),
    ),
  )

  it.live(
    "returns line-based source excerpts, bounds serialized search, and refuses reads outside the archive",
    setup((value) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(value.source, "workspace/MEMORY.md"),
            "Header\n" + ("RedGarden " + "内容".repeat(1500) + "\n").repeat(5),
          ),
        )
        const service = yield* Companion.Service
        const imported = yield* service.importArchive({ source: value.source, id: "maple" })
        const read = yield* service.read({ id: "maple", path: "MEMORY.md", offset: 1, limit: 1 })
        expect(read.text).toBe("Header\n")
        expect(read.startLine).toBe(1)
        expect(read.endLine).toBe(1)
        expect(read.truncated).toBe(true)
        const found = yield* service.search({ id: "maple", query: "RedGarden", limit: 10 })
        expect(Buffer.byteLength(JSON.stringify(found))).toBeLessThanOrEqual(Companion.Limits.search)
        expect(found.results.length).toBeGreaterThan(0)
        expect((yield* service.read({ id: "maple", path: "../../openclaw.json" }).pipe(Effect.flip))._tag).toBe(
          "CompanionInvalidInput",
        )
        const external = path.join(value.source, "outside")
        yield* Effect.promise(() => fs.mkdir(external))
        yield* Effect.promise(() => fs.writeFile(path.join(external, "2026-10-09.md"), "outside"))
        yield* Effect.promise(() =>
          fs.rename(
            path.join(imported.profile.directory, "memory"),
            path.join(imported.profile.directory, "original-memory"),
          ),
        )
        yield* Effect.promise(() => fs.symlink(external, path.join(imported.profile.directory, "memory"), "junction"))
        expect((yield* service.read({ id: "maple", path: "memory/2026-10-09.md" }).pipe(Effect.flip))._tag).toBe(
          "CompanionInvalidInput",
        )
      }),
    ),
  )
})
