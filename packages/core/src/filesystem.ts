import { NodeFileSystem } from "@effect/platform-node"
import { dirname, join, parse, relative, resolve as pathResolve } from "path"
import { realpathSync } from "fs"
import * as NFS from "fs/promises"
import { lookup } from "mime-types"
import { Effect, FileSystem, Layer, Schema, Context } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { Glob } from "./util/glob"
import { serviceUse } from "./effect/service-use"

export namespace AppFileSystem {
  export class FileSystemError extends Schema.TaggedErrorClass<FileSystemError>()("FileSystemError", {
    method: Schema.String,
    cause: Schema.optional(Schema.Defect),
  }) {}

  export type Error = PlatformError | FileSystemError

  export interface DirEntry {
    readonly name: string
    readonly type: "file" | "directory" | "symlink" | "other"
  }

  export interface Interface extends FileSystem.FileSystem {
    readonly isDir: (path: string) => Effect.Effect<boolean>
    readonly isFile: (path: string) => Effect.Effect<boolean>
    readonly existsSafe: (path: string) => Effect.Effect<boolean>
    readonly readFileStringSafe: (path: string) => Effect.Effect<string | undefined, Error>
    readonly readJson: (path: string) => Effect.Effect<unknown, Error>
    readonly writeJson: (path: string, data: unknown, mode?: number) => Effect.Effect<void, Error>
    /** 原子替换写，见下面 `writeFileAtomic` 的说明。配置这类「写坏了就毁掉用户数据」的文件走这条。 */
    readonly writeFileStringAtomic: (path: string, content: string, mode?: number) => Effect.Effect<void, Error>
    readonly ensureDir: (path: string) => Effect.Effect<void, Error>
    readonly writeWithDirs: (path: string, content: string | Uint8Array, mode?: number) => Effect.Effect<void, Error>
    readonly readDirectoryEntries: (path: string) => Effect.Effect<DirEntry[], Error>
    readonly findUp: (target: string, start: string, stop?: string) => Effect.Effect<string[], Error>
    readonly up: (options: { targets: string[]; start: string; stop?: string }) => Effect.Effect<string[], Error>
    readonly globUp: (pattern: string, start: string, stop?: string) => Effect.Effect<string[], Error>
    readonly glob: (pattern: string, options?: Glob.Options) => Effect.Effect<string[], Error>
    readonly globMatch: (pattern: string, filepath: string) => boolean
  }

  /* ------------------------------------------------------------------------
     260901 cc 原子替换写。

     此前全仓只有 TUI 的 kv.tsx 自己搓了一份 temp+rename，配置文件那条路
     （config.ts 的 $schema 回填 / update / updateGlobal / 旧版 TOML 迁移）
     一直是 `writeFileString` 直写 —— 写到一半被打断，用户的配置就是半截 JSON；
     而 $schema 回填恰恰发生在**加载**配置的过程里。

     两件事一起做：
     ① **临时文件必须是同目录兄弟**，否则跨卷 rename 直接 EXDEV。名字带 pid +
        进程内计数器（不是 Date.now()：同一毫秒内连写会撞名）。
     ② **Windows 上重试 rename**。DSH 的 note（2026-08-29-windows-atomic-replace-retry）
        记录了这个失败形态：别的系统组件（杀软扫描、索引器、另一个读者）临时握着
        目标句柄时，替换会以 EACCES / EBUSY / EPERM 被拒，而这是**瞬时**的 ——
        把第一次失败当永久失败，就变成配置更新会不确定地失败。跨进程写锁（Flock）
        排的是我们自己人，管不到外部句柄。

     重试只在 win32、只对那三个码；别的错误码和别的平台立刻失败。延迟 20ms 起
     翻倍、封顶 200ms，共 9 次尝试 = 最多多等 1.1 秒（与上游同一量级 —— 这次没有
     "官方不按人民币计费" 那类取舍，配置写盘既不在模型热路径上，也罕见，
     偏宽容才是对的方向）。重试耗尽时删掉临时文件再抛出：**目标文件全程没被
     碰过**，读者看到的始终是完整的旧内容。

     刻意不做 fsync：temp+rename 解决的是「读者看到半截文件」，这条已经够了；
     为掉电那个窄窗口给每次配置写盘加一次 fsync 不划算。
     ------------------------------------------------------------------------ */
  const ATOMIC_RETRY_CODES = new Set(["EACCES", "EBUSY", "EPERM"])
  /** 8 次重试（共 9 次尝试），20ms 起翻倍、封顶 200ms，累计最多多等 1.1 秒。 */
  const ATOMIC_RETRY_DELAYS = [20, 40, 80, 160, 200, 200, 200, 200]
  let atomicSeq = 0

  /** 注入点只为回归测试存在：真实调用一律走默认值。 */
  export interface AtomicWriteDeps {
    readonly rename?: (from: string, to: string) => Promise<void>
    readonly sleep?: (ms: number) => Promise<void>
    readonly platform?: string
  }

