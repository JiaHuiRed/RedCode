import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/process"
import { AppProcess } from "@redcode-ai/core/process"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import * as Log from "@redcode-ai/core/util/log"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import type { SessionID } from "./schema"

// 261109 Karina RC-05 任务收尾的定向验证。
//
// 不变量（三条，缺一条这个功能就会变成新的假绿来源）：
//   ① 只跑「受影响包」的短检查，默认不跑全量测试套件——全量留给用户显式要求或发布门禁；
//   ② 状态严格分 passed / failed / skipped / not_run，没跑就写原因，绝不汇总成「全部通过」；
//   ③ 命令走既有权限体系（Permission.ask + 当前 agent/session 的 ruleset），不另开旁路。
//
// 报告是交付证据：改了什么、哪些检查真跑过、失败原因是什么。结构化结果挂在 text part
// 的 metadata.verification 上，正文只放有界摘要。
export const CheckStatus = Schema.Literals(["passed", "failed", "skipped", "not_run"])
export type CheckStatus = Schema.Schema.Type<typeof CheckStatus>

export const Check = Schema.Struct({
  name: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  status: CheckStatus,
  exit_code: Schema.optional(Schema.Number),
  duration_ms: Schema.optional(Schema.Number),
  // 失败/跳过时必填：没有原因的 failed/skipped 等于让人猜。
  reason: Schema.optional(Schema.String),
}).annotate({ identifier: "VerificationCheck" })
export type Check = Schema.Schema.Type<typeof Check>

export const Report = Schema.Struct({
  status: Schema.Literals(["passed", "failed", "partial", "not_run"]),
  changed_files: Schema.Array(Schema.String),
  packages: Schema.Array(Schema.String),
  checks: Schema.Array(Check),
  unrelated_change_warning: Schema.Array(Schema.String),
  not_run_reason: Schema.optional(Schema.String),
  snapshot_or_diff_ref: Schema.optional(Schema.String),
  generated_at: Schema.Number,
}).annotate({ identifier: "VerificationReport" })
export type Report = Schema.Schema.Type<typeof Report>

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_CHECKS = 3
const MAX_REASON_CHARS = 300
const MAX_LISTED_FILES = 10
// 报告正文进入模型上下文（appendNotice 会作为 assistant text 落库），必须有确定字节上界。
// 10 条文件路径 × 任意长度、配置里的检查名同样没有长度约束，靠列举截断不够。
const MAX_REPORT_BYTES = 4096

// 按字节截断且不切坏多字节字符；与 session/instruction.ts 的 truncateToBytes 同法。
const capBytes = (text: string, limit: number) => {
  const encoder = new TextEncoder()
  if (encoder.encode(text).byteLength <= limit) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (encoder.encode(text.slice(0, mid)).byteLength <= limit) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo) + "\n[verification report truncated]"
}

// 261109 Karina 自动选检查的脚本名单保持窄：只认 typecheck。lint 会扫全仓、
// test 需要项目专属的文件过滤参数（本仓裸 bun test 是默认 5s 超时，会大面积假失败），
// 自动跑它们只会制造假失败。需要别的检查的仓库用 verification.commands 显式声明。
const AUTO_SCRIPTS = ["typecheck"] as const

const truncate = (text: string, limit: number) => (text.length <= limit ? text : text.slice(0, limit) + "…")

const displayCwd = (root: string, dir: string) => {
  const rel = path.relative(root, dir)
  return rel === "" ? "." : rel.replaceAll("\\", "/")
}

export interface Interface {
  readonly report: (input: {
    sessionID: SessionID
    worktree: string
    ruleset: Permission.Ruleset
    changed: readonly string[]
    hash?: string
    signal?: AbortSignal
  }) => Effect.Effect<Report>
  readonly render: (report: Report) => string
}

export class Service extends Context.Service<Service, Interface>()("@redcode/Verification") {}

