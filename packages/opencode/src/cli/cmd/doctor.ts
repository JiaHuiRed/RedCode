import { Cause, Effect, Exit } from "effect"
import { effectCmd, fail } from "../effect-cmd"
import { Config } from "@/config/config"
import { Auth } from "@/auth"
import { Plugin } from "@/plugin"
import { MCP } from "@/mcp"
import { ModelsDev } from "@redcode-ai/core/models-dev"
import { Global } from "@redcode-ai/core/global"
import { Installation } from "@/installation"
import { InstallationVersion } from "@redcode-ai/core/installation/version"
import * as Console from "effect/Console"
import * as fs from "node:fs"
import path from "node:path"
import { errorMessage } from "@/util/error"

type Status = "ok" | "warn" | "error" | "skip"

interface Check {
  name: string
  status: Status
  detail: string
}

interface Group {
  name: string
  checks: Check[]
}

// 组级状态取组内最坏的一条。skip 排在 ok 之后、warn 之前：它不是故障，但也不是
// “查过了没问题”，必须和真正通过的检查区分开。
const RANK: Record<Status, number> = { ok: 0, skip: 1, warn: 2, error: 3 }

function groupStatus(checks: Check[]): Status {
  return checks.reduce<Status>((worst, c) => (RANK[c.status] > RANK[worst] ? c.status : worst), "ok")
}

const ICON: Record<Status, string> = { ok: "✓", warn: "!", error: "✗", skip: "-" }

/**
 * 把一个可能失败的 Effect 收成一条 Check。
 *
 * 260821 cc：这里原来是 try { yield* ... } catch，四处（config / providers /
 * plugins / mcp）都是。那是**无效**的 —— Effect 的失败走错误通道，不会变成 JS
 * 异常。实测 yield* Effect.fail(...) 与 yield* Effect.sync(() => { throw }) 都
 * 不进 catch 块，只有生成器体里的纯 JS throw 会。
 *
 * 后果是反的：代码看起来实现了优雅降级，实际上任何一个检查失败会直接杀掉整条
 * 诊断，一条结果都拿不到 —— 而 doctor 恰恰是“东西坏了才跑”的命令，最需要它在
 * 部分失败时还能报出其余部分。所以必须用 Effect.exit 显式接住。
 */
function attempt<A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
  onSuccess: (value: A) => Check,
): Effect.Effect<Check, never, R> {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (Exit.isSuccess(exit)) return onSuccess(exit.value)
    return { name, status: "error", detail: errorMessage(Cause.squash(exit.cause)) }
  })
}

/** 依赖项没就位时，被跳过的检查要显式留在输出里 —— 静默消失比报错更难查。 */
function skipped(names: string[], why: string): Check[] {
  return names.map((name) => ({ name, status: "skip" as const, detail: why }))
}

