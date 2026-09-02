export * as TuiConfig from "./tui"

import path from "path"
import { createBindingLookup } from "@opentui/keymap/extras"
import { mergeDeep, unique } from "remeda"
import { Cause, Context, Effect, Fiber, Layer, Schema } from "effect"
import { ConfigParse } from "@/config/parse"
import * as ConfigPaths from "@/config/paths"
import { migrateTuiConfig } from "./tui-migrate"
import { KeymapLeaderTimeoutDefault, resolveAttentionSoundPaths, TuiInfo } from "./tui-schema"
import { Flag } from "@redcode-ai/core/flag/flag"
import { isRecord } from "@/util/record"
import { Global } from "@redcode-ai/core/global"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { CurrentWorkingDirectory } from "./cwd"
import { ConfigPlugin } from "@/config/plugin"
import { TuiKeybind } from "./keybind"
import { InstallationLocal, InstallationVersion } from "@redcode-ai/core/installation/version"
import { makeRuntime } from "@redcode-ai/core/effect/runtime"
import { Filesystem } from "@/util/filesystem"
import * as Log from "@redcode-ai/core/util/log"
import { ConfigVariable } from "@/config/variable"
import { Npm } from "@redcode-ai/core/npm"
import type { DeepMutable } from "@redcode-ai/core/schema"
import type { TuiAttentionSoundName } from "@redcode-ai/plugin/tui"
import { FormatError, FormatUnknownError } from "@/cli/error"

const log = Log.create({ service: "tui.config" })

export const Info = TuiInfo
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

type Acc = {
  result: Info
  plugin_origins: ConfigPlugin.Origin[]
}

export type Resolved = Omit<Info, "attention" | "keybinds" | "leader_timeout"> & {
  attention: {
    enabled: boolean
    notifications: boolean
    sound: boolean
    volume: number
    sound_pack: string
    sounds: Partial<Record<TuiAttentionSoundName, string>>
    bell: boolean
  }
  keybinds: TuiKeybind.BindingLookupView
  leader_timeout: number
  // Internal resolved plugin list used by runtime loading.
  plugin_origins?: ConfigPlugin.Origin[]
}

