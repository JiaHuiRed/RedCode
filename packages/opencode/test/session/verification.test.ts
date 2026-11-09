import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, FileSystem, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { AppProcess } from "@redcode-ai/core/process"
import { Permission } from "../../src/permission"
import { SessionVerification } from "../../src/session/verification"
import { SessionID } from "../../src/session/schema"
import type { Config } from "@/config/config"
import { tmpdirScoped } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, NodeFileSystem.layer))

const write = (filepath: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.dirname(filepath), { recursive: true })
    yield* fs.writeFileString(filepath, content)
  })

const writeFiles = (dir: string, files: Record<string, string>) =>
  Effect.all(
    Object.entries(files).map(([file, content]) => write(path.join(dir, file), content)),
    { discard: true },
  )

const packageJson = (script: string) =>
  JSON.stringify({ name: "fixture", private: true, scripts: { typecheck: script } })

// 261109 Karina 权限默认放行：验证服务的断言点是检查结果，不是弹窗流程；
// 拒绝路径单独用 failingPermission 覆盖。
const allowAll = Layer.mock(Permission.Service, { ask: () => Effect.void })

const provideVerification = (config: Config.Info, permission: Layer.Layer<Permission.Service> = allowAll) =>
  SessionVerification.layer.pipe(
    Layer.provide(TestConfig.layer({ get: () => Effect.succeed(config) })),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(AppProcess.defaultLayer),
    Layer.provide(permission),
  )

const report = (
  input: { worktree: string; changed: string[]; hash?: string },
  config: Config.Info = {},
  permission?: Layer.Layer<Permission.Service>,
) =>
  Effect.gen(function* () {
    const svc = yield* SessionVerification.Service
    return yield* svc.report({
      sessionID: SessionID.make("ses_verification_test"),
      worktree: input.worktree,
      ruleset: [],
      changed: input.changed,
      hash: input.hash,
    })
  }).pipe(Effect.provide(provideVerification(config, permission)))

