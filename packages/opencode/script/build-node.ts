#!/usr/bin/env bun
import { $ } from "bun"
import fs from "node:fs"
import path from "node:path"

const dir = path.resolve(import.meta.dirname, "..")
process.chdir(dir)

const pkg = await Bun.file("package.json").json()

const migrations = (
  await fs.promises.readdir(path.join(dir, "migration"), { withFileTypes: true })
)
  .filter((entry) => entry.isDirectory() && /^\d{14}/.test(entry.name))
  .sort((a, b) => a.name.localeCompare(b.name))

const migrationData = await Promise.all(
  migrations.map(async (entry) => {
    const file = path.join(dir, "migration", entry.name, "migration.sql")
    const sql = await Bun.file(file).text()
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(entry.name)
    const timestamp = match
      ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]))
      : 0
    return { sql, timestamp, name: entry.name }
  }),
)

console.log(`Loaded ${migrationData.length} migrations`)

const out = path.join(dir, "dist/node")
await $`rm -rf ${out}`
await $`mkdir -p ${out}`

const result = await Bun.build({
  entrypoints: ["./src/node.ts"],
  outdir: out,
  tsconfig: "./tsconfig.json",
  target: "node",
  format: "esm",
  conditions: ["node"],
  external: [
    "@lydell/node-pty*",
    "@parcel/watcher*",
    "better-sqlite3",
    "drizzle-orm/node-sqlite",
    "drizzle-orm/bun-sqlite",
    "jsonc-parser",
    "lightningcss",
    "redcode-web-ui.gen.ts",
  ],
  splitting: false,
  sourcemap: "linked",
  naming: "[name].[ext]",
  define: {
    REDCODE_VERSION: `'${pkg.version}'`,
    REDCODE_MIGRATIONS: JSON.stringify(migrationData),
  },
  root: dir,
})

if (!result.success) {
  console.error("Build failed:", result.logs)
  process.exit(1)
}

console.log("Built dist/node/node.js")

// Provide @parcel/watcher shim next to the bundle so the ESM import of
// @parcel/watcher/wrapper resolves without pulling in npm deps (micromatch etc).
const watcherDir = path.join(out, "node_modules/@parcel/watcher")
await fs.promises.mkdir(watcherDir, { recursive: true })
await fs.promises.writeFile(
  path.join(watcherDir, "wrapper.js"),
  "export function createWrapper(b) { return { writeSnapshot: b.writeSnapshot, getEventsSince: b.getEventsSince, subscribe: b.subscribe, unsubscribe: b.unsubscribe } }",
  "utf-8",
)
await fs.promises.writeFile(
  path.join(watcherDir, "package.json"),
  JSON.stringify({ name: "@parcel/watcher", type: "module", exports: { "./wrapper": "./wrapper.js", "./package.json": "./package.json" } }),
  "utf-8",
)
