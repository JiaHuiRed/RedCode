import { $ } from "bun"
import * as Observability from "@redcode-ai/core/effect/observability"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Context, Layer, ManagedRuntime } from "effect"
import type * as PlatformError from "effect/PlatformError"
import type * as Scope from "effect/Scope"
import { CrossSpawnSpawner } from "@redcode-ai/core/cross-spawn-spawner"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import type { Config } from "@/config/config"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import type { InstanceContext } from "../../src/project/instance-context"
import { InstanceRuntime } from "../../src/project/instance-runtime"
import { InstanceStore } from "../../src/project/instance-store"
import { TestLLMServer } from "../lib/llm-server"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
export const testInstanceStoreLayer = InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap))
const testInstanceRuntime = ManagedRuntime.make(testInstanceStoreLayer.pipe(Layer.provideMerge(Observability.layer)))

const runTestInstanceStore = <A>(fn: (store: InstanceStore.Interface) => Effect.Effect<A>) =>
  testInstanceRuntime.runPromise(InstanceStore.Service.use(fn))

export async function provideTestInstance<R>(input: {
  directory: string
  init?: Effect.Effect<void>
  fn: (ctx: InstanceContext) => R
}) {
  const ctx = await runTestInstanceStore((store) => store.load({ directory: input.directory }))
  try {
    if (input.init) await testInstanceRuntime.runPromise(input.init.pipe(Effect.provideService(InstanceRef, ctx)))
    return await input.fn(ctx)
  } finally {
    await runTestInstanceStore((store) => store.dispose(ctx))
  }
}

export async function withTestInstance<R>(input: { directory: string; fn: (ctx: InstanceContext) => R }) {
  return input.fn(await runTestInstanceStore((store) => store.load({ directory: input.directory })))
}

export async function reloadTestInstance(input: { directory: string }) {
  return runTestInstanceStore((store) => store.reload(input))
}

export async function disposeAllInstances() {
  await Promise.all([InstanceRuntime.disposeAllInstances(), runTestInstanceStore((store) => store.disposeAll())])
}

// Strip null bytes from paths (defensive fix for CI environment issues)
function sanitizePath(p: string): string {
  return p.replace(/\0/g, "")
}

function exists(dir: string) {
  return fs
    .stat(dir)
    .then(() => true)
    .catch(() => false)
}

function clean(dir: string) {
  return fs.rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })
}

// 260828 cc 清理失败此前是 `.catch(() => undefined)` —— 静默。
//
// Windows 上 `rm -r` 撞到没释放的句柄（SQLite WAL、git 子进程、node_modules 链接）
// 会 EBUSY/EPERM，`clean()` 自带的 5 次重试之后仍可能失败，而那个 catch 把结果整个
// 吞掉。实测后果：%TEMP% 里累积了 1565 个 redcode-test-* 目录、40GB，从 08-12 长到
// 08-28 无人知晓，最后把 C 盘写满。
//
// 现在失败会留痕：即时一条 warn（带路径和 errno），退出时一条汇总。**不抛** —— 在
// finalizer 里抛会带塌与它无关的用例。真正的兜底是 test/preload.ts 的启动期清扫。
const leaked = new Set<string>()
let leakReporterInstalled = false

function reportLeak(dir: string, error: unknown) {
  leaked.add(dir)
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : String(error)
  console.warn(`[fixture] could not remove test temp dir (${code}): ${dir}`)
  if (leakReporterInstalled) return
  leakReporterInstalled = true
  process.on("exit", () => {
    if (leaked.size === 0) return
    console.warn(
      `[fixture] ${leaked.size} test temp dir(s) left behind; they will be swept on a later run. ` +
        `First: ${[...leaked].slice(0, 3).join(", ")}`,
    )
  })
}

async function cleanReporting(dir: string) {
  await clean(dir).catch((error) => reportLeak(dir, error))
}

async function stop(dir: string) {
  if (!(await exists(dir))) return
  await $`git fsmonitor--daemon stop`.cwd(dir).quiet().nothrow()
}

