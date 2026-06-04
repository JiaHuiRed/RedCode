import { tool } from "@redcode-ai/plugin/tool"
import { execSync } from "child_process"
import { readFileSync, readdirSync, existsSync } from "fs"
import { join } from "path"

// 260604 Red ECC stub v2 · memory-automation + guardrail-profiles + defensive-agent
export default {
  id: "ecc-stub",
  server: async (input) => {
    const worktreePath = input.worktree || input.directory
    const editedFiles = new Map()
    const profile = (process.env.ECC_PROFILE || "standard").toLowerCase()

    // --- memory helpers ---
    function readRecentMemory(dir) {
      const memoryDir = join(dir, ".opencode", "memory")
      if (!existsSync(memoryDir)) return []

      const files = readdirSync(memoryDir)
        .filter((f) => /^\d{6}\.md$/.test(f))
        .sort()
        .reverse()
        .slice(0, 3)

      return files.flatMap((f) => {
        try {
          const content = readFileSync(join(memoryDir, f), "utf-8")
          const date = f.slice(0, 6)
          const lines = content
            .split("\n")
            .filter((l) => l.includes("教训") || l.includes("教训") || l.includes("总结") || l.startsWith("-"))
            .slice(0, 5)
          return lines.map((l) => `[MEMORY ${date}] ${l.replace(/^[#*\-\s]+/, "")}`)
        } catch {
          return []
        }
      })
    }

    function readMemoryLong(dir) {
      const memoryFile = join(dir, ".opencode", "MEMORY.md")
      if (!existsSync(memoryFile)) return ""
      try {
        return readFileSync(memoryFile, "utf-8").split("\n").slice(0, 30).join("\n")
      } catch {
        return ""
      }
    }

    return {
      "shell.env": async (_input, output) => {
        const memoryLines = readRecentMemory(worktreePath)
        const longMemory = readMemoryLong(worktreePath)

        output.env = {
          ...output.env,
          ECC_VERSION: "2.0.0-stub",
          ECC_ACTIVE: "true",
          ECC_PROFILE: profile,
          PROJECT_ROOT: worktreePath,
          ...(memoryLines.length > 0 ? { ECC_MEMORY_RECENT: memoryLines.join(" | ") } : {}),
          ...(longMemory ? { ECC_MEMORY_LONG: longMemory.slice(0, 1500) } : {}),
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
          "# ECC Stub v2 · context preserved across compaction",
          `- Active plugin: ecc-stub (profile: ${profile})`,
          `- Changed files: ${editedFiles.size} file(s)`,
        ]
        if (editedFiles.size > 0) {
          output.context.push("- Recently edited:")
          for (const [f] of editedFiles) {
            output.context.push(`  - ${f}`)
          }
        }
        output.context.push(
          `- Guardrail profile: ${profile}`,
          "- Key principles: minimal edits, defensive design, memory persistence",
          "- Session goals: track current task, preserve decisions, keep error context",
        )
        output.prompt =
          "Preserve: 1) Current task status and progress, 2) Key decisions made, " +
          "3) Files created/modified with reasons, 4) Error messages that need attention, " +
          "5) Test results and coverage status, 6) Remaining work items. " +
          "Discard: verbose tool output, intermediate exploration, redundant file listings, " +
          "repeated error messages that have already been addressed."
      },

      "permission.ask": async (input, output) => {
        const cmd = typeof input.metadata?.command === "string" ? input.metadata.command : ""
        const type = input.type || ""

        // Read-only ops always allowed
        if (["read", "glob", "grep", "search", "list"].includes(type)) {
          output.status = "allow"
          return
        }

        // Profile-based guardrail
        if (profile === "minimal") {
          // Only block truly destructive ops
          if (cmd && /^(rm|del|rd|Remove-Item)\b/i.test(cmd)) {
            output.status = "ask" // never auto-allow deletion
            return
          }
          output.status = "allow"
          return
        }

        if (profile === "strict") {
          output.status = "ask" // everything needs approval
          return
        }

        // standard (default) — whitelist
        if (cmd && /^(npx )?(prettier|biome|black|gofmt|rustfmt)/.test(cmd)) {
          output.status = "allow"
        } else if (cmd && /^(npm test|npx vitest|npx jest|pytest|go test|cargo test)/.test(cmd)) {
          output.status = "allow"
        } else if (cmd && /^(git status|git diff|git log|git branch)/.test(cmd)) {
          output.status = "allow"
        } else if (type === "write" || type === "edit") {
          output.status = "allow" // edits are fine in standard
        } else {
          output.status = "ask"
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
