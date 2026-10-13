import { readFileSync } from "node:fs"
import { join } from "node:path"

// 261013 Red Source budget only; never truncate descriptions at runtime.
// Decision: docs/notes/implemented/architecture/2026-10-13-tool-description-scope-review.md
export const MAX_TOOL_DESCRIPTION_BYTES = 32 * 1024

export function checkToolDescriptionBudget(directory: string) {
  const files = [...new Bun.Glob("**/*.md").scanSync({ cwd: directory, onlyFiles: true })].sort()
  if (files.length === 0) {
    throw new Error(`check-tool-description-budget: no descriptions found in ${directory}`)
  }

  const bytes = files.reduce((total, file) => total + readFileSync(join(directory, file)).byteLength, 0)
  if (bytes > MAX_TOOL_DESCRIPTION_BYTES) {
    throw new Error(
      `check-tool-description-budget: ${files.length} files use ${bytes}/${MAX_TOOL_DESCRIPTION_BYTES} bytes ` +
        `(over by ${bytes - MAX_TOOL_DESCRIPTION_BYTES}). Shorten descriptions or explicitly review the budget.`,
    )
  }
  return { files: files.length, bytes, remaining: MAX_TOOL_DESCRIPTION_BYTES - bytes }
}

if (import.meta.main) {
  const result = checkToolDescriptionBudget(join(import.meta.dir, "../packages/opencode/src/tool"))
  console.log(
    `check-tool-description-budget: ${result.files} files, ${result.bytes}/${MAX_TOOL_DESCRIPTION_BYTES} bytes ` +
      `(${result.remaining} bytes remaining)`,
  )
}