type TmpDirOptions<T> = {
  git?: boolean
  /** 见 tmpdirScoped 的同名选项。 */
  bare?: boolean
  config?: Partial<Config.Info>
  init?: (dir: string) => Promise<T>
  dispose?: (dir: string) => Promise<T>
}
export async function tmpdir<T>(options?: TmpDirOptions<T>) {
  const dirpath = sanitizePath(path.join(os.tmpdir(), "redcode-test-" + Math.random().toString(36).slice(2)))
  await fs.mkdir(dirpath, { recursive: true })
  // 260822 cc 与 tmpdirScoped 同款：空 .git 把 worktree 钉在本目录，防止配置发现
  // 一路向上扫到家目录、读到跑测试的人真实的 ~/.redcode。理由见 tmpdirScoped 的注释。
  if (!options?.git && !options?.bare) await fs.mkdir(path.join(dirpath, ".git"), { recursive: true })
  if (options?.git) {
    await $`git init`.cwd(dirpath).quiet()
    await $`git config core.fsmonitor false`.cwd(dirpath).quiet()
    await $`git config commit.gpgsign false`.cwd(dirpath).quiet()
    await $`git config user.email "test@redcode.test"`.cwd(dirpath).quiet()
    await $`git config user.name "Test"`.cwd(dirpath).quiet()
    await $`git commit --allow-empty -m "root commit ${dirpath}"`.cwd(dirpath).quiet()
  }
  if (options?.config) {
    await Bun.write(
      path.join(dirpath, "redcode.json"),
      JSON.stringify({
        $schema: "https://redcode.dev/config.json",
        ...options.config,
      }),
    )
  }
  const realpath = sanitizePath(await fs.realpath(dirpath))
  const extra = await options?.init?.(realpath)
  const result = {
    [Symbol.asyncDispose]: async () => {
      try {
        await options?.dispose?.(realpath)
      } finally {
        if (options?.git) await stop(realpath).catch(() => undefined)
        await cleanReporting(realpath)
      }
    },
    path: realpath,
    extra: extra as T,
  }
  return result
}

/** Effectful scoped tmpdir. Cleaned up when the scope closes. Make sure these stay in sync */
export function tmpdirScoped(options?: {
  git?: boolean
  /**
   * 260822 cc 不放 .git 标记 —— 只给「刻意需要一个非项目目录」的用例使用
   * （如 project.fromDirectory 的 non-git 分支、initGit 的 before 状态、
   * external_directory 归类）。代价是这个目录**不隔离**跑测试的人的 ~/.redcode，
   * 所以别在读配置的用例上用它。理由见下方 .git 标记处的注释。
   */
  bare?: boolean
  config?: Partial<Config.Info> | (() => Partial<Config.Info>)
  /**
   * 260828 cc 实例起来**之前**往目录里落几个文件（key 是相对路径，会自动建父目录）。
   * 用于「必须在配置装载前就存在」的东西 —— 典型是 `.redcode/agent/<name>.md`：收口第 6 步之后
   * 新角色只能由 md 文件定义，而在测试体里写文件已经晚了，那时配置早读完并缓存了。
   */
  files?: Record<string, string>
}) {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const dirpath = sanitizePath(path.join(os.tmpdir(), "redcode-test-" + Math.random().toString(36).slice(2)))
    yield* Effect.promise(() => fs.mkdir(dirpath, { recursive: true }))
    const dir = sanitizePath(yield* Effect.promise(() => fs.realpath(dirpath)))

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        if (options?.git) await stop(dir).catch(() => undefined)
        await cleanReporting(dir)
      }),
    )

    const git = (...args: string[]) =>
      spawner.spawn(ChildProcess.make("git", args, { cwd: dir })).pipe(Effect.flatMap((handle) => handle.exitCode))

    // 260822 cc 没有 .git 时 project.fromDirectory 回落成 worktree="/"（无项目哨兵），
    // 配置发现就会从临时目录一路向上扫到盘根 —— 而 os.tmpdir() 在 Windows 上是
    // C:\Users\<user>\AppData\Local\Temp，途中必经家目录，命中跑测试的人真实的
    // ~/.redcode，把用例自己传的 config 整个盖掉（数组是替换不是合并）。
    // 放一个空 .git 目录即可把 worktree 钉在临时目录：fs.up 只判存在，随后的
    // rev-parse 会失败并优雅回退到 sandbox=本目录（project.ts:276）。
    if (!options?.git && !options?.bare)
      yield* Effect.promise(() => fs.mkdir(path.join(dir, ".git"), { recursive: true }))

    if (options?.git) {
      yield* git("init")
      yield* git("config", "core.fsmonitor", "false")
      yield* git("config", "commit.gpgsign", "false")
      yield* git("config", "user.email", "test@redcode.test")
      yield* git("config", "user.name", "Test")
      yield* git("commit", "--allow-empty", "-m", `root commit ${dir}`)
    }

    if (options?.config) {
      const resolved = typeof options.config === "function" ? options.config() : options.config
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(dir, "redcode.json"),
          JSON.stringify({ $schema: "https://redcode.dev/config.json", ...resolved }),
        ),
      )
    }

    if (options?.files) {
      for (const [rel, content] of Object.entries(options.files)) {
        const target = path.join(dir, rel)
        yield* Effect.promise(() => fs.mkdir(path.dirname(target), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(target, content))
      }
    }

    return dir
  })
}

