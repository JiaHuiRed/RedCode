import { tool } from "@redcode-ai/plugin/tool"
import { execSync } from "child_process"

// 260603 Red ECC plugin · shell.env + changed-files + compacting + permission + git-summary
export default {
  id: "ecc-stub",
  server: async (input) => {
    const worktreePath = input.worktree || input.directory
    const editedFiles = new Map()

    return {
      "shell.env": async (_input, output) => {
        output.env = {
          ...output.env,
          ECC_VERSION: "1.0.0-stub",
          ECC_ACTIVE: "true",
          PROJECT_ROOT: worktreePath,
        }
      },

      "tool.execute.after": async (input) => {
        const args = input.args || {}
        const filePath =
          typeof args.filePath === "string"
            ? args.filePath
            : typeof args.file_path === "string"
              ? args.file_path
              : typeof args.path === "string"
                ? args.path
                : undefined
        if (!filePath) return
        editedFiles.set(filePath, "modified")
      },

      "experimental.session.compacting": async (_input, output) => {
        output.context = [
          "# ECC Stub · context to preserve across compaction",
          `- Active plugin: ecc-stub (worktree: ${worktreePath})`,
          `- Changed files: ${editedFiles.size} file(s)`,
        ]
        if (editedFiles.size > 0) {
          output.context.push("- Recently edited:")
          for (const [f] of editedFiles) {
            output.context.push(`  - ${f}`)
          }
        }
        output.prompt =
          "Preserve: current task status, key decisions, changed files, remaining work. Discard: verbose tool output, intermediate exploration, redundant listings."
      },

      "permission.ask": async (input, output) => {
        const cmd = typeof input.metadata?.command === "string" ? input.metadata.command : ""
        if (["read", "glob", "grep", "search", "list"].includes(input.type)) {
          output.status = "allow"
        } else if (cmd && /^(npx )?(prettier|biome|black|gofmt|rustfmt)/.test(cmd)) {
          output.status = "allow"
        } else if (cmd && /^(npm test|npx vitest|npx jest|pytest|go test|cargo test)/.test(cmd)) {
          output.status = "allow"
        }
      },

      tool: {
        "changed-files": tool({
          description: "List files changed in this session. Shows added, modified, and deleted.",
          args: {
            filter: tool.schema
              .enum(["all", "added", "modified", "deleted"])
              .optional()
              .describe("Filter by change type (default: all)"),
          },
          async execute(args) {
            if (editedFiles.size === 0) {
              return JSON.stringify({ changed: false })
            }
            const filter = args.filter === "all" || !args.filter ? undefined : args.filter
            const files = Array.from(editedFiles.entries())
              .filter(([_, type]) => !filter || type === filter)
              .map(([p, t]) => ({ path: p, changeType: t }))
            return JSON.stringify({ changed: true, files })
          },
        }),

        "git-summary": tool({
          description: "Git summary: branch, status, recent commits, and optional diff.",
          args: {
            depth: tool.schema.number().optional().describe("Recent commits to show (default: 5)"),
            diff: tool.schema.boolean().optional().describe("Include diff stats (default: true)"),
          },
          async execute(args) {
            const depth = args.depth ?? 5
            const result = {
              branch: run("git branch --show-current", worktreePath),
              status: run("git status --short", worktreePath),
              log: run(`git log --oneline -${depth}`, worktreePath),
            }
            if (args.diff !== false) {
              result["diff:staged"] = run("git diff --cached --stat", worktreePath)
              result["diff:branch"] = run(
                `git diff ${result.branch || "main"} --stat 2>/dev/null; true`,
                worktreePath
              )
            }
            return JSON.stringify(result, null, 2)
          },
        }),
      },
    }
  },
}

function run(command, cwd) {
  try {
    return execSync(command, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 10000 }).trim()
  } catch {
    return ""
  }
}