export const layer: Layer.Layer<
  Service,
  never,
  Config.Service | AppFileSystem.Service | AppProcess.Service | Permission.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const fs = yield* AppFileSystem.Service
    const appProcess = yield* AppProcess.Service
    const permission = yield* Permission.Service

    // 从改动文件向上找最近的 package.json。用 AppFileSystem.contains 而不是字符串前缀，
    // 理由与 session/instruction.ts 的 isWithinRoot 相同：同前缀兄弟目录不是项目内。
    const packageOf = Effect.fnUntraced(function* (root: string, file: string) {
      let dir = path.dirname(path.resolve(root, file))
      while (AppFileSystem.contains(root, dir)) {
        if (yield* fs.existsSafe(path.join(dir, "package.json"))) return dir
        if (dir === root) return undefined
        dir = path.dirname(dir)
      }
      return undefined
    })

    const readScripts = Effect.fnUntraced(function* (dir: string) {
      const empty = {} as { scripts?: Record<string, string> }
      const text = yield* fs.readFileString(path.join(dir, "package.json")).pipe(Effect.catch(() => Effect.succeed("")))
      if (!text) return empty
      return yield* Effect.try(() => JSON.parse(text) as { scripts?: Record<string, string> }).pipe(
        Effect.catch(() => Effect.succeed(empty)),
      )
    })

    // 包管理器按锁文件判，不看 PATH 里碰巧装了谁；同一个包目录优先于仓库根。
    const runnerOf = Effect.fnUntraced(function* (root: string, dir: string) {
      for (const candidate of [dir, root]) {
        if (yield* fs.existsSafe(path.join(candidate, "bun.lock"))) return "bun"
        if (yield* fs.existsSafe(path.join(candidate, "bun.lockb"))) return "bun"
        if (yield* fs.existsSafe(path.join(candidate, "pnpm-lock.yaml"))) return "pnpm"
        if (yield* fs.existsSafe(path.join(candidate, "yarn.lock"))) return "yarn"
      }
      return "npm"
    })

    const report = Effect.fn("Verification.report")(function* (input: {
      sessionID: SessionID
      worktree: string
      ruleset: Permission.Ruleset
      changed: readonly string[]
      hash?: string
      signal?: AbortSignal
    }) {
      const settings = (yield* config.get()).verification
      const changed = [...new Set(input.changed.map((file) => file.replaceAll("\\", "/")))].sort()
      const base = {
        changed_files: changed,
        packages: [] as string[],
        checks: [] as Check[],
        unrelated_change_warning: [] as string[],
        snapshot_or_diff_ref: input.hash,
        generated_at: Date.now(),
      }
      if (settings?.enabled === false) {
        return { ...base, status: "not_run" as const, not_run_reason: "verification disabled by config" }
      }
      if (changed.length === 0) {
        return { ...base, status: "not_run" as const, not_run_reason: "no changed files in this turn" }
      }

      const protectedHits = changed.filter((file) =>
        (settings?.protected_paths ?? []).some((prefix) => {
          const normalized = prefix.replaceAll("\\", "/").replace(/\/+$/, "")
          return file === normalized || file.startsWith(`${normalized}/`)
        }),
      )

      // 受影响包：同一目录只算一次；路径按 worktree 相对形式展示。
      const dirs: string[] = []
      yield* Effect.forEach(changed, (file) =>
        packageOf(input.worktree, file).pipe(
          Effect.map((dir) => {
            if (dir && !dirs.includes(dir)) dirs.push(dir)
          }),
        ),
      )
      const disabled = new Set(settings?.disabled_scripts ?? [])

      const planned: { name: string; command: string; cwd: string }[] = []
      for (const dir of dirs) {
        const scripts = (yield* readScripts(dir)).scripts ?? {}
        for (const name of AUTO_SCRIPTS) {
          if (!scripts[name] || disabled.has(name)) continue
          const runner = yield* runnerOf(input.worktree, dir)
          planned.push({ name, command: `${runner} run ${name}`, cwd: dir })
        }
      }
      for (const extra of settings?.commands ?? []) {
        planned.push({
          name: extra.name,
          command: extra.command,
          cwd: extra.cwd ? path.resolve(input.worktree, extra.cwd) : input.worktree,
        })
      }

      const maxChecks = settings?.max_checks ?? DEFAULT_MAX_CHECKS
      const timeout = settings?.timeout_ms ?? DEFAULT_TIMEOUT_MS
      const seen = new Set<string>()
      const selection = planned
        .filter((item) => {
          const key = `${item.cwd}\u0000${item.command}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        .slice(0, maxChecks)

      if (selection.length === 0) {
        return {
          ...base,
          packages: dirs.map((dir) => displayCwd(input.worktree, dir)),
          status: "not_run" as const,
          not_run_reason:
            dirs.length === 0
              ? "no package.json found for the changed files"
              : `no verification script matched (auto: ${AUTO_SCRIPTS.join(", ")}; disabled: ${[...disabled].join(", ") || "none"})`,
          unrelated_change_warning: protectedHits,
        }
      }

      // 逐条串行：验证发生在回合末尾，并发跑多个检查只会和用户的下一条消息抢资源。
      const checks: Check[] = []
      for (const item of selection) {
        const cwd = displayCwd(input.worktree, item.cwd)
        const allowed = yield* permission
          .ask({
            sessionID: input.sessionID,
            permission: "bash",
            patterns: [item.command],
            always: [item.command],
            metadata: { verification: item.name },
            ruleset: input.ruleset,
          })
          .pipe(
            Effect.as(true as const),
            Effect.catch(() => {
              Log.Default.warn(`verification check skipped by permission: ${item.name}`)
              return Effect.succeed(false as const)
            }),
          )
        if (!allowed) {
          checks.push({
            name: item.name,
            command: item.command,
            cwd,
            status: "skipped",
            reason: "permission denied by ruleset or user",
          })
          continue
        }

        const [bin, ...args] = item.command.trim().split(/\s+/)
        const started = Date.now()
        const result = yield* appProcess
          .run(ChildProcess.make(bin!, args, { cwd: item.cwd, extendEnv: true }), {
            timeout,
            maxOutputBytes: 32 * 1024,
            maxErrorBytes: 32 * 1024,
            signal: input.signal,
          })
          .pipe(
            Effect.map((value) => ({ ok: true as const, value })),
            Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
          )
        const duration = Date.now() - started
        if (!result.ok) {
          checks.push({
            name: item.name,
            command: item.command,
            cwd,
            status: "failed",
            duration_ms: duration,
            reason: truncate(
              AppProcess.isTimeout(result.error) ? `timed out after ${timeout}ms` : String(result.error),
              MAX_REASON_CHARS,
            ),
          })
          continue
        }
        checks.push({
          name: item.name,
          command: item.command,
          cwd,
          status: result.value.exitCode === 0 ? "passed" : "failed",
          exit_code: result.value.exitCode,
          duration_ms: duration,
          ...(result.value.exitCode === 0
            ? {}
            : {
                reason: truncate(
                  result.value.stderr.toString("utf8").trim() ||
                    result.value.stdout.toString("utf8").trim() ||
                    `exit ${result.value.exitCode}`,
                  MAX_REASON_CHARS,
                ),
              }),
        })
      }

      const status = checks.every((item) => item.status === "passed")
        ? ("passed" as const)
        : checks.some((item) => item.status === "failed")
          ? ("failed" as const)
          : ("partial" as const)
      if (status === "failed") {
        Log.Default.warn(
          `verification failed: ${checks
            .filter((item) => item.status === "failed")
            .map((item) => item.name)
            .join(", ")}`,
        )
      }
      return {
        ...base,
        packages: dirs.map((dir) => displayCwd(input.worktree, dir)),
        checks,
        status,
        unrelated_change_warning: protectedHits,
      }
    })

    // 261109 Karina 正文有界：改动列表最多 10 条、失败原因 300 字符。报告作为
    // assistant 的可见 text part 落库，与 appendNotice 同路径——下一轮模型也会看到。
    const render = (value: Report) => {
      const files =
        value.changed_files.length <= MAX_LISTED_FILES
          ? value.changed_files.join(", ")
          : `${value.changed_files.slice(0, MAX_LISTED_FILES).join(", ")} 等 ${value.changed_files.length} 个`
      const lines = [`交付验证：${value.status}`]
      if (value.changed_files.length > 0) lines.push(`改动文件（${value.changed_files.length}）：${files}`)
      for (const check of value.checks) {
        const parts = [check.name, check.cwd === "." ? undefined : check.cwd, check.status]
        if (check.exit_code !== undefined) parts.push(`exit ${check.exit_code}`)
        if (check.duration_ms !== undefined) parts.push(`${(check.duration_ms / 1000).toFixed(1)}s`)
        if (check.reason) parts.push(`— ${check.reason}`)
        lines.push(`- ${parts.filter((item): item is string => Boolean(item)).join(" · ")}`)
      }
      if (value.unrelated_change_warning.length > 0) {
        lines.push(`受保护路径被改动：${value.unrelated_change_warning.join(", ")}`)
      }
      if (value.not_run_reason) lines.push(`未运行原因：${value.not_run_reason}`)
      return capBytes(lines.join("\n"), MAX_REPORT_BYTES)
    }

    return Service.of({ report, render })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(AppProcess.defaultLayer),
  Layer.provide(Permission.defaultLayer),
)

export * as SessionVerification from "./verification"