// 260822 cc worktree 必须显式钉在临时目录上，否则测试会读到**跑测试的人**的真实配置。
//
// 项目配置的发现是向上遍历找 .redcode（config/paths.ts:28
// `afs.up({ targets: [".redcode"], start: directory, stop: worktree })`）。worktree 不传
// 就一路走到盘根 —— 而 Windows 上 os.tmpdir() 是 C:\Users\<user>\AppData\Local\Temp，
// 临时目录本身就在家目录底下，往上必经 C:\Users\<user>，正好命中真实的 ~/.redcode。
//
// 实测打印出的扫描列表（修复前）：
//   ["…\redcode-test-data-6828\home\.redcode",  ← 隔离的测试家目录，对的
//    "C:\Users\Administrator\.redcode",          ← 泄漏
//    "C:\.redcode"]
//
// 注意 REDCODE_TEST_HOME（preload.ts 早就设了、global.ts 260811 也修过）挡不住这条：
// 它管的是家目录那段扫描，与项目层的向上遍历是两条独立的路。REDCODE_CONFIG /
// REDCODE_CONFIG_DIR 同样压不住，它们只作用于全局层。
//
// 后果是这批测试的成败取决于跑测试的人个人配置里有什么：CI 无用户配置所以绿，
// 本机有 provider 块/disabled_providers/小模型覆盖就红。语义上也该这么钉——
// 一个临时测试项目本来就是它自己的 worktree 根。
export const provideInstance =
  (directory: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.contextWith((services: Context.Context<R>) =>
      Effect.promise<A>(async () => {
        const ctx = await runTestInstanceStore((store) => store.load({ directory, worktree: directory }))
        return Effect.runPromiseWith(services)(self.pipe(Effect.provideService(InstanceRef, ctx)))
      }),
    )

export const provideInstanceEffect =
  (directory: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | InstanceStore.Service> =>
    InstanceStore.Service.use((store) => store.provide({ directory, worktree: directory }, self))

export const reloadInstance = (input: InstanceStore.LoadInput) =>
  InstanceStore.Service.use((store) => store.reload(input))

export const disposeAllInstancesEffect = InstanceStore.Service.use((store) => store.disposeAll())

export function provideTmpdirInstance<A, E, R>(
  self: (path: string) => Effect.Effect<A, E, R>,
  options?: { git?: boolean; config?: Partial<Config.Info> | (() => Partial<Config.Info>) },
) {
  return Effect.gen(function* () {
    const path = yield* tmpdirScoped(options)
    let provided = false

    yield* Effect.addFinalizer(() =>
      provided
        ? Effect.promise(() =>
            runTestInstanceStore((store) =>
              store.load({ directory: path }).pipe(Effect.flatMap((ctx) => store.dispose(ctx))),
            ),
          ).pipe(Effect.ignore)
        : Effect.void,
    )

    provided = true
    return yield* self(path).pipe(provideInstance(path))
  })
}

export class TestInstance extends Context.Service<TestInstance, { readonly directory: string }>()("@test/Instance") {}

export const requireInstance = Effect.gen(function* () {
  const instance = yield* InstanceRef
  if (!instance) return yield* Effect.die(new Error("missing test instance"))
  return instance
})

export const withTmpdirInstance =
  (options?: {
    git?: boolean
    config?: Partial<Config.Info> | (() => Partial<Config.Info>)
    files?: Record<string, string>
  }) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped(options)
      return yield* self.pipe(Effect.provideService(TestInstance, { directory }), provideInstanceEffect(directory))
    }).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(CrossSpawnSpawner.defaultLayer))

export function provideTmpdirServer<A, E, R>(
  self: (input: { dir: string; llm: TestLLMServer["Service"] }) => Effect.Effect<A, E, R>,
  options?: { git?: boolean; config?: (url: string) => Partial<Config.Info> },
): Effect.Effect<
  A,
  E | PlatformError.PlatformError,
  R | TestLLMServer | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  return Effect.gen(function* () {
    const llm = yield* TestLLMServer
    return yield* provideTmpdirInstance((dir) => self({ dir, llm }), {
      git: options?.git,
      config: options?.config?.(llm.url),
    })
  })
}