export const DoctorCommand = effectCmd({
  command: "doctor",
  describe: "run diagnostics",
  builder: (yargs) =>
    yargs.option("json", {
      describe: "output as json",
      type: "boolean",
    }),
  // Diagnostics should work without a full project instance; avoids bootstrap hang.
  instance: false,
  handler: Effect.fn("Cli.doctor")(function* (args) {
    const worktree = process.cwd()
    const groups: Group[] = []

    // ---- runtime ----
    const dbPath = path.join(Global.Path.data, "redcode.db")
    const dbExists = fs.existsSync(dbPath)
    groups.push({
      name: "runtime",
      checks: [
        {
          name: "version",
          status: "ok",
          // InstallationVersion 在本地构建里本身就是 "local"，再追加一次会打印成
          // "local (local)"。只在两者不同时才加后缀。
          detail:
            Installation.isLocal() && InstallationVersion !== "local"
              ? `${InstallationVersion} (local)`
              : InstallationVersion,
        },
        {
          name: "database",
          status: dbExists ? "ok" : "warn",
          detail: dbExists ? "exists" : "not found (will be created on first run)",
        },
      ],
    })

    // ---- config ----
    const configExit = yield* Effect.exit(
      Effect.gen(function* () {
        const config = yield* Config.Service
        return yield* config.get()
      }),
    )
    const cfg = Exit.isSuccess(configExit) ? configExit.value : undefined

    const instructionFiles: string[] = []
    if (fs.existsSync(path.join(Global.Path.home, ".redcode", "MEMORY.md"))) {
      instructionFiles.push("global memory")
    }
    // 260805 Red 补 .redcode/ 与项目根的 AGENTS.md：原本只看 .opencode/，
    // 现在的项目多半根本没这个目录，诊断恒报 "no instruction files"
    if (
      fs.existsSync(path.join(worktree, "AGENTS.md")) ||
      fs.existsSync(path.join(worktree, ".redcode", "AGENTS.md")) ||
      fs.existsSync(path.join(worktree, ".opencode", "AGENTS.md"))
    ) {
      instructionFiles.push("AGENTS.md")
    }
    if (fs.existsSync(path.join(worktree, ".redcode", "MEMORY.md"))) {
      instructionFiles.push("project memory")
    }

    groups.push({
      name: "config",
      checks: [
        Exit.isSuccess(configExit)
          ? { name: "config", status: "ok", detail: "loaded" }
          : { name: "config", status: "error", detail: errorMessage(Cause.squash(configExit.cause)) },
        {
          name: "agents-md",
          status: instructionFiles.length > 0 ? "ok" : "warn",
          detail: instructionFiles.length > 0 ? instructionFiles.join(", ") : "no instruction files",
        },
      ],
    })

    const NO_CONFIG = "skipped: config not loaded"

    // ---- providers ----
    if (cfg) {
      const providers = yield* attempt(
        "providers",
        Effect.gen(function* () {
          const modelsDev = yield* ModelsDev.Service
          const database = yield* modelsDev.get()
          const auth = yield* Auth.Service
          const credentials = yield* auth.all()

          const enabledProviders = cfg.enabled_providers ? new Set(cfg.enabled_providers) : undefined
          const disabledProviders = new Set(cfg.disabled_providers ?? [])
          const allProviderIds = Object.keys(database)
          const enabled = allProviderIds.filter(
            (id) => (enabledProviders ? enabledProviders.has(id) : true) && !disabledProviders.has(id),
          )
          const disabled = allProviderIds.filter((id) => disabledProviders.has(id))
          const withAuth = enabled.filter((id) => credentials[id])
          const withoutAuth = enabled.filter((id) => !credentials[id])
          const models = enabled.reduce((sum, id) => sum + Object.keys(database[id].models ?? {}).length, 0)
          return { enabled, disabled, withAuth, withoutAuth, models }
        }),
        (r) => ({
          name: "providers",
          status: r.withoutAuth.length > 0 && r.enabled.length > 0 ? "warn" : "ok",
          detail: `${r.enabled.length} on, ${r.disabled.length} off, ${r.withAuth.length} auth, ${r.models} models`,
        }),
      )

      const plaintextKeys = Object.entries(cfg.provider ?? {}).filter(([, p]) => {
        const key = p.options?.apiKey
        return typeof key === "string" && key.length > 8 && key !== "public" && !key.startsWith("redcode-")
      })

      groups.push({
        name: "providers",
        checks: [
          providers,
          {
            name: "api-key-leak",
            status: plaintextKeys.length === 0 ? "ok" : "warn",
            detail:
              plaintextKeys.length === 0 ? "no plaintext keys" : `${plaintextKeys.length} plaintext key(s) in config`,
          },
        ],
      })
    } else {
      groups.push({ name: "providers", checks: skipped(["providers", "api-key-leak"], NO_CONFIG) })
    }

    // ---- extensions ----
    if (cfg) {
      const plugins = yield* attempt(
        "plugins",
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          return yield* plugin.list()
        }),
        (list) => ({ name: "plugins", status: "ok", detail: `${list.length} hooks loaded` }),
      )

      const countSkillsInDir = (dir: string): number => {
        if (!fs.existsSync(dir)) return 0
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        return entries.filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "SKILL.md"))).length
      }
      // 260805 Red 补 .redcode/skill(s)：配置发现链只认 .redcode，
      // 项目级技能装在那儿，原本一个都统计不到
      const projectSkills =
        countSkillsInDir(path.join(worktree, ".redcode", "skills")) +
        countSkillsInDir(path.join(worktree, ".redcode", "skill")) +
        countSkillsInDir(path.join(worktree, ".opencode", "skills")) +
        countSkillsInDir(path.join(worktree, ".opencode", "skill"))
      const globalSkills = countSkillsInDir(path.join(Global.Path.home, ".redcode", "skill"))
      const totalSkills = projectSkills + globalSkills

      const mcp = yield* attempt(
        "mcp",
        Effect.gen(function* () {
          const svc = yield* MCP.Service
          return yield* svc.status()
        }),
        (statuses) => {
          const connected = Object.values(statuses).filter((s) => s.status === "connected").length
          const total = Object.keys(statuses).length
          return {
            name: "mcp",
            status: total > 0 ? (connected === total ? "ok" : "warn") : "warn",
            detail: total > 0 ? `${connected}/${total} connected` : "no servers configured",
          }
        },
      )

      groups.push({
        name: "extensions",
        checks: [
          plugins,
          {
            name: "skill-coverage",
            status: totalSkills > 0 ? "ok" : "warn",
            detail: `${totalSkills} skills (${projectSkills} project, ${globalSkills} global)`,
          },
          mcp,
        ],
      })
    } else {
      groups.push({ name: "extensions", checks: skipped(["plugins", "skill-coverage", "mcp"], NO_CONFIG) })
    }

    const all = groups.flatMap((g) => g.checks)
    const tally = {
      ok: all.filter((c) => c.status === "ok").length,
      warn: all.filter((c) => c.status === "warn").length,
      error: all.filter((c) => c.status === "error").length,
      skip: all.filter((c) => c.status === "skip").length,
    }

    if (args.json) {
      yield* Console.log(
        JSON.stringify(
          { groups: groups.map((g) => ({ ...g, status: groupStatus(g.checks) })), tally, checks: all },
          null,
          2,
        ),
      )
    } else {
      // 框内可用宽度。边框按它生成，不再手写死一串 ─，改宽度时不会对不齐。
      const WIDTH = 56
      const bar = (l: string, r: string) => `${l}${"─".repeat(WIDTH)}${r}`
      const clamp = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`)

      // 左右两段之间永远至少留一个空格。原来的实现把 padding 压到 0 就直接粘死，
      // 真实输出里 providers 那行就是 "! providers190 enabled, ..."，读不出边界。
      // detail 可能是多行的 —— JSONC 解析错误会带上 "--- JSONC Input ---" 和原文，
      // 直接塞进表格会把框撑破（实测：config 报错那行把边框顶掉了两行）。表格里先把
      // 空白折成单空格再截断；--json 走的是另一条路，保留完整多行原文。
      const oneLine = (s: string) => s.replace(/\s+/g, " ").trim()
      // 左右各留一格边距、中间至少一格分隔，全部由 row 自己保证 —— 调用方不传
      // 补空格，否则 oneLine 的 trim 会把它吃掉，值直接贴到边框上。
      const row = (left: string, right: string) => {
        const l = clamp(left, WIDTH - 4)
        const r = clamp(oneLine(right), WIDTH - l.length - 3)
        return `│ ${l}${" ".repeat(WIDTH - 2 - l.length - r.length)}${r} │`
      }
      const center = (text: string) => {
        const t = clamp(text, WIDTH)
        const left = Math.floor((WIDTH - t.length) / 2)
        return `│${" ".repeat(left)}${t}${" ".repeat(WIDTH - left - t.length)}│`
      }

      yield* Console.log(bar("┌", "┐"))
      yield* Console.log(center("REDCODE DOCTOR"))
      for (const group of groups) {
        yield* Console.log(bar("├", "┤"))
        yield* Console.log(row(group.name, ICON[groupStatus(group.checks)]))
        for (const check of group.checks) {
          yield* Console.log(row(`  ${ICON[check.status]} ${check.name}`, check.detail))
        }
      }
      yield* Console.log(bar("├", "┤"))
      yield* Console.log(
        row(`${all.length} checks`, `${tally.ok} ok · ${tally.warn} warn · ${tally.error} error · ${tally.skip} skip`),
      )
      yield* Console.log(bar("└", "┘"))
    }

    // 退出码：只有 error 才算失败，warn 是提示。没有这一条的话
    // `redcode doctor && deploy` 完全没有保护 —— 之前无论多少 error 都返回 0。
    if (tally.error > 0) {
      yield* fail(`doctor found ${tally.error} error(s)`)
    }
  }),
})
