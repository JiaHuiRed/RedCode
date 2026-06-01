import { defineConfig } from "electron-vite"
import { sentryVitePlugin } from "@sentry/vite-plugin"
import appPlugin from "@redcode-ai/app/vite"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import * as fs from "node:fs/promises"
import * as path from "node:path"
const { relative } = path

const require = createRequire(import.meta.url)

const REDCODE_SERVER_DIST = "../opencode/dist/node"

const channel = (() => {
  const raw = process.env.REDCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.REDCODE_CHANNEL === "latest") return "prod"
  return "dev"
})()

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./out/renderer/**",
          filesToDeleteAfterUpload: "./out/renderer/**/*.map",
        },
      })
    : false

export default defineConfig({
  main: {
    define: {
      "import.meta.env.REDCODE_CHANNEL": JSON.stringify(channel),
    },
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts", sidecar: "src/main/sidecar.ts" },
        external: [],
      },
      externalizeDeps: { include: [nodePtyPkg] },
    },
    plugins: [
      {
        name: "redcode:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "redcode:server-bundle",
        enforce: "pre",
        resolveId(id) {
          if (id !== "virtual:redcode-server") return
          return { id: "./node.js", external: true }
        },
        async writeBundle() {
          const outDir = "./out/main"
          const configDir = path.dirname(fileURLToPath(import.meta.url))
          const dist = path.resolve(configDir, REDCODE_SERVER_DIST)
          const opencodeNodeModules = path.resolve(configDir, "../opencode/node_modules")

          await fs.mkdir(outDir, { recursive: true })

          // Bundle + wasm
          await fs.cp(path.join(dist, "node.js"), path.join(outDir, "node.js"))
          for (const name of await fs.readdir(dist)) {
            if (!name.endsWith(".wasm")) continue
            await fs.writeFile(path.join(outDir, name), await fs.readFile(path.join(dist, name)))
          }

          // jsonc-parser (no deps, needed by bundle as external)
          const jp = path.join(opencodeNodeModules, "jsonc-parser")
          await fs.cp(jp, path.join(outDir, "node_modules/jsonc-parser"), { recursive: true, dereference: true })

          // @parcel/watcher shim + native binary
          const pkgDir = path.join(opencodeNodeModules, "@parcel")
          const outPkgDir = path.join(outDir, "node_modules/@parcel")
          const outWatcherDir = path.join(outPkgDir, "watcher")
          await fs.mkdir(outWatcherDir, { recursive: true })
          await fs.writeFile(
            path.join(outWatcherDir, "wrapper.js"),
            "export function createWrapper(b) { return { writeSnapshot: b.writeSnapshot, getEventsSince: b.getEventsSince, subscribe: b.subscribe, unsubscribe: b.unsubscribe } }",
          )
          await fs.writeFile(
            path.join(outWatcherDir, "package.json"),
            JSON.stringify({ name: "@parcel/watcher", type: "module", exports: { "./wrapper": "./wrapper.js", "./package.json": "./package.json" } }),
          )
          for (const name of ["watcher-win32-x64"]) {
            const src = path.join(pkgDir, name)
            if (!await fs.stat(src).then(() => true).catch(() => false)) continue
            await fs.cp(src, path.join(outPkgDir, name), { recursive: true, dereference: true })
          }
        },
      },
    ],
  },
  preload: {
    define: {
      "process.env.npm_package_version": JSON.stringify(require("./package.json").version),
    },
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    plugins: [appPlugin, sentry],
    publicDir: "../../../app/public",
    root: "src/renderer",
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
          loading: "src/renderer/loading.html",
        },
      },
    },
  },
})
