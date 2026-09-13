import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Exit } from "effect"
import { IsolationBoundaryRef } from "../../src/effect/instance-ref"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import type { Tool } from "@/tool/tool"
import { assertExternalDirectoryEffect } from "../../src/tool/external-directory"
import { Filesystem } from "@/util/filesystem"
import { provideInstance, TestInstance, tmpdirScoped } from "../fixture/fixture"
import type { Permission } from "../../src/permission"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(CrossSpawnSpawner.defaultLayer)

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

function makeCtx() {
  const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
  const ctx: Tool.Context = {
    ...baseCtx,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
      }),
  }
  return { requests, ctx }
}

describe("tool.assertExternalDirectory", () => {
  it.live("no-ops for empty target", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()

      yield* assertExternalDirectoryEffect(ctx)

      expect(requests.length).toBe(0)
    }),
  )

  it.live("no-ops for paths inside the instance directory", () =>
    provideInstance("/tmp/project")(
      Effect.gen(function* () {
        const { requests, ctx } = makeCtx()

        yield* assertExternalDirectoryEffect(ctx, path.join("/tmp/project", "file.txt"))

        expect(requests.length).toBe(0)
      }),
    ),
  )

  it.live("asks with a single canonical glob", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()

      const directory = "/tmp/project"
      const target = "/tmp/outside/file.txt"
      const expected = glob(path.join(path.dirname(target), "*"))

      yield* provideInstance(directory)(assertExternalDirectoryEffect(ctx, target))

      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    }),
  )

  it.live("uses target directory when kind=directory", () =>
    Effect.gen(function* () {
      const { requests, ctx } = makeCtx()

      const directory = "/tmp/project"
      const target = "/tmp/outside"
      const expected = glob(path.join(target, "*"))

      yield* provideInstance(directory)(assertExternalDirectoryEffect(ctx, target, { kind: "directory" }))

      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    }),
  )

  it.live("skips prompting when bypass=true", () =>
    provideInstance("/tmp/project")(
      Effect.gen(function* () {
        const { requests, ctx } = makeCtx()

        yield* assertExternalDirectoryEffect(ctx, "/tmp/outside/file.txt", { bypass: true })

        expect(requests.length).toBe(0)
      }),
    ),
  )

  if (process.platform === "win32") {
    it.instance(
      "normalizes Windows path variants to one glob",
      () =>
        Effect.gen(function* () {
          const { requests, ctx } = makeCtx()

          const outerTmp = yield* tmpdirScoped()
          yield* Effect.promise(() => Bun.write(path.join(outerTmp, "outside.txt"), "x"))

          const target = path.join(outerTmp, "outside.txt")
          const alt = target
            .replace(/^[A-Za-z]:/, "")
            .replaceAll("\\", "/")
            .toLowerCase()

          yield* assertExternalDirectoryEffect(ctx, alt)

          const req = requests.find((r) => r.permission === "external_directory")
          const expected = glob(path.join(outerTmp, "*"))
          expect(req).toBeDefined()
          expect(req!.patterns).toEqual([expected])
          expect(req!.always).toEqual([expected])
        }),
      { git: true },
    )

    it.instance(
      "uses drive root glob for root files",
      () =>
        Effect.gen(function* () {
          const { requests, ctx } = makeCtx()

          const tmp = yield* TestInstance
          const root = path.parse(tmp.directory).root
          const target = path.join(root, "boot.ini")

          yield* assertExternalDirectoryEffect(ctx, target)

          const req = requests.find((r) => r.permission === "external_directory")
          const expected = path.join(root, "*")
          expect(req).toBeDefined()
          expect(req!.patterns).toEqual([expected])
          expect(req!.always).toEqual([expected])
        }),
      { git: true },
  )
  }
})

describe("tool.assertExternalDirectory isolation boundary", () => {
  const boundary = "/tmp/worktree"

  it.live("still asks for writes outside when no boundary is set", () =>
    provideInstance(boundary)(
      Effect.gen(function* () {
        const { requests, ctx } = makeCtx()

        yield* assertExternalDirectoryEffect(ctx, "/tmp/outside/file.txt", { write: true })

        expect(requests.length).toBe(1)
      }),
    ),
  )

  it.live("rejects writes outside the isolation boundary", () =>
    provideInstance(boundary)(
      Effect.gen(function* () {
        const { requests, ctx } = makeCtx()

        const exit = yield* assertExternalDirectoryEffect(ctx, "/tmp/outside/file.txt", { write: true }).pipe(
          Effect.provideService(IsolationBoundaryRef, boundary),
          Effect.exit,
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(requests.length).toBe(0)
      }),
    ),
  )

  it.live("allows writes inside the isolation boundary", () =>
    provideInstance(boundary)(
      Effect.gen(function* () {
        const { requests, ctx } = makeCtx()

        yield* assertExternalDirectoryEffect(ctx, path.join(boundary, "src/file.txt"), { write: true }).pipe(
          Effect.provideService(IsolationBoundaryRef, boundary),
        )

        expect(requests.length).toBe(0)
      }),
    ),
  )

  it.live("still asks for reads outside the isolation boundary", () =>
    provideInstance(boundary)(
      Effect.gen(function* () {
        const { requests, ctx } = makeCtx()

        yield* assertExternalDirectoryEffect(ctx, "/tmp/outside/file.txt").pipe(
          Effect.provideService(IsolationBoundaryRef, boundary),
        )

        expect(requests.length).toBe(1)
      }),
    ),
  )
})
