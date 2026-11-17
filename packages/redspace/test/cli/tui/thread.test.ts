import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@redcode-ai/core/global"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { Companion } from "../../../src/companion/companion"
import { Soul } from "../../../src/soul"
import { tmpdir, tmpdirScoped } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"
import { recordProjectVisit } from "../../../src/cli/cmd/tui/project-history"
import {
  latestProjectDirectory,
  resolveInvocationDirectory,
  resolveStartupCompanion,
  resolveThreadDirectory,
} from "../../../src/cli/cmd/tui/thread"

const it = testEffect(Layer.mergeAll(Companion.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("tui thread", () => {
  async function check(project?: string) {
    await using tmp = await tmpdir({ git: true })
    const link = path.join(path.dirname(tmp.path), path.basename(tmp.path) + "-link")
    const type = process.platform === "win32" ? "junction" : "dir"

    try {
      await fs.symlink(tmp.path, link, type)
      expect(resolveThreadDirectory(project, link, tmp.path)).toBe(tmp.path)
    } finally {
      await fs.rm(link, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  test("uses the real cwd when PWD points at a symlink", async () => {
    await check()
  })

  test("uses the real cwd after resolving a relative project from PWD", async () => {
    await check(".")
  })
})

it.live("--companion resolves the persisted personal workspace and never falls back for a missing identity", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const source = path.join(directory, "source")
    yield* Effect.promise(() => Bun.write(path.join(source, "workspace", "SOUL.md"), "# Mira\nA familiar companion."))
    yield* Effect.gen(function* () {
      const service = yield* Companion.Service
      const imported = yield* service.importArchive({ source, id: "mira", name: "Mira" })
      const profile = yield* resolveStartupCompanion("mira")
      expect(profile.id).toBe("mira")
      expect(profile.directory).toBe(imported.profile.directory)
      expect(profile.soulID).toBe(imported.profile.soulID)
      const missing = yield* resolveStartupCompanion("missing").pipe(Effect.flip)
      expect(missing.message).toContain("was not found")
    }).pipe(
      Effect.provideService(Companion.directory, path.join(directory, "companions")),
      Effect.provideService(Soul.directory, path.join(directory, "souls")),
    )
  }),
)

// 261110 Red 启动目录规则：显式 path 与真实调用 cwd 优先，exe 目录不可信时回落最近项目，
// 历史里的失效路径不能被当成启动位置。
describe("tui thread startup directory", () => {
  test("keeps the real invocation directory when not compiled", () => {
    const cwd = path.join(process.cwd(), "not", "installed")
    expect(
      resolveInvocationDirectory({ cwd, execPath: path.join(process.cwd(), "bin", "redcode.exe"), compiled: false }),
    ).toBe(resolveThreadDirectory(undefined, undefined, cwd))
  })

  test("treats the executable directory as unreliable only when compiled", () => {
    const install = path.join(process.cwd(), "installation")
    const execPath = path.join(install, "redcode.exe")
    expect(resolveInvocationDirectory({ cwd: install, execPath, compiled: true })).toBeUndefined()
    expect(resolveInvocationDirectory({ cwd: install, execPath, compiled: false })).toBe(
      resolveThreadDirectory(undefined, undefined, install),
    )
  })

  test("respects a call from another directory even when compiled", () => {
    const cwd = path.join(process.cwd(), "project")
    const execPath = path.join(process.cwd(), "installation", "redcode.exe")
    expect(resolveInvocationDirectory({ cwd, execPath, compiled: true })).toBe(
      resolveThreadDirectory(undefined, undefined, cwd),
    )
  })

  test("skips history entries whose directory no longer exists", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    try {
      const missing = path.join(tmp.path, "missing")
      await recordProjectVisit({ directory: tmp.path })
      await recordProjectVisit({ directory: missing })
      expect(await latestProjectDirectory()).toBe(tmp.path)
    } finally {
      Global.Path.state = previous
    }
  })

  test("returns undefined when history has no usable directory", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    try {
      await recordProjectVisit({ directory: path.join(tmp.path, "gone") })
      expect(await latestProjectDirectory()).toBeUndefined()
    } finally {
      Global.Path.state = previous
    }
  })
})