describe("SessionVerification", () => {
  it.live("runs the affected package typecheck and reports passed", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, {
        "package.json": packageJson("bun pass.js"),
        "bun.lock": "",
        "pass.js": "process.exit(0)\n",
        "src/a.ts": "export const a = 1\n",
      })

      const result = yield* report({ worktree: dir, changed: ["src/a.ts"], hash: "abc123" })

      expect(result.changed_files).toEqual(["src/a.ts"])
      expect(result.packages).toEqual(["."])
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0]).toMatchObject({ name: "typecheck", status: "passed", exit_code: 0, cwd: "." })
      expect(result.status).toBe("passed")
      expect(result.snapshot_or_diff_ref).toBe("abc123")
    }),
  )

  it.live("reports a failing script with its exit code and stderr", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, {
        "package.json": packageJson("bun fail.js"),
        "bun.lock": "",
        "fail.js": 'console.error("boom from check")\nprocess.exit(3)\n',
        "src/a.ts": "export const a = 1\n",
      })

      const result = yield* report({ worktree: dir, changed: ["src/a.ts"] })

      expect(result.status).toBe("failed")
      expect(result.checks[0]).toMatchObject({ name: "typecheck", status: "failed", exit_code: 3 })
      expect(result.checks[0].reason).toContain("boom from check")
    }),
  )

  it.live("does not run anything when the package has no matching script", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, {
        "package.json": JSON.stringify({ scripts: { build: "bun pass.js" } }),
        "src/a.ts": "export const a = 1\n",
      })

      const result = yield* report({ worktree: dir, changed: ["src/a.ts"] })

      expect(result.checks).toEqual([])
      expect(result.status).toBe("not_run")
      expect(result.not_run_reason).toContain("no verification script matched")
    }),
  )

  it.live("skips auto-selected scripts listed in disabled_scripts", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, {
        "package.json": packageJson("bun pass.js"),
        "bun.lock": "",
        "pass.js": "process.exit(0)\n",
        "src/a.ts": "export const a = 1\n",
      })

      const result = yield* report({ worktree: dir, changed: ["src/a.ts"] }, { verification: { disabled_scripts: ["typecheck"] } })

      expect(result.status).toBe("not_run")
      expect(result.not_run_reason).toContain("disabled: typecheck")
    }),
  )

  it.live("turns a hanging check into a failed result instead of blocking the turn", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, {
        "package.json": packageJson("bun slow.js"),
        "bun.lock": "",
        "slow.js": "await Bun.sleep(5000)\n",
        "src/a.ts": "export const a = 1\n",
      })

      const result = yield* report({ worktree: dir, changed: ["src/a.ts"] }, { verification: { timeout_ms: 150 } })

      expect(result.status).toBe("failed")
      expect(result.checks[0].status).toBe("failed")
      expect(result.checks[0].reason).toContain("timed out after 150ms")
    }),
  )

  it.live("marks a check skipped when permission is denied", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, {
        "package.json": packageJson("bun pass.js"),
        "bun.lock": "",
        "pass.js": "process.exit(0)\n",
        "src/a.ts": "export const a = 1\n",
      })

      const denied = Layer.mock(Permission.Service, {
        ask: () => Effect.fail(new Permission.DeniedError({ ruleset: [] })),
      })
      const result = yield* report({ worktree: dir, changed: ["src/a.ts"] }, {}, denied)

      expect(result.checks[0]).toMatchObject({ status: "skipped", reason: "permission denied by ruleset or user" })
      expect(result.status).toBe("partial")
    }),
  )

  it.live("flags protected paths that changed during the turn", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, {
        "package.json": packageJson("bun pass.js"),
        "bun.lock": "",
        "pass.js": "process.exit(0)\n",
        "unrelated/x.ts": "export const x = 1\n",
      })

      const result = yield* report(
        { worktree: dir, changed: ["unrelated/x.ts"] },
        { verification: { protected_paths: ["unrelated"] } },
      )

      expect(result.unrelated_change_warning).toEqual(["unrelated/x.ts"])
    }),
  )

  it.live("works when the project path contains spaces", () =>
    Effect.gen(function* () {
      const parent = yield* tmpdirScoped()
      const dir = path.join(parent, "my project")
      yield* writeFiles(dir, {
        "package.json": packageJson("bun pass.js"),
        "bun.lock": "",
        "pass.js": "process.exit(0)\n",
        "src/a.ts": "export const a = 1\n",
      })

      const result = yield* report({ worktree: dir, changed: ["src/a.ts"] })

      expect(result.status).toBe("passed")
      expect(result.checks[0].cwd).toBe(".")
    }),
  )

  it.live("reports not_run when changed files do not belong to any package", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, { "notes.txt": "hello\n" })

      const result = yield* report({ worktree: dir, changed: ["notes.txt"] })

      expect(result.status).toBe("not_run")
      expect(result.not_run_reason).toBe("no package.json found for the changed files")
    }),
  )

  it.live("runs only configured checks when auto-selection finds nothing", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, { "notes.txt": "hello\n" })

      const result = yield* report(
        { worktree: dir, changed: ["notes.txt"] },
        { verification: { commands: [{ name: "smoke", command: "bun pass.js" }] } },
      )
      // pass.js 不存在 → 命令失败，但重点是配置检查被真正尝试而不是静默跳过
      expect(result.checks).toHaveLength(1)
      expect(result.checks[0].name).toBe("smoke")
    }),
  )

  it.live("renders a bounded summary", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* writeFiles(dir, {
        "package.json": packageJson("bun pass.js"),
        "bun.lock": "",
        "pass.js": "process.exit(0)\n",
      })
      const files = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`)
      yield* writeFiles(dir, Object.fromEntries(files.map((file) => [file, "export {}\n"])))

      const svc = yield* SessionVerification.Service
      const result = yield* svc.report({
        sessionID: SessionID.make("ses_verification_test"),
        worktree: dir,
        ruleset: [],
        changed: files,
      })
      const text = svc.render(result)

      expect(text).toContain("等 12 个")
      expect(text).toContain("交付验证：passed")
    }).pipe(Effect.provide(provideVerification({}))),
  )

  // 261109 Karina 报告正文进模型上下文，必须有确定字节上界：10 条超长路径
  // 靠列举截断是挡不住的。
  it.live("caps the rendered report at a fixed byte budget", () =>
    Effect.gen(function* () {
      const svc = yield* SessionVerification.Service
      const text = svc.render({
        status: "passed",
        changed_files: Array.from({ length: 10 }, () => "x".repeat(2000)),
        packages: [],
        checks: [],
        unrelated_change_warning: [],
        generated_at: 0,
      })
      expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(4096 + 64)
      expect(text).toContain("[verification report truncated]")
    }).pipe(Effect.provide(provideVerification({}))),
  )
})
