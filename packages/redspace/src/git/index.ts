import { AppProcess } from "@redcode-ai/core/process"
import { Duration, Effect, Layer, Context, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { join } from "node:path"
import { open, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import * as Log from "@redcode-ai/core/util/log"

const log = Log.create({ service: "git" })

// 260821 cc 冻结家族支线 B:此前所有 git 调用都没有超时上限。git 挂起有真实成因
// (index.lock 等锁、Windows 凭据管理器弹窗、远程 TCP 黑洞、stdin 管道半开),挂起时
// 事件循环没被阻塞,evloop drift 探针一声不响 —— 用户只能杀进程。这里给本地 git 管道
// 命令一个宽松但有限的上限:够大不会误伤大仓的合法慢操作,够小能把"永久冻结"变成
// "两分钟后报错并留下日志"。需要更长的调用方自己传 opts.timeout。
// 决策与实证:docs/notes/implemented/bug-fix/2026-08-21-subprocess-timeout-git.md
const TIMEOUT = Duration.seconds(120)

const cfg = [
  "--no-optional-locks",
  "-c",
  "core.autocrlf=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.longpaths=true",
  "-c",
  "core.symlinks=true",
  "-c",
  "core.quotepath=false",
] as const

const out = (result: { text(): string }) => result.text().trim()
const nuls = (text: string) => text.split("\0").filter(Boolean)
const fail = (err: unknown) =>
  ({
    // exitCode 1 是这里合成的失败标记,不是 git 真的返回过 1;真正的事实在 timedOut 上。
    exitCode: 1,
    text: () => "",
    stdout: Buffer.alloc(0),
    stderr: Buffer.from(err instanceof Error ? err.message : String(err)),
    truncated: false,
    timedOut: AppProcess.isTimeout(err),
  }) satisfies Result

// 261120 Red 行数统计只为 UI 角标：32 MiB 上限在读之前判，避免整份读入内存；
// 分块读取让 stat 后文件增长仍受同一预算约束。
const MAX_UNTRACKED_STAT_BYTES = 32 * 1024 * 1024
const UNTRACKED_READ_CHUNK = 64 * 1024

async function countUntrackedLines(file: string) {
  const handle = await open(file, "r")
  try {
    const info = await handle.stat()
    if (info.size > MAX_UNTRACKED_STAT_BYTES) return undefined
    const head = new Uint8Array(8000)
    const headRead = await handle.read(head, 0, head.length, 0)
    // git 对含 NUL 的文件按二进制处理（numstat 输出 "-"）——同样放弃统计
    for (let i = 0; i < headRead.bytesRead; i++) if (head[i] === 0) return undefined
    const buffer = new Uint8Array(UNTRACKED_READ_CHUNK)
    let additions = 0
    let last = -1
    let total = 0
    while (total < info.size) {
      const capacity = Math.min(buffer.length, info.size - total, MAX_UNTRACKED_STAT_BYTES - total)
      if (capacity <= 0) break
      const chunk = await handle.read(buffer, 0, capacity, total)
      if (chunk.bytesRead === 0) break
      for (let i = 0; i < chunk.bytesRead; i++) if (buffer[i] === 10) additions++
      last = buffer[chunk.bytesRead - 1]!
      total += chunk.bytesRead
    }
    if (total > 0 && last !== 10) additions++
    return additions
  } finally {
    await handle.close()
  }
}

export type Kind = "added" | "deleted" | "modified"

export type Base = {
  readonly name: string
  readonly ref: string
}

export type Item = {
  readonly file: string
  readonly code: string
  readonly status: Kind
}

export type Stat = {
  readonly file: string
  readonly additions: number
  readonly deletions: number
}

export type Patch = {
  readonly text: string
  readonly truncated: boolean
}

export interface PatchOptions {
  readonly context?: number
  readonly maxOutputBytes?: number
}

export interface Result {
  readonly exitCode: number
  readonly text: () => string
  readonly stdout: Buffer
  readonly stderr: Buffer
  readonly truncated: boolean
  /** 被本进程的超时砍断,而不是 git 自己退出。与 exitCode 各自独立,别互相推断。 */
  readonly timedOut: boolean
}

export interface Options {
  readonly cwd: string
  readonly env?: Record<string, string>
  readonly maxOutputBytes?: number
  readonly stdin?: ChildProcess.CommandInput
  /** 覆盖默认超时;网络类 git(fetch/clone)或超大仓的批量操作才需要放宽。 */
  readonly timeout?: Duration.Input
}

export interface Interface {
  readonly run: (args: string[], opts: Options) => Effect.Effect<Result>
  readonly branch: (cwd: string) => Effect.Effect<string | undefined>
  readonly prefix: (cwd: string) => Effect.Effect<string>
  readonly defaultBranch: (cwd: string) => Effect.Effect<Base | undefined>
  readonly hasHead: (cwd: string) => Effect.Effect<boolean>
  readonly mergeBase: (cwd: string, base: string, head?: string) => Effect.Effect<string | undefined>
  readonly show: (cwd: string, ref: string, file: string, prefix?: string) => Effect.Effect<string>
  /** 与 show 同源，但可给输出上限；超限时 truncated=true，调用方不能把它当完整基线。 */
  readonly showBounded: (
    cwd: string,
    ref: string,
    file: string,
    prefix?: string,
    maxBytes?: number,
  ) => Effect.Effect<{ text: string; truncated: boolean }>
  readonly status: (cwd: string) => Effect.Effect<Item[]>
  readonly diff: (cwd: string, ref: string) => Effect.Effect<Item[]>
  readonly stats: (cwd: string, ref: string) => Effect.Effect<Stat[]>
  readonly patch: (cwd: string, ref: string, file: string, options?: PatchOptions) => Effect.Effect<Patch>
  readonly patchAll: (cwd: string, ref: string, options?: PatchOptions) => Effect.Effect<Patch>
  readonly patchUntracked: (cwd: string, file: string, options?: PatchOptions) => Effect.Effect<Patch>
  /**
   * 一次 git 进程批量生成多个未跟踪文件的补丁。临时 GIT_INDEX_FILE + add -N + diff，
   * 不碰真实索引；任何一步失败返回 undefined，调用方按原逐文件路径回退。
   */
  readonly patchUntrackedBatch: (
    cwd: string,
    files: string[],
    options?: PatchOptions,
  ) => Effect.Effect<Patch | undefined>
  readonly statUntracked: (cwd: string, file: string) => Effect.Effect<Stat | undefined>
  readonly applyPatch: (cwd: string, patch: string) => Effect.Effect<Result>
}

const kind = (code: string): Kind => {
  if (code === "??") return "added"
  if (code.includes("U")) return "modified"
  if (code.includes("A") && !code.includes("D")) return "added"
  if (code.includes("D") && !code.includes("A")) return "deleted"
  return "modified"
}

export class Service extends Context.Service<Service, Interface>()("@redcode/Git") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service
    const encoder = new TextEncoder()
    const stdin = (text: string) => Stream.make(encoder.encode(text))

    const run = Effect.fn("Git.run")(
      function* (args: string[], opts: Options) {
        const result = yield* appProcess.run(
          ChildProcess.make("git", [...cfg, ...args], {
            cwd: opts.cwd,
            env: opts.env,
            extendEnv: true,
            stdin: opts.stdin ?? "ignore",
            stdout: "pipe",
            stderr: "pipe",
          }),
          { maxOutputBytes: opts.maxOutputBytes, timeout: opts.timeout ?? TIMEOUT },
        )
        return {
          exitCode: result.exitCode,
          text: () => result.stdout.toString("utf8"),
          stdout: result.stdout,
          stderr: result.stderr,
          truncated: result.stdoutTruncated || result.stderrTruncated,
          timedOut: false,
        } satisfies Result
      },
      Effect.catch((err) => {
        // 超时单独留一条日志:这是今天完全没有的诊断面,挂起时日志里一个字都没有。
        if (AppProcess.isTimeout(err)) log.error("git timed out", { command: err.command })
        return Effect.succeed(fail(err))
      }),
    )

    const text = Effect.fn("Git.text")(function* (args: string[], opts: Options) {
      return (yield* run(args, opts)).text()
    })

    const lines = Effect.fn("Git.lines")(function* (args: string[], opts: Options) {
      return (yield* text(args, opts))
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean)
    })

    const refs = Effect.fnUntraced(function* (cwd: string) {
      return yield* lines(["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd })
    })

    const configured = Effect.fnUntraced(function* (cwd: string, list: string[]) {
      const result = yield* run(["config", "init.defaultBranch"], { cwd })
      const name = out(result)
      if (!name || !list.includes(name)) return
      return { name, ref: name } satisfies Base
    })

    const primary = Effect.fnUntraced(function* (cwd: string) {
      const list = yield* lines(["remote"], { cwd })
      if (list.includes("origin")) return "origin"
      if (list.length === 1) return list[0]
      if (list.includes("upstream")) return "upstream"
      return list[0]
    })

    const branch = Effect.fn("Git.branch")(function* (cwd: string) {
      const result = yield* run(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd })
      if (result.exitCode !== 0) return
      const text = out(result)
      return text || undefined
    })

    const prefix = Effect.fn("Git.prefix")(function* (cwd: string) {
      const result = yield* run(["rev-parse", "--show-prefix"], { cwd })
      if (result.exitCode !== 0) return ""
      return out(result)
    })

    const defaultBranch = Effect.fn("Git.defaultBranch")(function* (cwd: string) {
      const remote = yield* primary(cwd)
      if (remote) {
        const head = yield* run(["symbolic-ref", `refs/remotes/${remote}/HEAD`], { cwd })
        if (head.exitCode === 0) {
          const ref = out(head).replace(/^refs\/remotes\//, "")
          const name = ref.startsWith(`${remote}/`) ? ref.slice(`${remote}/`.length) : ""
          if (name) return { name, ref } satisfies Base
        }
      }

      const list = yield* refs(cwd)
      const next = yield* configured(cwd, list)
      if (next) return next
      if (list.includes("main")) return { name: "main", ref: "main" } satisfies Base
      if (list.includes("master")) return { name: "master", ref: "master" } satisfies Base
    })

    const hasHead = Effect.fn("Git.hasHead")(function* (cwd: string) {
      const result = yield* run(["rev-parse", "--verify", "HEAD"], { cwd })
      return result.exitCode === 0
    })

    const mergeBase = Effect.fn("Git.mergeBase")(function* (cwd: string, base: string, head = "HEAD") {
      const result = yield* run(["merge-base", base, head], { cwd })
      if (result.exitCode !== 0) return
      const text = out(result)
      return text || undefined
    })

    const show = Effect.fn("Git.show")(function* (cwd: string, ref: string, file: string, prefix = "") {
      const target = prefix ? `${prefix}${file}` : file
      const result = yield* run(["show", `${ref}:${target}`], { cwd })
      if (result.exitCode !== 0) return ""
      if (result.stdout.includes(0)) return ""
      return result.text()
    })

    // 261021 Red 审计 RC21-05：文件预览拿 HEAD 版本当 diff 基线时必须能知道「这份基线不完整」——
    //   返回截断后的字符串会让调用方把它当全文，生成一份「整文件新增」的假 diff。
    const showBounded = Effect.fn("Git.showBounded")(function* (
      cwd: string,
      ref: string,
      file: string,
      prefix = "",
      maxBytes?: number,
    ) {
      const target = prefix ? `${prefix}${file}` : file
      const result = yield* run(["show", `${ref}:${target}`], { cwd, maxOutputBytes: maxBytes })
      if (result.exitCode !== 0) return { text: "", truncated: false }
      if (result.stdout.includes(0)) return { text: "", truncated: false }
      return { text: result.text(), truncated: result.truncated }
    })

    const status = Effect.fn("Git.status")(function* (cwd: string) {
      return nuls(
        yield* text(["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z", "--", "."], {
          cwd,
        }),
      ).flatMap((item) => {
        const file = item.slice(3)
        if (!file) return []
        const code = item.slice(0, 2)
        return [{ file, code, status: kind(code) } satisfies Item]
      })
    })

    const diff = Effect.fn("Git.diff")(function* (cwd: string, ref: string) {
      const list = nuls(
        yield* text(["diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", ref, "--", "."], { cwd }),
      )
      return list.flatMap((code, idx) => {
        if (idx % 2 !== 0) return []
        const file = list[idx + 1]
        if (!code || !file) return []
        return [{ file, code, status: kind(code) } satisfies Item]
      })
    })

    const stats = Effect.fn("Git.stats")(function* (cwd: string, ref: string) {
      return nuls(
        yield* text(["diff", "--no-ext-diff", "--no-renames", "--numstat", "-z", ref, "--", "."], { cwd }),
      ).flatMap((item) => {
        const a = item.indexOf("\t")
        const b = item.indexOf("\t", a + 1)
        if (a === -1 || b === -1) return []
        const file = item.slice(b + 1)
        if (!file) return []
        const adds = item.slice(0, a)
        const dels = item.slice(a + 1, b)
        const additions = adds === "-" ? 0 : Number.parseInt(adds || "0", 10)
        const deletions = dels === "-" ? 0 : Number.parseInt(dels || "0", 10)
        return [
          {
            file,
            additions: Number.isFinite(additions) ? additions : 0,
            deletions: Number.isFinite(deletions) ? deletions : 0,
          } satisfies Stat,
        ]
      })
    })

    const patch = Effect.fn("Git.patch")(function* (cwd: string, ref: string, file: string, options?: PatchOptions) {
      const result = yield* run(
        ["diff", "--patch", "--no-ext-diff", "--no-renames", `--unified=${options?.context ?? 3}`, ref, "--", file],
        { cwd, maxOutputBytes: options?.maxOutputBytes },
      )
      return { text: result.truncated ? "" : result.text(), truncated: result.truncated } satisfies Patch
    })

    const patchAll = Effect.fn("Git.patchAll")(function* (cwd: string, ref: string, options?: PatchOptions) {
      const result = yield* run(
        ["diff", "--patch", "--no-ext-diff", "--no-renames", `--unified=${options?.context ?? 3}`, ref, "--", "."],
        { cwd, maxOutputBytes: options?.maxOutputBytes },
      )
      return { text: result.text(), truncated: result.truncated } satisfies Patch
    })

    const patchUntracked = Effect.fn("Git.patchUntracked")(function* (
      cwd: string,
      file: string,
      options?: PatchOptions,
    ) {
      const result = yield* run(
        [
          "diff",
          "--no-index",
          "--patch",
          "--no-ext-diff",
          "--no-renames",
          `--unified=${options?.context ?? 3}`,
          "--",
          "/dev/null",
          file,
        ],
        { cwd, maxOutputBytes: options?.maxOutputBytes },
      )
      return { text: result.truncated ? "" : result.text(), truncated: result.truncated } satisfies Patch
    })

    // 260909 Red 进程内计数替换 git diff --no-index 子进程：vcs.diff 对每个 untracked
    // 文件各起一个 git（预算 60 个），agent 干活时每秒一次防抖重算，Windows 上单次
    // spawn 15-40ms，60 个就是 1-2.5s 的进程风暴压在 sidecar 事件循环上。新文件的
    // additions 就是行数——单遍数 0x0A 字节即可，无需起进程。
    // 261120 Red 两个运行时问题：原实现用 Bun.file()，桌面 sidecar 走 Node 目标时
    // Bun 未定义、整个统计返回 undefined（三行新文件显示 +0）；32 MiB 上限又在
    // arrayBuffer() 之后，超大文件先整份读进内存再丢弃。改为 Node fs 的 open/stat
    // 预检大小 + 分块读取，Bun 与 Node 两个运行时同形。
    // 决策见 docs/notes/implemented/bug-fix/2026-11-20-untracked-stat-batch.md
    // 261120 Red 批量未跟踪补丁：此前每个文件一次 git diff --no-index，257 个文件
    // 387ms；改为临时索引 + add -N + 一次 diff。任何一步失败都返回 undefined，
    // 调用方按原逐文件路径回退，特殊文件/子仓库不会让整批丢结果。
    const patchUntrackedBatch = Effect.fn("Git.patchUntrackedBatch")(function* (
      cwd: string,
      files: string[],
      options?: PatchOptions,
    ) {
      if (files.length === 0) return { text: "", truncated: false } satisfies Patch
      // 每次请求独立临时索引：并发/取消不会污染真实 index。
      const index = join(tmpdir(), `redcode-untracked-${randomUUID()}`)
      const env = { GIT_INDEX_FILE: index }
      const input = files.join("\0") + "\0"
      const cleanup = Effect.promise(() => rm(index, { force: true })).pipe(Effect.catch(() => Effect.void))

      const result = yield* Effect.gen(function* () {
        // --empty 不依赖 HEAD，空仓也能建立基线；失败说明临时索引不可用，回退。
        const tree = yield* run(["read-tree", "--empty"], { cwd, env })
        if (tree.exitCode !== 0) return
        const added = yield* run(["add", "-N", "--pathspec-from-file=-", "--pathspec-file-nul"], {
          cwd,
          env,
          stdin: stdin(input),
        })
        if (added.exitCode !== 0) return
        // 临时索引里只有 add -N 登记的文件，diff 不再带 pathspec（git diff 不支持
        // --pathspec-from-file，路径多时 argv 又会超 Windows 上限）。
        return yield* run(
          ["diff", "--patch", "--no-ext-diff", "--no-renames", `--unified=${options?.context ?? 3}`],
          { cwd, env, maxOutputBytes: options?.maxOutputBytes },
        )
      }).pipe(Effect.ensuring(cleanup))

      if (!result || result.exitCode !== 0) return
      return { text: result.truncated ? "" : result.text(), truncated: result.truncated } satisfies Patch
    })

    const statUntracked = Effect.fn("Git.statUntracked")(function* (cwd: string, file: string) {
      const counted = yield* Effect.tryPromise({
        try: () => countUntrackedLines(join(cwd, file)),
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)))
      // status 与 stat 之间文件可能已被删——按"统计不到"处理，与 numstat 空输出同义
      if (counted === undefined) return undefined
      return { file, additions: counted, deletions: 0 } satisfies Stat
    })

    const applyPatch = Effect.fn("Git.applyPatch")(function* (cwd: string, patch: string) {
      return yield* run(["apply", "-"], { cwd, stdin: stdin(patch) })
    })

    return Service.of({
      run,
      branch,
      prefix,
      defaultBranch,
      hasHead,
      mergeBase,
      show,
      showBounded,
      status,
      diff,
      stats,
      patch,
      patchAll,
      patchUntracked,
      patchUntrackedBatch,
      statUntracked,
      applyPatch,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppProcess.defaultLayer))

export * as Git from "."
