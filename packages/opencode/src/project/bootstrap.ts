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
import { Flag } from "@redcode-ai/core/flag/flag"
import { Config } from "@/config/config"
import { Service } from "./bootstrap-service"
import { Reference } from "@/reference/reference"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { Global } from "@redcode-ai/core/global"
import path from "path"
import TEMPLATE_TSOUL from "./template/Tsoul.md" with { type: "text" }
import TEMPLATE_GSOUL from "./template/Gsoul.md" with { type: "text" }
import TEMPLATE_MEMORY from "./template/MEMORY.md" with { type: "text" }

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
      // 260805 Red 模板改内嵌（编译期 inline），不再从 ctx.directory/.opencode/ 读盘：
      // 装在仓库外的二进制（陌生人拿 release 的常态）找不到源文件，播种静默失败，
      // souls/ 永远是空的——而模板正文还写着「首次启动时自动播种」。
      const redcodeHome = path.join(Global.Path.home, ".redcode")
      yield* fs.ensureDir(path.join(redcodeHome, "memory")).pipe(Effect.catchCause(Effect.logWarning))
      yield* fs.ensureDir(path.join(redcodeHome, "souls")).pipe(Effect.catchCause(Effect.logWarning))
      const templates: Array<[content: string, dest: string]> = [
        [TEMPLATE_TSOUL, path.join(redcodeHome, "souls", "Tsoul.md")],
        [TEMPLATE_GSOUL, path.join(redcodeHome, "souls", "Gsoul.md")],
        // 260730 Karina 不再播种 USER.md：用户画像基本被 souls/*.md 覆盖，
        // 每轮多一道加载不值。称呼改用 config 的 username 字段。
        [TEMPLATE_MEMORY, path.join(redcodeHome, "MEMORY.md")],
      ]
      yield* Effect.forEach(templates, ([content, dest]) =>
        Effect.gen(function* () {
          const exists = yield* fs.existsSafe(dest)
          if (exists) return
          if (content) yield* fs.writeFileString(dest, content)
        }).pipe(Effect.catchCause(Effect.logWarning)),
      )
      // 260613 Red Seed skills from .opencode/skill/ to ~/.redcode/skill/ (skip existing)
      // 260805 Red 改整目录递归拷贝 + 逐个 skill 隔离错误：原先非递归 readdir 把
      // references/ 子目录当文件读，抛错被外层 catchCause 整段吞掉，字母序排在
      // red-scribe 之后的 skill 全部不播种（实测 13 个只落 7 个，静默无提示）。
      yield* Effect.gen(function* () {
        // 260805 源目录 .opencode -> seed（本仓的暂存/种子目录改名，见 script/sync-home.bat）
        //
        // 260828 cc 原来只试 `ctx.directory/seed/skill` —— 那是**当前项目目录**，不是安装目录。
        // 在 RedCode 仓库之外启动时这个路径必然不存在，于是直接 `return`，全局 skill 一个都不播，
        // 而且**一声不响**。同一类病见底本修正七（读盘 vs 内联）。
        //
        // 现在按候选顺序找，并且找不到时打一条 warning 而不是静默早退。注意真正的长期修法是把
        // seed/skill 随发布包一起发（今天只有 script/sync-home.bat 在**构建机**上拷过去），
        // 那是构建系统的事，这里先把「失败可见」拿到手。
        const destSkillDir = path.join(redcodeHome, "skill")
        const candidates = [
          path.join(ctx.directory, "seed", "skill"),
          // 编译产物：<dist>/bin/redcode.exe -> <dist>/seed/skill
          path.join(path.dirname(process.execPath), "..", "seed", "skill"),
        ]
        let srcSkillDir: string | undefined
        for (const candidate of candidates) {
          if (yield* fs.existsSafe(candidate)) {
            srcSkillDir = candidate
            break
          }
        }
        if (!srcSkillDir) {
          const destExists = yield* fs.existsSafe(destSkillDir)
          // 目标目录已经有东西（构建机上 sync-home.bat 拷过）就不用吵
          if (!destExists)
            yield* Effect.logWarning(
              `skill seeding skipped: no seed/skill found (tried ${candidates.join(", ")})`,
            )
          return
        }
        yield* fs.ensureDir(destSkillDir)
        const entries = yield* Effect.tryPromise(() =>
          import("fs/promises").then((fsp) => fsp.readdir(srcSkillDir, { withFileTypes: true })),
        )
        yield* Effect.forEach(
          entries.filter((entry) => entry.isDirectory()),
          (entry) =>
            Effect.gen(function* () {
              const destDir = path.join(destSkillDir, entry.name)
              const exists = yield* fs.existsSafe(destDir)
              if (exists) return
              yield* Effect.tryPromise(() =>
                import("fs/promises").then((fsp) =>
                  fsp.cp(path.join(srcSkillDir, entry.name), destDir, { recursive: true }),
                ),
              )
            }).pipe(Effect.catchCause(Effect.logWarning)),
          { discard: true },
        )
      }).pipe(Effect.catchCause(Effect.logWarning))
      // 260611 Red project-level .redcode/ auto-init with empty MEMORY.md
      if (!Flag.REDCODE_DISABLE_PROJECT_CONFIG && ctx.worktree !== Global.Path.home) {
        yield* Effect.gen(function* () {
          const hasOpencode = yield* fs.existsSafe(path.join(ctx.worktree, ".opencode"))
          const hasRedcode = yield* fs.existsSafe(path.join(ctx.worktree, ".redcode"))
          if (hasOpencode || hasRedcode) return
          const projectRedcode = path.join(ctx.worktree, ".redcode")
          yield* fs.ensureDir(projectRedcode)
          yield* fs.writeFileString(
            path.join(projectRedcode, "MEMORY.md"),
            "# 项目记忆\n\n> 该项目特有的备忘与教训。通用教训请写入全局 `~/.redcode/MEMORY.md`。\n> **索引化（260825）**：正文只存索引行（4-8 字主题 + 关键动作词），完整全文双写入 `~/.redcode/supermemory.db`（project=项目名）——写索引必须同时入库，缺一不可；机制全文见全局 AGENTS.md「记忆系统」与 memory-automation skill。\n",
          )
        }).pipe(Effect.catchCause(Effect.logWarning))
      }
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
