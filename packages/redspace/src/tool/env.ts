import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import os from "os"
import DESCRIPTION from "./env.md" with { type: "text" }
import { InstanceState } from "@/effect/instance-state"

const Categories = Schema.Literals(["all", "platform", "paths", "memory", "cpu"])

export const Parameters = Schema.Struct({
  category: Schema.optional(Categories).annotate({
    description:
      "Category of env info: all (default, full dump), platform (OS/version/arch), paths (PATH/HOME etc), memory (RAM), cpu (cores/model)",
  }),
  vars: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Specific env var names to inspect (e.g. ['PATH', 'HOME', 'SHELL']). Overrides category.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

export const EnvTool = Tool.define(
  "env",
  Effect.gen(function* () {
    const execute = (params: Params, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult> =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context

        // 260810 cc audit R3: env 此前是全仓唯一无权限门的取值通道——vars 可直接回显
        // ANTHROPIC_API_KEY 等密钥进对话上下文，一次提示词注入即可完成外泄闭环；
        // category=paths 同样吐 PATH/HOME 等值。顶部单闸门罩住两个分支，按请求的
        // 变量名（或 category）出 pattern，agent 级 permission.env="deny" 从此真正生效。
        yield* ctx.ask({
          permission: "env",
          patterns: params.vars && params.vars.length > 0 ? [...params.vars] : [params.category ?? "all"],
          always: ["*"],
          metadata: {},
        })

        if (params.vars && params.vars.length > 0) {
          const lines: string[] = []
          for (const key of params.vars) {
            const val = process.env[key]
            lines.push(`${key}=${val !== undefined ? val : "(unset)"}`)
          }
          return { title: "env vars", metadata: {}, output: lines.join("\n") }
        }

        const category = params.category ?? "all"
        const sections: string[] = []

        if (category === "all" || category === "platform") {
          sections.push("=== Platform ===")
          sections.push(`platform:  ${process.platform}`)
          sections.push(`arch:      ${process.arch}`)
          sections.push(`release:   ${os.release()}`)
          sections.push(`hostname:  ${os.hostname()}`)
          sections.push(`cwd:       ${instance.directory}`)
          sections.push(`worktree:  ${instance.worktree}`)
          sections.push("")
        }

        if (category === "all" || category === "paths") {
          sections.push("=== Key Paths ===")
          const important = [
            "PATH",
            "HOME",
            "SHELL",
            "USER",
            "USERPROFILE",
            "TEMP",
            "TMP",
            "XDG_CONFIG_HOME",
            "LOCALAPPDATA",
          ]
          for (const key of important) {
            const val = process.env[key]
            if (val) sections.push(`${key}=${val}`)
          }
          sections.push("")
        }

        if (category === "all" || category === "memory") {
          const totalMem = os.totalmem()
          const freeMem = os.freemem()
          sections.push("=== Memory ===")
          sections.push(`total:  ${(totalMem / 1024 / 1024 / 1024).toFixed(1)} GB`)
          sections.push(
            `free:   ${(freeMem / 1024 / 1024 / 1024).toFixed(1)} GB (${((freeMem / totalMem) * 100).toFixed(0)}%)`,
          )
          sections.push("")
        }

        if (category === "all" || category === "cpu") {
          sections.push("=== CPU ===")
          sections.push(`cores:  ${os.cpus().length}`)
          sections.push(`model:  ${os.cpus()[0]?.model ?? "unknown"}`)
          sections.push(`uptime: ${(os.uptime() / 3600).toFixed(1)} hours`)
          sections.push("")
        }

        return { title: "env info", metadata: {}, output: sections.join("\n").trim() || "(no info)" }
      })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context) => execute(params, ctx).pipe(Effect.orDie),
    }
  }),
)
