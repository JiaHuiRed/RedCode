#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

import { Script } from "@redcode-ai/script"
import pkg from "../package.json"

// Load migrations from migration directories
const migrationDirs = (
  await fs.promises.readdir(path.join(dir, "migration"), {
    withFileTypes: true,
  })
)
  .filter((entry) => entry.isDirectory() && /^\d{4}\d{2}\d{2}\d{2}\d{2}\d{2}/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

const migrations = await Promise.all(
  migrationDirs.map(async (name) => {
    const file = path.join(dir, "migration", name, "migration.sql")
    const sql = await Bun.file(file).text()
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
    const timestamp = match
      ? Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
        )
      : 0
    return { sql, timestamp, name }
  }),
)
console.log(`Loaded ${migrations.length} migrations`)

const sourcemapsFlag = process.argv.includes("--sourcemaps")
const plugin = createSolidTransformPlugin()
const skipEmbedWebUi = process.argv.includes("--skip-embed-web-ui")

const createEmbeddedWebUIBundle = async () => {
  console.log(`Building Web UI to embed in the binary`)
  const appDir = path.join(import.meta.dirname, "../../app")
  const dist = path.join(appDir, "dist")
  await $`REDCODE_CHANNEL=${Script.channel} bun run --cwd ${appDir} build`
  const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => !file.endsWith(".map"))
    .sort()
  const imports = files.map((file, i) => {
    const spec = path.relative(dir, path.join(dist, file)).replaceAll("\\", "/")
    return `import file_${i} from ${JSON.stringify(spec.startsWith(".") ? spec : `./${spec}`)} with { type: "file" };`
  })
  const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
  return [
    `// Import all files as file_$i with type: "file"`,
    ...imports,
    `// Export with original mappings`,
    `export default {`,
    ...entries,
    `}`,
  ].join("\n")
}

const embeddedFileMap = skipEmbedWebUi ? null : await createEmbeddedWebUIBundle()

try { await $`rm -rf dist` } catch {}

const binaries: Record<string, string> = {}
// 260615 Red Windows-only single target
const name = `${pkg.name}-windows-x64`
console.log(`building ${name}`)
await $`mkdir -p dist/${name}/bin`

const localPath = path.resolve(dir, "node_modules/@opentui/core/parser.worker.js")
const rootPath = path.resolve(dir, "../../node_modules/@opentui/core/parser.worker.js")
const parserWorker = fs.realpathSync(fs.existsSync(localPath) ? localPath : rootPath)
const workerPath = "./src/cli/cmd/tui/worker.ts"

const bunfsRoot = "B:/~BUN/root/"
const workerRelativePath = path.relative(dir, parserWorker).replaceAll("\\", "/")

await Bun.build({
  conditions: ["browser"],
  tsconfig: "./tsconfig.json",
  plugins: [plugin],
  external: ["node-gyp", "@ast-grep/napi"],
  format: "esm",
  minify: true,
  sourcemap: sourcemapsFlag ? "linked" : "none",
  splitting: true,
  compile: {
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: true,
    autoloadPackageJson: true,
    target: "bun-windows-x64" as any,
    outfile: `dist/${name}/bin/redcode`,
    execArgv: [`--user-agent=redcode/${Script.version}`, "--use-system-ca", "--"],
    windows: {},
  },
  files: embeddedFileMap ? { "redcode-web-ui.gen.ts": embeddedFileMap } : {},
  entrypoints: ["./src/index.ts", parserWorker, workerPath, ...(embeddedFileMap ? ["redcode-web-ui.gen.ts"] : [])],
  define: {
    REDCODE_VERSION: `'${Script.version}'`,
    REDCODE_MIGRATIONS: JSON.stringify(migrations),
    REDCODE_MODELS_DEV: generated.modelsData,
    OTUI_TREE_SITTER_WORKER_PATH: bunfsRoot + workerRelativePath,
    REDCODE_WORKER_PATH: workerPath,
    REDCODE_CHANNEL: `'${Script.channel}'`,
    REDCODE_LIBC: "",
  },
})

// Smoke test
{
  const binaryPath = `dist/${name}/bin/redcode`
  console.log(`Running smoke test: ${binaryPath} --version`)
  try {
    const versionOutput = await $`${binaryPath} --version`.text()
    console.log(`Smoke test passed: ${versionOutput.trim()}`)
  } catch (e) {
    console.error(`Smoke test failed for ${name}:`, e)
    process.exit(1)
  }
}

try { await $`rm -rf ./dist/${name}/bin/tui` } catch {}
await Bun.file(`dist/${name}/package.json`).write(
  JSON.stringify(
    {
      name,
      version: Script.version,
      preferUnplugged: true,
      os: ["win32"],
      cpu: ["x64"],
    },
    null,
    2,
  ),
)
binaries[name] = Script.version

if (Script.release) {
  await $`zip -r ../../${name}.zip *`.cwd(`dist/${name}/bin`)
  await $`gh release upload v${Script.version} ./dist/*.zip --clobber --repo ${process.env.GH_REPO}`
}

export { binaries }
