import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Git } from "@/git"
import { InstanceState } from "@/effect/instance-state"
import DESCRIPTION from "./git.md"

export const Parameters = Schema.Struct({
  operation: Schema.Literals(["status", "diff", "log", "show", "branch", "stash_list"]).annotate({
    description:
      "Which git operation to run: status (working tree), diff (vs ref), log (history), show (file at ref), branch (current), stash_list (stashes)",
  }),
  ref: Schema.optional(Schema.String).annotate({
    description: "Reference for diff/show (default: HEAD). Examples: HEAD, main, dev, HEAD~3",
  }),
  path: Schema.optional(Schema.String).annotate({
    description: "File path for show/diff operations. Relative to repository root.",
  }),
  maxCount: Schema.optional(Schema.Number).annotate({
    description: "Max log entries to return (default: 10, max: 100)",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

function formatGitItem(item: { file: string; status: Git.Kind }): string {
  const icon =
    item.status === "added" ? "+" :
    item.status === "deleted" ? "-" :
    item.status === "modified" ? "M" : "?"
  return `  ${icon} ${item.file}`
}

export const GitTool = Tool.define(
  "git",
  Effect.gen(function* () {
    const git = yield* Git.Service

    const execute = (params: Params, ctx: Tool.Context): Effect.Effect<Tool.ExecuteResult> =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        const cwd = instance.directory

        if (params.operation === "status") {
          const items = yield* git.status(cwd)
          const branch = yield* git.branch(cwd)
          const staged = items.filter((i) => i.code[0] !== " " && i.code[0] !== "?")
          const unstaged = items.filter((i) => i.code[1] !== " " && i.code[0] === " ")
          const untracked = items.filter((i) => i.code.startsWith("?"))
          const lines: string[] = []
          if (branch) lines.push(`On branch: ${branch}`)
          lines.push("")
          if (staged.length > 0) { lines.push("Changes staged for commit:"); for (const item of staged) lines.push(formatGitItem(item)); lines.push("") }
          if (unstaged.length > 0) { lines.push("Changes not staged:"); for (const item of unstaged) lines.push(formatGitItem(item)); lines.push("") }
          if (untracked.length > 0) { lines.push(`Untracked files (${untracked.length}):`); for (const item of untracked) lines.push(`  ? ${item.file}`); lines.push("") }
          if (items.length === 0) lines.push("Working tree clean (no changes)")
          return { title: "git status", metadata: { total: items.length, staged: staged.length, unstaged: unstaged.length, untracked: untracked.length }, output: lines.join("\n") }
        }

        if (params.operation === "diff") {
          const ref = params.ref ?? "HEAD"
          const patch = yield* git.patchAll(cwd, ref, { maxOutputBytes: 50_000 })
          const stats = yield* git.stats(cwd, ref)
          const lines: string[] = []
          if (stats.length > 0) {
            lines.push(`Diff against ${ref}:\n`)
            let totalAdd = 0; let totalDel = 0
            for (const s of stats) { totalAdd += s.additions; totalDel += s.deletions; lines.push(`  ${s.file} (+${s.additions}/-${s.deletions})`) }
            lines.push(`\nTotal: +${totalAdd}/-${totalDel} across ${stats.length} file(s)`)
          } else { lines.push(`No changes vs ${ref}`) }
          if (patch.text && !patch.truncated) { lines.push("\nPatch:"); lines.push(patch.text.slice(0, 8000)); if (patch.text.length > 8000) lines.push("\n...(patch truncated)") }
          return { title: `git diff ${ref}`, metadata: {}, output: lines.join("\n") }
        }

        if (params.operation === "log") {
          const maxCount = Math.min(params.maxCount ?? 10, 100)
          const result = yield* git.run(["log", `--max-count=${maxCount}`, "--format=%h %ai %an: %s", "--", "."], { cwd })
          return { title: `git log (${maxCount})`, metadata: {}, output: result.exitCode === 0 ? result.text() || "(empty history)" : `git log failed:\n${result.stderr.toString("utf8")}` }
        }

        if (params.operation === "show") {
          const ref = params.ref ?? "HEAD"
          if (!params.path) {
            const result = yield* git.run(["log", "--max-count=1", "--format=%H%n%ai%n%an <%ae>%n%s%n%b", ref, "--", "."], { cwd })
            return { title: `git show ${ref}`, metadata: {}, output: result.exitCode === 0 ? result.text() : `Commit not found: ${ref}` }
          }
          const content = yield* git.show(cwd, ref, params.path)
          if (!content) return { title: `git show ${ref}:${params.path}`, metadata: {}, output: `File not found at ${ref}:${params.path}` }
          return { title: `${params.path} at ${ref}`, metadata: {}, output: content }
        }

        if (params.operation === "branch") {
          const current = yield* git.branch(cwd)
          const def = yield* git.defaultBranch(cwd)
          const lines: string[] = []
          if (current) lines.push(`Current branch: ${current}`)
          if (def) lines.push(`Default branch: ${def.name}`)
          return { title: "git branch", metadata: {}, output: lines.length > 0 ? lines.join("\n") : "(detached HEAD)" }
        }

        if (params.operation === "stash_list") {
          const result = yield* git.run(["stash", "list", "--format=%gd: %gs"], { cwd })
          return { title: "git stash list", metadata: {}, output: result.exitCode === 0 ? result.text() || "(no stashes)" : `git stash list failed:\n${result.stderr.toString("utf8")}` }
        }

        return { title: "git", metadata: {}, output: `Unknown operation: ${params.operation}` }
      })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context) => execute(params, ctx).pipe(Effect.orDie),
    }
  }),
)
