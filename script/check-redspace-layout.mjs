#!/usr/bin/env node
// RedSpace core-layout safety check. No network access or dependencies required.
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL("..", import.meta.url)))
const required = [
  "packages/redspace/src/index.ts",
  "packages/redspace/package.json",
  "packages/desktop/electron.vite.config.ts",
  "script/entry-graph-budgets.json",
  "bun.lock",
]
const errors = []
for (const path of required) if (!existsSync(join(root, path))) errors.push(`Missing ${path}`)
if (existsSync(join(root, "packages/opencode"))) errors.push("Old packages/opencode directory still exists")

const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const corePackage = JSON.parse(readFileSync(join(root, "packages/redspace/package.json"), "utf8"))
if (!rootPackage.scripts?.dev?.includes("packages/redspace")) errors.push("TUI dev script still points elsewhere")
if (!rootPackage.scripts?.["gen:openapi"]?.includes("packages/redspace"))
  errors.push("OpenAPI generation script still points elsewhere")
if (corePackage.bin?.redcode !== "./bin/redcode" || corePackage.bin?.redspace !== "./bin/redcode")
  errors.push("Missing redcode compatibility or redspace CLI alias")

const ignores = new Set(["node_modules", ".git", ".artifacts", "dist", "out", "build", "docs", "migration"])
const extensions = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonc|toml|ya?ml|sh|bat|ps1)$/
const oldPath = /packages[\\/]opencode|\.\.[\\/]opencode(?=[\\/])/i
const roots = ["script", "packages", ".github"]
for (const folder of roots) {
  if (!existsSync(join(root, folder))) continue
  const pending = [join(root, folder)]
  while (pending.length) {
    const here = pending.pop()
    for (const item of readdirSync(here, { withFileTypes: true })) {
      const abs = join(here, item.name)
      if (item.isDirectory()) {
        if (!ignores.has(item.name)) pending.push(abs)
        continue
      }
      if (!item.isFile() || !extensions.test(item.name)) continue
      // This checker necessarily names the forbidden paths itself.
      if (item.name === "check-redspace-layout.mjs") continue
      const rel = relative(root, abs).replaceAll("\\", "/")
      const data = readFileSync(abs, "utf8")
      if (oldPath.test(data)) errors.push(`Stale source path: ${rel}`)
    }
  }
}
if (errors.length) {
  console.error("RedSpace core layout check failed:\n" + errors.map(x => " - " + x).join("\n"))
  process.exitCode = 1
} else {
  console.log("RedSpace core layout OK (paths, CLI compatibility, source references)")
}