export interface Interface {
  readonly get: () => Effect.Effect<Resolved>
  readonly waitForDependencies: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@redcode/TuiConfig") {}

function pluginScope(file: string, ctx: { directory: string }): ConfigPlugin.Scope {
  if (Filesystem.contains(ctx.directory, file)) return "local"
  // if (ctx.worktree !== "/" && Filesystem.contains(ctx.worktree, file)) return "local"
  return "global"
}

function normalize(raw: Record<string, unknown>) {
  const data = { ...raw }
  if (!("tui" in data)) return data
  if (!isRecord(data.tui)) {
    delete data.tui
    return data
  }

  const tui = data.tui
  delete data.tui
  return {
    ...tui,
    ...data,
  }
}

function dropUnknownKeybinds(input: Record<string, unknown>, configFilepath: string) {
  if (!isRecord(input.keybinds)) return input

  const invalid = TuiKeybind.unknownKeys(input.keybinds)
  if (!invalid.length) return input

  log.warn("ignored unknown tui keybinds", {
    path: configFilepath,
    keybinds: invalid,
    hint: "Remove these entries or rename them to keys from the tui.json schema.",
  })
  return {
    ...input,
    keybinds: Object.fromEntries(Object.entries(input.keybinds).filter(([key]) => !invalid.includes(key))),
  }
}

const loadState = Effect.fn("TuiConfig.loadState")(function* (ctx: { directory: string }) {
  const afs = yield* AppFileSystem.Service
  let appliedOrder = 0

  const resolvePlugins = (config: Info, configFilepath: string): Effect.Effect<Info> =>
    Effect.gen(function* () {
      const plugins = config.plugin
      if (!plugins) return config
      for (let i = 0; i < plugins.length; i++) {
        plugins[i] = yield* Effect.promise(() => ConfigPlugin.resolvePluginSpec(plugins[i], configFilepath))
      }
      return config
    })

  const load = (text: string, configFilepath: string): Effect.Effect<Info> =>
    Effect.gen(function* () {
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute({ text, type: "path", path: configFilepath, missing: "empty" }),
      )
      const data = ConfigParse.jsonc(expanded, configFilepath)
      if (!isRecord(data)) return {} as Info
      // Flatten a nested "tui" key so users who wrote `{ "tui": { ... } }` inside tui.json
      // (mirroring the old redcode.json shape) still get their settings applied.
      const normalized = dropUnknownKeybinds(normalize(data), configFilepath)
      const parsed = ConfigParse.schema(Info, normalized, configFilepath)
      const validated = parsed.attention?.sounds
        ? {
            ...parsed,
            attention: {
              ...parsed.attention,
              sounds: resolveAttentionSoundPaths(path.dirname(configFilepath), parsed.attention.sounds),
            },
          }
        : parsed
      return yield* resolvePlugins(validated, configFilepath)
    }).pipe(
      // catchCause (not tapErrorCause + orElseSucceed) because JSONC parsing and validation
      // can sync-throw — those become defects, which orElseSucceed wouldn't catch.
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          const error = Cause.squash(cause)
          const reason = FormatError(error) ?? FormatUnknownError(error)
          log.warn("skipping invalid tui config", {
            path: configFilepath,
            reason,
          })
          return {} as Info
        }),
      ),
    )

  const loadFile = (filepath: string): Effect.Effect<Info> =>
    Effect.gen(function* () {
      // Silent-swallow non-NotFound read errors (perms, EISDIR, IO) → log + skip.
      // Matches how parse/schema/plugin failures in load() are handled — every
      // broken-config path degrades gracefully rather than crashing TUI startup.
      const text = yield* afs.readFileStringSafe(filepath).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const error = Cause.squash(cause)
            const reason = FormatError(error) ?? FormatUnknownError(error)
            log.warn("failed to read tui config", {
              path: filepath,
              reason,
            })
            return undefined
          }),
        ),
      )
      if (!text) return {} as Info
      log.info("loading tui config", { path: filepath })
      return yield* load(text, filepath)
    })

  const mergeFile = (acc: Acc, file: string) =>
    Effect.gen(function* () {
      const data = yield* loadFile(file)
      if (Object.keys(data).length) {
        appliedOrder += 1
        log.info("applying tui config", { path: file, order: appliedOrder })
      }
      acc.result = mergeDeep(acc.result, data)
      if (!data.plugin?.length) return

      const scope = pluginScope(file, ctx)
      const plugins = ConfigPlugin.deduplicatePluginOrigins([
        ...acc.plugin_origins,
        ...data.plugin.map((spec) => ({ spec, scope, source: file })),
      ])
      acc.result.plugin = plugins.map((item) => item.spec)
      acc.plugin_origins = plugins
    })

  // Every config dir we may read from: global config dir, any `.redcode`
  // folders between cwd and worktree, and REDCODE_CONFIG_DIR.
  //
  // 260902 cc 这里必须传 worktree。不传的话 ConfigPaths.directories 的项目级上溯
  // `stop` 为 undefined、一路走到盘根 —— Windows 上 os.tmpdir() 就在家目录底下
  // （C:\Users\<user>\AppData\Local\Temp），上溯必经真实家目录，于是把**跑测试的人**
  // 的 ~/.redcode 扫进来。config.ts 一直传 ctx.worktree 所以不中招，只有这条 TUI 路
  // 漏着；2026-08-22 在临时目录里钉空 `.git` 的那次修复也因此没能覆盖到这里。
  // 读泄漏之外还有写的一面：下面 migrateTuiConfig 会拿这批目录当迁移源，命中就剥掉
  // theme/keybinds/tui 三个键并落 .tui-migration.bak。
  // 边界取最近的 `.git`（与 fixture 钉的标记同源）；找不到就维持不收口，跟
  // project.fromDirectory 对非 git 目录回落成 worktree="/" 的语义保持一致。
  const gitMarker = yield* AppFileSystem.use.up({ targets: [".git"], start: ctx.directory })
  const worktree = gitMarker.length ? path.dirname(gitMarker[0]!) : undefined
  const directories = yield* ConfigPaths.directories(ctx.directory, worktree)
  yield* Effect.promise(() => migrateTuiConfig({ directories, cwd: ctx.directory }))

  const projectFiles = Flag.REDCODE_DISABLE_PROJECT_CONFIG ? [] : yield* ConfigPaths.files("tui", ctx.directory)

  const acc: Acc = {
    result: {},
    plugin_origins: [],
  }

  // 1. Global tui config (lowest precedence).
  for (const file of ConfigPaths.fileInDirectory(Global.Path.config, "tui")) {
    yield* mergeFile(acc, file)
  }

  // 2. Explicit REDCODE_TUI_CONFIG override, if set.
  if (Flag.REDCODE_TUI_CONFIG) {
    const configFile = Flag.REDCODE_TUI_CONFIG
    yield* mergeFile(acc, configFile)
    log.debug("loaded custom tui config", { path: configFile })
  }

  // 3. Project tui files, applied root-first so the closest file wins.
  for (const file of projectFiles) {
    yield* mergeFile(acc, file)
  }

  // 4. `.redcode` directories (and REDCODE_CONFIG_DIR) discovered while
  // walking up the tree. Also returned below so callers can install plugin
  // dependencies from each location.
  const dirs = unique(directories).filter((dir) => dir.endsWith(".redcode") || dir === Flag.REDCODE_CONFIG_DIR)

  for (const dir of dirs) {
    if (!dir.endsWith(".redcode") && dir !== Flag.REDCODE_CONFIG_DIR) continue
    // 260902 cc 合并时必须跳过 Global.Path.config：它本身就是 `<home>/.redcode`、
    // 同样 endsWith(".redcode")，不跳的话全局层会在项目层**之后**被重新合入、拿到
    // 最高优先级 —— 跟上面第 1 步注释写的 "lowest precedence" 正好相反。实测对照：
    // 全局目录名叫 `.redcode` 时项目值输，同一份配置把目录改名 `globalcfg` 就赢。
    // 生产环境 Global.Path.config 恒等于 ~/.redcode，所以这是真实用户可见的 bug：
    // 全局 tui.json 会盖掉项目的 tui.json。第 1 步已经加载过它，跳过即可。
    // 注意只跳过**合并**：dirs 还要原样返回给上面的 npm.install 装插件依赖，
    // 把全局目录从 dirs 里滤掉会让全局插件的依赖不再被安装。
    if (dir === Global.Path.config) continue
    for (const file of ConfigPaths.fileInDirectory(dir, "tui")) {
      yield* mergeFile(acc, file)
    }
  }

  const keybinds = { ...acc.result.keybinds }
  if (process.platform === "win32") {
    // Native Windows terminals do not support POSIX suspend, so prefer prompt undo.
    keybinds.terminal_suspend = "none"
    const inputUndo = TuiKeybind.defaultValue("input_undo")
    keybinds.input_undo ??= unique(["ctrl+z", ...(typeof inputUndo === "string" ? inputUndo.split(",") : [])]).join(",")
  }
  const parsedKeybinds = TuiKeybind.parse(keybinds)
  const result: Resolved = {
    ...acc.result,
    attention: {
      enabled: acc.result.attention?.enabled ?? false,
      notifications: acc.result.attention?.notifications ?? true,
      sound: acc.result.attention?.sound ?? true,
      volume: acc.result.attention?.volume ?? 0.4,
      sound_pack: acc.result.attention?.sound_pack ?? "redcode.default",
      sounds: acc.result.attention?.sounds ?? {},
      bell: acc.result.attention?.bell ?? true,
    },
    keybinds: createBindingLookup(TuiKeybind.toBindingConfig(parsedKeybinds), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    }),
    leader_timeout: acc.result.leader_timeout ?? KeymapLeaderTimeoutDefault,
    plugin_origins: acc.plugin_origins.length ? acc.plugin_origins : undefined,
  }

  return {
    config: result,
    dirs: result.plugin?.length ? dirs : [],
  }
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const directory = yield* CurrentWorkingDirectory
    const npm = yield* Npm.Service
    const data = yield* loadState({ directory })
    // 260828 cc 与 config.ts 的后台安装同源（本仓两份并行拷贝），同样受
    // REDCODE_DISABLE_PLUGIN_DEP_INSTALL 约束 —— 否则离线用户设了开关，TUI 这条路
    // 照样去装。config.ts 那份的泄漏账见
    // docs/notes/implemented/bug-fix/2026-08-28-test-temp-dir-leak.md。
    const deps = yield* Effect.forEach(
      Flag.REDCODE_DISABLE_PLUGIN_DEP_INSTALL ? [] : data.dirs,
      (dir) =>
        npm
          .install(dir, {
            add: [
              {
                name: "@opencode-ai/plugin",
                version: InstallationLocal ? undefined : InstallationVersion,
              },
            ],
          })
          .pipe(Effect.forkScoped),
      {
        concurrency: "unbounded",
      },
    )

    const get = Effect.fn("TuiConfig.get")(() => Effect.succeed(data.config))

    const waitForDependencies = Effect.fn("TuiConfig.waitForDependencies")(() =>
      Effect.forEach(deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.ignore(), Effect.asVoid),
    )
    return Service.of({ get, waitForDependencies })
  }).pipe(Effect.withSpan("TuiConfig.layer")),
)

export const defaultLayer = layer.pipe(Layer.provide(Npm.defaultLayer), Layer.provide(AppFileSystem.defaultLayer))

const { runPromise } = makeRuntime(Service, defaultLayer)

export async function waitForDependencies() {
  await runPromise((svc) => svc.waitForDependencies())
}

export async function get() {
  return runPromise((svc) => svc.get())
}