  /** 带 Windows 重试的 rename。语义见 `writeFileAtomic` 上面那段说明。 */
  export async function renameWithRetry(from: string, to: string, deps: AtomicWriteDeps = {}): Promise<void> {
    const rename = deps.rename ?? NFS.rename
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    const platform = deps.platform ?? process.platform
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(from, to)
        return
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code
        if (
          platform !== "win32" ||
          !code ||
          !ATOMIC_RETRY_CODES.has(code) ||
          attempt >= ATOMIC_RETRY_DELAYS.length
        )
          throw cause
        await sleep(ATOMIC_RETRY_DELAYS[attempt]!)
      }
    }
  }

  export async function writeFileAtomic(
    path: string,
    content: string | Uint8Array,
    mode?: number,
    deps: AtomicWriteDeps = {},
  ): Promise<void> {
    const temp = `${path}.${process.pid}.${(atomicSeq += 1).toString(36)}.tmp`
    try {
      await NFS.writeFile(temp, content).catch(async (cause) => {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause
        await NFS.mkdir(dirname(path), { recursive: true })
        await NFS.writeFile(temp, content)
      })
      // 先改权限再 rename：目标是「一步换成内容与权限都对的文件」
      if (mode !== undefined) await NFS.chmod(temp, mode)
      await renameWithRetry(temp, path, deps)
    } catch (cause) {
      await NFS.rm(temp, { force: true }).catch(() => undefined)
      throw cause
    }
  }

  export class Service extends Context.Service<Service, Interface>()("@RedCode/FileSystem") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      const existsSafe = Effect.fn("FileSystem.existsSafe")(function* (path: string) {
        return yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))
      })

      const readFileStringSafe = Effect.fn("FileSystem.readFileStringSafe")(function* (path: string) {
        return yield* fs
          .readFileString(path)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
      })

      const isDir = Effect.fn("FileSystem.isDir")(function* (path: string) {
        const info = yield* fs.stat(path).pipe(Effect.catch(() => Effect.void))
        return info?.type === "Directory"
      })

      const isFile = Effect.fn("FileSystem.isFile")(function* (path: string) {
        const info = yield* fs.stat(path).pipe(Effect.catch(() => Effect.void))
        return info?.type === "File"
      })

      const readDirectoryEntries = Effect.fn("FileSystem.readDirectoryEntries")(function* (dirPath: string) {
        return yield* Effect.tryPromise({
          try: async () => {
            const entries = await NFS.readdir(dirPath, { withFileTypes: true })
            return entries.map((e): DirEntry => ({
              name: e.name,
              type: e.isDirectory() ? "directory" : e.isSymbolicLink() ? "symlink" : e.isFile() ? "file" : "other",
            }))
          },
          catch: (cause) => new FileSystemError({ method: "readDirectoryEntries", cause }),
        })
      })

      // 260728 Karina 这里原本是裸 JSON.parse：文件内容不合法时抛出的是 defect 而不是
      // typed error，调用方的 Effect.catch 兜不住（比如 models-dev.ts 那句
      // `readJson(...).pipe(Effect.catch(() => undefined))` 的降级路径就形同虚设）。
      // 结果是用户的 ~/.redcode/cache/models.json 只要坏一个字节，defect 一路炸到
      // HTTP 错误中间件，变成 UnknownError，每次对话都直接死。
      const readJson = Effect.fn("FileSystem.readJson")(function* (path: string) {
        const text = yield* fs.readFileString(path)
        return yield* Effect.try({
          try: () => JSON.parse(text),
          catch: (cause) => new FileSystemError({ method: "readJson", cause }),
        })
      })

      const writeJson = Effect.fn("FileSystem.writeJson")(function* (path: string, data: unknown, mode?: number) {
        const content = JSON.stringify(data, null, 2)
        yield* fs.writeFileString(path, content)
        if (mode) yield* fs.chmod(path, mode)
      })

      const writeFileStringAtomic = Effect.fn("FileSystem.writeFileStringAtomic")(function* (
        path: string,
        content: string,
        mode?: number,
      ) {
        yield* Effect.tryPromise({
          try: () => writeFileAtomic(path, content, mode),
          catch: (cause) => new FileSystemError({ method: "writeFileStringAtomic", cause }),
        })
      })

      const ensureDir = Effect.fn("FileSystem.ensureDir")(function* (path: string) {
        yield* fs.makeDirectory(path, { recursive: true })
      })

      const writeWithDirs = Effect.fn("FileSystem.writeWithDirs")(function* (
        path: string,
        content: string | Uint8Array,
        mode?: number,
      ) {
        const write = typeof content === "string" ? fs.writeFileString(path, content) : fs.writeFile(path, content)

        yield* write.pipe(
          Effect.catchIf(
            (e) => e.reason._tag === "NotFound",
            () =>
              Effect.gen(function* () {
                yield* fs.makeDirectory(dirname(path), { recursive: true })
                yield* write
              }),
          ),
        )
        if (mode) yield* fs.chmod(path, mode)
      })

      const glob = Effect.fn("FileSystem.glob")(function* (pattern: string, options?: Glob.Options) {
        return yield* Effect.tryPromise({
          try: () => Glob.scan(pattern, options),
          catch: (cause) => new FileSystemError({ method: "glob", cause }),
        })
      })

      const findUp = Effect.fn("FileSystem.findUp")(function* (target: string, start: string, stop?: string) {
        const result: string[] = []
        let current = start
        while (true) {
          const search = join(current, target)
          if (yield* fs.exists(search)) result.push(search)
          if (stop === current) break
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        return result
      })

      const up = Effect.fn("FileSystem.up")(function* (options: { targets: string[]; start: string; stop?: string }) {
        const result: string[] = []
        let current = options.start
        while (true) {
          for (const target of options.targets) {
            const search = join(current, target)
            if (yield* fs.exists(search)) result.push(search)
          }
          if (options.stop === current) break
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        return result
      })

      const globUp = Effect.fn("FileSystem.globUp")(function* (pattern: string, start: string, stop?: string) {
        const result: string[] = []
        let current = start
        while (true) {
          const matches = yield* glob(pattern, { cwd: current, absolute: true, include: "file", dot: true }).pipe(
            Effect.catch(() => Effect.succeed([] as string[])),
          )
          result.push(...matches)
          if (stop === current) break
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        return result
      })

      return Service.of({
        ...fs,
        existsSafe,
        readFileStringSafe,
        isDir,
        isFile,
        readDirectoryEntries,
        readJson,
        writeJson,
        writeFileStringAtomic,
        ensureDir,
        writeWithDirs,
        findUp,
        up,
        globUp,
        glob,
        globMatch: Glob.match,
      })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(NodeFileSystem.layer))

  export const use = serviceUse(Service)

  // Pure helpers that don't need Effect (path manipulation, sync operations)
  export function mimeType(p: string): string {
    return lookup(p) || "application/octet-stream"
  }

  export function normalizePath(p: string): string {
    if (process.platform !== "win32") return p
    const resolved = pathResolve(windowsPath(p))
    try {
      return realpathSync.native(resolved)
    } catch {
      return resolved
    }
  }

  export function normalizePathPattern(p: string): string {
    if (process.platform !== "win32") return p
    if (p === "*") return p
    const match = p.match(/^(.*)[\\/]\*$/)
    if (!match) return normalizePath(p)
    const dir = /^[A-Za-z]:$/.test(match[1]) ? match[1] + "\\" : match[1]
    return join(normalizePath(dir), "*")
  }

  export function resolve(p: string): string {
    const resolved = pathResolve(windowsPath(p))
    try {
      return normalizePath(realpathSync(resolved))
    } catch (e: any) {
      if (e?.code === "ENOENT") return normalizePath(resolved)
      throw e
    }
  }

  // 260810 cc: Windows 上 path.isAbsolute 对 "\users\foo" 这类有根无盘符路径返回 true，
  // "isAbsolute ? 原样 : join(base, ...)" 会把它原样放行，后续 pathResolve 兜底按
  // process.cwd() 所在盘补盘符 —— 仓库在 E:、目标在 C: 时补错盘。这里无条件
  // pathResolve(base, ...)：全绝对路径原样透传、相对路径接到 base、无盘符有根路径
  // 取 base 的盘。必须先过 windowsPath，否则 "/c:/foo" 这类 MSYS 风格会被 resolve
  // 当成有根无盘符路径，搅成 "<base盘>:\c:\foo"。
  export function resolveFrom(base: string, p: string): string {
    return pathResolve(base, windowsPath(p))
  }

  export function windowsPath(p: string): string {
    if (process.platform !== "win32") return p
    return p
      .replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      .replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      .replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      .replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
  }

  // 260728 Karina Windows 上 path.relative 在两侧不在同一个盘（或不同 UNC 共享）时，
  // 返回的是目标的绝对路径而不是 ".." 串 —— 而绝对路径不以 ".." 开头。于是
  //   relative("E:\AI\RedCode", "C:\Windows\win.ini") === "C:\Windows\win.ini"
  //   contains(...) === true
  // 项目只要不在系统盘，另一个盘上的任何路径都被判成"在项目内"，
  // external_directory 授权就永远不会问 —— 这是实打实的授权绕过，不只是测试挂。
  // 所以先比根（盘符 / UNC 共享），不同直接判否，再走原来的 relative 逻辑。
  function sameRoot(a: string, b: string) {
    return parse(a).root.toLowerCase() === parse(b).root.toLowerCase()
  }

  export function overlaps(a: string, b: string) {
    const from = pathResolve(a)
    const to = pathResolve(b)
    if (!sameRoot(from, to)) return false
    const relA = relative(from, to)
    const relB = relative(to, from)
    return !relA || !relA.startsWith("..") || !relB || !relB.startsWith("..")
  }

  export function contains(parent: string, child: string) {
    const from = pathResolve(parent)
    const to = pathResolve(child)
    if (!sameRoot(from, to)) return false
    return !relative(from, to).startsWith("..")
  }
}
