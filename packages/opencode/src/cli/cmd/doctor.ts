import { Effect } from "effect"
import { effectCmd, CliError } from "../effect-cmd"
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

interface Check {
  name: string
  status: "ok" | "warn" | "error"
  detail: string
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
    const checks: Check[] = []

    // 1. Version
    checks.push({
      name: "version",
      status: "ok" as const,
      detail: `${InstallationVersion}${Installation.isLocal() ? " (local)" : ""}`,
    })

    // 2. Config
    let cfg
    try {
      const config = yield* Config.Service
      cfg = yield* config.get()
      checks.push({ name: "config", status: "ok" as const, detail: "loaded" })
    } catch (error) {
      checks.push({ name: "config", status: "error" as const, detail: errorMessage(error) })
    }

    // 3. agents-md
    const worktree = process.cwd()
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
    checks.push({
      name: "agents-md",
      status: instructionFiles.length > 0 ? "ok" : "warn",
      detail: instructionFiles.length > 0 ? instructionFiles.join(", ") : "no instruction files",
    })

    if (cfg) {
      // 4. Providers
      try {
        const modelsDev = yield* ModelsDev.Service
        const database = yield* modelsDev.get()
        const auth = yield* Auth.Service
        const credentials = yield* auth.all().pipe(
          Effect.catch((error) =>
            Effect.fail(new CliError({ message: errorMessage(error) })),
          ),
        )

        const enabledProviders = cfg.enabled_providers ? new Set(cfg.enabled_providers) : undefined
        const disabledProviders = new Set(cfg.disabled_providers ?? [])
        const allProviderIds = Object.keys(database)
        const enabled = allProviderIds.filter((id) =>
          (enabledProviders ? enabledProviders.has(id) : true) && !disabledProviders.has(id),
        )
        const disabled = allProviderIds.filter((id) => disabledProviders.has(id))
        const withAuth = enabled.filter((id) => credentials[id])
        const withoutAuth = enabled.filter((id) => !credentials[id])
        const totalModels = enabled.reduce((sum, id) => sum + Object.keys(database[id].models ?? {}).length, 0)

        checks.push({
          name: "providers",
          status: withoutAuth.length > 0 && enabled.length > 0 ? "warn" : "ok",
          detail: `${enabled.length} enabled, ${disabled.length} disabled, ${withAuth.length} auth, ${totalModels} models`,
        })
      } catch (error) {
        checks.push({ name: "providers", status: "error", detail: errorMessage(error) })
      }

      // 5. api-key-leak
      const plaintextKeys = Object.entries(cfg.provider ?? {}).filter(([, p]) => {
        const key = p.options?.apiKey
        return typeof key === "string" && key.length > 8 && key !== "public" && !key.startsWith("redcode-")
      })
      checks.push({
        name: "api-key-leak",
        status: plaintextKeys.length === 0 ? "ok" : "warn",
        detail: plaintextKeys.length === 0 ? "no plaintext keys" : `${plaintextKeys.length} plaintext key(s) in config`,
      })

      // 6. Plugins
      try {
        const plugin = yield* Plugin.Service
        const plugins = yield* plugin.list()
        checks.push({
          name: "plugins",
          status: "ok",
          detail: `${plugins.length} hooks loaded`,
        })
      } catch (error) {
        checks.push({ name: "plugins", status: "warn", detail: `not loaded: ${errorMessage(error)}` })
      }

      // 7. skill-coverage
      const countSkillsInDir = (dir: string): number => {
        if (!fs.existsSync(dir)) return 0
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        return entries.filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "SKILL.md"))).length
      }
      // 260805 Red 补 .redcode/skill(s)：配置发现链只认 .redcode，
      // 项目级技能装在那儿，原本一个都统计不到
      const projectSkillCount = worktree
        ? countSkillsInDir(path.join(worktree, ".redcode", "skills")) +
          countSkillsInDir(path.join(worktree, ".redcode", "skill")) +
          countSkillsInDir(path.join(worktree, ".opencode", "skills")) +
          countSkillsInDir(path.join(worktree, ".opencode", "skill"))
        : 0
      const globalSkillCount = countSkillsInDir(path.join(Global.Path.home, ".redcode", "skill"))
      const totalSkillCount = projectSkillCount + globalSkillCount
      checks.push({
        name: "skill-coverage",
        status: totalSkillCount > 0 ? "ok" : "warn",
        detail: `${totalSkillCount} skills (${projectSkillCount} project, ${globalSkillCount} global)`,
      })

      // 8. MCP
      try {
        const mcp = yield* MCP.Service
        const statuses = yield* mcp.status()
        const connected = Object.values(statuses).filter((s) => s.status === "connected").length
        const total = Object.keys(statuses).length
        checks.push({
          name: "mcp",
          status: total > 0 ? (connected === total ? "ok" : "warn") : "warn",
          detail: total > 0 ? `${connected}/${total} connected` : "no servers configured",
        })
      } catch (error) {
        checks.push({ name: "mcp", status: "error", detail: errorMessage(error) })
      }
    }

    // 9. Database
    try {
      const dbPath = path.join(Global.Path.data, "redcode.db")
      const exists = fs.existsSync(dbPath)
      checks.push({
        name: "database",
        status: exists ? "ok" : "warn",
        detail: exists ? "exists" : "not found (will be created on first run)",
      })
    } catch (error) {
      checks.push({ name: "database", status: "error", detail: errorMessage(error) })
    }

    if (args.json) {
      yield* Console.log(JSON.stringify(checks, null, 2))
      return
    }

    const width = 56
    const renderRow = (label: string, value: string): string => {
      const availableWidth = width - 1
      const paddingNeeded = availableWidth - label.length - value.length
      const padding = Math.max(0, paddingNeeded)
      return `│${label}${" ".repeat(padding)}${value} │`
    }

    yield* Console.log("┌────────────────────────────────────────────────────────┐")
    yield* Console.log("│                    REDCODE DOCTOR                      │")
    yield* Console.log("├────────────────────────────────────────────────────────┤")
    for (const check of checks) {
      const icon = check.status === "ok" ? "✓" : check.status === "warn" ? "!" : "✗"
      yield* Console.log(renderRow(`${icon} ${check.name}`, check.detail))
    }
    yield* Console.log("└────────────────────────────────────────────────────────┘")
  }),
})
