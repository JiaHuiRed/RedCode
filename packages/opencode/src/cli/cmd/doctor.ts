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

    if (cfg) {
      // 3. Providers
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
        const availableCount = Object.entries(database).filter(([id]) =>
          (enabledProviders ? enabledProviders.has(id) : true) && !disabledProviders.has(id),
        ).length

        checks.push({
          name: "providers",
          status: "ok",
          detail: `${availableCount} available, ${Object.keys(credentials).length} logged in`,
        })
      } catch (error) {
        checks.push({ name: "providers", status: "error", detail: errorMessage(error) })
      }

      // 4. Plugins
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

      // 5. MCP
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

    // 6. Database
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
      Console.log(JSON.stringify(checks, null, 2))
      return
    }

    const width = 56
    const renderRow = (label: string, value: string): string => {
      const availableWidth = width - 1
      const paddingNeeded = availableWidth - label.length - value.length
      const padding = Math.max(0, paddingNeeded)
      return `│${label}${" ".repeat(padding)}${value} │`
    }

    Console.log("┌────────────────────────────────────────────────────────┐")
    Console.log("│                    REDCODE DOCTOR                      │")
    Console.log("├────────────────────────────────────────────────────────┤")
    for (const check of checks) {
      const icon = check.status === "ok" ? "✓" : check.status === "warn" ? "!" : "✗"
      Console.log(renderRow(`${icon} ${check.name}`, check.detail))
    }
    Console.log("└────────────────────────────────────────────────────────┘")
  }),
})
