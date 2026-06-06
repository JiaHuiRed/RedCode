import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "@/lsp/lsp"
import { File } from "../file"
import { Snapshot } from "../snapshot"
import * as Project from "./project"
import * as Vcs from "./vcs"
import { Bus } from "../bus"
import { InstanceState } from "@/effect/instance-state"
import { FileWatcher } from "@/file/watcher"
import { ShareNext } from "@/share/share-next"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { Service } from "./bootstrap-service"
import { Reference } from "@/reference/reference"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { Global } from "@redcode-ai/core/global"
import path from "path"

export { Service } from "./bootstrap-service"
export type { Interface } from "./bootstrap-service"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Yield each bootstrap dep at layer init so `run` itself has R = never.
    // InstanceStore imports only the lightweight tag from bootstrap-service.ts,
    // so it can depend on bootstrap without importing this implementation graph.
    const config = yield* Config.Service
    const file = yield* File.Service
    const fileWatcher = yield* FileWatcher.Service
    const format = yield* Format.Service
    const lsp = yield* LSP.Service
    const plugin = yield* Plugin.Service
    const project = yield* Project.Service
    const reference = yield* Reference.Service
    const shareNext = yield* ShareNext.Service
    const snapshot = yield* Snapshot.Service
    const vcs = yield* Vcs.Service
    const fs = yield* AppFileSystem.Service

    const run = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      yield* Effect.logInfo("bootstrapping").pipe(Effect.annotateLogs("directory", ctx.directory))
      // 260606 Red Seed ~/.redcode/ with default templates on first run
      const redcodeHome = path.join(Global.Path.home, ".redcode")
      yield* fs.ensureDir(path.join(redcodeHome, "memory")).pipe(Effect.catchCause(Effect.logWarning))
      yield* fs.ensureDir(path.join(redcodeHome, "souls")).pipe(Effect.catchCause(Effect.logWarning))
      const templates: Array<[src: string, dest: string]> = [
        [".opencode/agents/Tsoul.md", path.join(redcodeHome, "souls", "Tsoul.md")],
        [".opencode/agents/Gsoul.md", path.join(redcodeHome, "souls", "Gsoul.md")],
        [".opencode/agents/USER.template.md", path.join(redcodeHome, "USER.md")],
        [".opencode/MEMORY.md", path.join(redcodeHome, "MEMORY.md")],
      ]
      yield* Effect.forEach(templates, ([src, dest]) =>
        Effect.gen(function* () {
          const exists = yield* fs.existsSafe(dest)
          if (exists) return
          const text = yield* fs.readFileStringSafe(path.join(ctx.directory, src))
          if (text) yield* fs.writeFileString(dest, text)
        }).pipe(Effect.catchCause(Effect.logWarning)),
      )
      // everything depends on config so eager load it for nice traces
      yield* config.get()
      // Plugin can mutate config so it has to be initialized before anything else.
      yield* plugin.init()
      // Each service self-manages its own slow work via Effect.forkScoped against
      // its per-instance state scope. We just await materialization here.
      yield* Effect.forEach(
        [reference, lsp, shareNext, format, file, fileWatcher, vcs, snapshot, project],
        (s) => s.init().pipe(Effect.catchCause((cause) => Effect.logWarning("init failed", { cause }))),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.withSpan("InstanceBootstrap.init"))
    }).pipe(Effect.withSpan("InstanceBootstrap"))

    return Service.of({ run })
  }),
)

export const defaultLayer: Layer.Layer<Service> = layer.pipe(
  Layer.provide([
    Bus.layer,
    Config.defaultLayer,
    File.defaultLayer,
    FileWatcher.defaultLayer,
    Format.defaultLayer,
    LSP.defaultLayer,
    Plugin.defaultLayer,
    Project.defaultLayer,
    Reference.defaultLayer,
    ShareNext.defaultLayer,
    Snapshot.defaultLayer,
    Vcs.defaultLayer,
    AppFileSystem.defaultLayer,
  ]),
)

export * as InstanceBootstrap from "./bootstrap"
