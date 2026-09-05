import { Cause, Duration, Effect, Layer, Schedule, Schema, Semaphore, Context } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { formatPatch, structuredPatch } from "diff"
import path from "path"
import { AppProcess } from "@redcode-ai/core/process"
import { Flock } from "@redcode-ai/core/util/flock"
import { InstanceState } from "@/effect/instance-state"
import { AppFileSystem } from "@redcode-ai/core/filesystem"
import { Hash } from "@redcode-ai/core/util/hash"
import { Config } from "@/config/config"
import { Global } from "@redcode-ai/core/global"
import * as Log from "@redcode-ai/core/util/log"

export const Patch = Schema.Struct({
  hash: Schema.String,
  files: Schema.mutable(Schema.Array(Schema.String)),
})
export type Patch = typeof Patch.Type

export const FileDiff = Schema.Struct({
  // Optional because legacy/imported `summary_diffs` on disk may omit
  // file details and patch text. Required Schema rejected the whole
  // session response and broke session loading on Desktop.
  file: Schema.optional(Schema.String),
  patch: Schema.optional(Schema.String),
  additions: Schema.Finite,
  deletions: Schema.Finite,
  status: Schema.optional(Schema.Literals(["added", "deleted", "modified"])),
}).annotate({ identifier: "SnapshotFileDiff" })
export type FileDiff = typeof FileDiff.Type

// 260904 cc diffFull 的两次 git diff 此前不查退出码（同文件 diff()/diffCached() 都查，唯独它漏）。
// 快照是 write-tree 出来的游离 tree，cleanup 每小时 `gc --prune=7.days`，超过 7 天的 tree 大概率
// 已被清掉；此时 git 报 bad object、stdout 为空，diffFull 静默返回 []——上游 summarize 就把
// session 的 additions/deletions/files 抹成 0，这就是「恢复老会话统计全归零」的根因。
// 改成显式失败，让调用方分得清「这轮确实没改文件」和「快照没了」。
export class DiffError extends Schema.TaggedErrorClass<DiffError>()("SnapshotDiffError", {
  from: Schema.String,
  to: Schema.String,
  exitCode: Schema.Number,
  stderr: Schema.String,
}) {}

const log = Log.create({ service: "snapshot" })
const prune = "7.days"
const limit = 2 * 1024 * 1024
const core = ["-c", "core.longpaths=true", "-c", "core.symlinks=true"]
const cfg = ["-c", "core.autocrlf=false", ...core]
const quote = [...cfg, "-c", "core.quotepath=false"]
interface GitResult {
  readonly code: ChildProcessSpawner.ExitCode
  readonly text: string
  readonly stderr: string
  /** 被本进程的超时砍断,而不是 git 自己退出。与 code 各自独立,别互相推断。 */
  readonly timedOut: boolean
}

// 260821 cc 冻结家族支线 B:snapshot 在**每一次编辑**都跑 git,是全仓最热的子进程路径,
// 而此前这里没有任何超时上限。git 挂起(锁等待、凭据弹窗、stdin 管道半开)时事件循环
// 没被阻塞,drift 探针一声不响,用户只能杀进程重开、丢掉整个会话。上限取宽松值:够大
// 不会误伤大仓首次快照的合法慢操作,够小能把"永久冻结"变成"报错并留下日志"。
// 决策与实证:docs/notes/implemented/bug-fix/2026-08-21-subprocess-timeout-git.md
const TIMEOUT = Duration.seconds(120)

type State = Omit<Interface, "init">

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly cleanup: () => Effect.Effect<void>
  readonly track: () => Effect.Effect<string | undefined>
  readonly patch: (hash: string) => Effect.Effect<Patch>
  /** step-finish 专用：一次 add() 同时出完成快照与相对 from 的补丁。见实现处的说明。 */
  readonly finish: (
    from: string | undefined,
  ) => Effect.Effect<{ hash: string | undefined; patch: Patch | undefined }>
  readonly restore: (snapshot: string) => Effect.Effect<void>
  readonly revert: (patches: Patch[]) => Effect.Effect<void>
  readonly diff: (hash: string) => Effect.Effect<string>
  readonly diffFull: (from: string, to: string) => Effect.Effect<FileDiff[], DiffError>
}

export class Service extends Context.Service<Service, Interface>()("@redcode/Snapshot") {}

export const layer: Layer.Layer<Service, never, AppFileSystem.Service | AppProcess.Service | Config.Service> =
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const appProcess = yield* AppProcess.Service
      const config = yield* Config.Service
      const locks = new Map<string, Semaphore.Semaphore>()

      const lock = (key: string) => {
        const hit = locks.get(key)
        if (hit) return hit

        const next = Semaphore.makeUnsafe(1)
        locks.set(key, next)
        return next
      }

      const state = yield* InstanceState.make<State>(
        Effect.fn("Snapshot.state")(function* (ctx) {
          const state = {
            directory: ctx.directory,
            worktree: ctx.worktree,
            gitdir: path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree)),
            vcs: ctx.project.vcs,
          }

          const args = (cmd: string[]) => ["--git-dir", state.gitdir, "--work-tree", state.worktree, ...cmd]

          const feed = (list: string[]) => list.join("\0") + "\0"
          // 260624 Red 上游 bugfix: pathspec-from-file 场景加 :(top,literal) 前缀，子目录下路径相对 worktree root 解析
          const feedPathspec = (list: string[]) => list.map((p) => ":(top,literal)" + p).join("\0") + "\0"

          const git = Effect.fnUntraced(
            function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string>; stdin?: string }) {
              const result = yield* appProcess.run(
                ChildProcess.make("git", cmd, { cwd: opts?.cwd, env: opts?.env, extendEnv: true }),
                { stdin: opts?.stdin, timeout: TIMEOUT },
              )
              return {
                code: ChildProcessSpawner.ExitCode(result.exitCode),
                text: result.stdout.toString("utf8"),
                stderr: result.stderr.toString("utf8"),
                timedOut: false,
              } satisfies GitResult
            },
            Effect.catch((err) => {
              // 超时单独留一条日志:这是今天完全没有的诊断面,挂起时日志里一个字都没有。
              if (AppProcess.isTimeout(err)) log.error("snapshot git timed out", { command: err.command })
              return Effect.succeed({
                // code 1 是这里合成的失败标记,不是 git 真的返回过 1;真正的事实在 timedOut 上。
                code: ChildProcessSpawner.ExitCode(1),
                text: "",
                stderr: err instanceof Error ? err.message : String(err),
                timedOut: AppProcess.isTimeout(err),
              })
            }),
          )

          const ignore = Effect.fnUntraced(function* (files: string[]) {
            if (!files.length) return new Set<string>()
            const check = yield* git(
              [
                ...quote,
                "--git-dir",
                path.join(state.worktree, ".git"),
                "--work-tree",
                state.worktree,
                "check-ignore",
                "--no-index",
                "--stdin",
                "-z",
              ],
              {
                cwd: state.directory,
                stdin: feed(files),
              },
            )
            if (check.code !== 0 && check.code !== 1) return new Set<string>()
            return new Set(check.text.split("\0").filter(Boolean))
          })

          const drop = Effect.fnUntraced(function* (files: string[]) {
            if (!files.length) return
            yield* git(
              [
                ...cfg,
                ...args(["rm", "--cached", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"]),
              ],
              {
                cwd: state.directory,
                stdin: feedPathspec(files),
              },
            )
          })

          const stage = Effect.fnUntraced(function* (files: string[]) {
            if (!files.length) return
            const result = yield* git(
              [...cfg, ...args(["add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"])],
              {
                cwd: state.directory,
                stdin: feedPathspec(files),
              },
            )
            if (result.code === 0) return
            log.warn("failed to add snapshot files", {
              exitCode: result.code,
              stderr: result.stderr,
            })
          })

          const exists = (file: string) => fs.exists(file).pipe(Effect.orDie)
          const read = (file: string) => fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")))
          const remove = (file: string) => fs.remove(file).pipe(Effect.catch(() => Effect.void))
          // 260904 Red 进程内信号量之外再加跨进程目录锁，避免多个 RedCode 进程同时写同一快照。
          // 只恢复 Flock 自身的崩溃锁，不碰 Git 的 index.lock；决策见：
          // docs/notes/implemented/bug-fix/2026-09-04-isolated-subagent-startup.md
          const locked = <A, E, R>(fx: Effect.Effect<A, E, R>) =>
            Effect.scoped(
              Effect.gen(function* () {
                yield* Flock.effect(`snapshot:${state.gitdir}`)
                return yield* lock(state.gitdir).withPermits(1)(fx)
              }),
            )

          const enabled = Effect.fnUntraced(function* () {
            if (state.vcs !== "git") return false
            return (yield* config.get()).snapshot !== false
          })

          const excludes = Effect.fnUntraced(function* () {
            const result = yield* git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
              cwd: state.worktree,
            })
            const file = result.text.trim()
            if (!file) return
            if (!(yield* exists(file))) return
            return file
          })

          const sync = Effect.fnUntraced(function* (list: string[] = []) {
            const file = yield* excludes()
            const target = path.join(state.gitdir, "info", "exclude")
            const text = [
              file ? (yield* read(file)).trimEnd() : "",
              ...list.map((item) => `/${item.replaceAll("\\", "/")}`),
            ]
              .filter(Boolean)
              .join("\n")
            yield* fs.ensureDir(path.join(state.gitdir, "info")).pipe(Effect.orDie)
            yield* fs.writeFileString(target, text ? `${text}\n` : "").pipe(Effect.orDie)
          })

          const add = Effect.fnUntraced(function* () {
            yield* sync()
            const [diff, other] = yield* Effect.all(
              [
                git([...quote, ...args(["diff-files", "--name-only", "-z", "--", "."])], {
                  cwd: state.directory,
                }),
                git([...quote, ...args(["ls-files", "--others", "--exclude-standard", "-z", "--", "."])], {
                  cwd: state.directory,
                }),
              ],
              { concurrency: 2 },
            )
            if (diff.code !== 0 || other.code !== 0) {
              log.warn("failed to list snapshot files", {
                diffCode: diff.code,
                diffStderr: diff.stderr,
                otherCode: other.code,
                otherStderr: other.stderr,
              })
              return
            }

            const tracked = diff.text.split("\0").filter(Boolean)
            const untracked = other.text.split("\0").filter(Boolean)
            const all = Array.from(new Set([...tracked, ...untracked]))
            if (!all.length) return

            // Resolve source-repo ignore rules against the exact candidate set.
            // --no-index keeps this pattern-based even when a path is already tracked.
            const ignored = yield* ignore(all)

            // Remove newly-ignored files from snapshot index to prevent re-adding
            if (ignored.size > 0) {
              const ignoredFiles = Array.from(ignored)
              log.info("removing gitignored files from snapshot", { count: ignoredFiles.length })
              yield* drop(ignoredFiles)
            }

            const allow = all.filter((item) => !ignored.has(item))
            if (!allow.length) return

            const large = new Set(
              (yield* Effect.all(
                allow.map((item) =>
                  fs
                    .stat(path.join(state.directory, item))
                    .pipe(Effect.catch(() => Effect.void))
                    .pipe(
                      Effect.map((stat) => {
                        if (!stat || stat.type !== "File") return
                        const size = typeof stat.size === "bigint" ? Number(stat.size) : stat.size
                        return size > limit ? item : undefined
                      }),
                    ),
                ),
                { concurrency: 8 },
              )).filter((item): item is string => Boolean(item)),
            )
            const block = new Set(untracked.filter((item) => large.has(item)))
            yield* sync(Array.from(block))
            // Stage only the allowed candidate paths so snapshot updates stay scoped.
            yield* stage(allow.filter((item) => !block.has(item)))
          })

          const cleanup = Effect.fnUntraced(function* () {
            return yield* locked(
              Effect.gen(function* () {
                if (!(yield* enabled())) return
                if (!(yield* exists(state.gitdir))) return
                const result = yield* git(args(["gc", `--prune=${prune}`]), { cwd: state.directory })
                if (result.code !== 0) {
                  log.warn("cleanup failed", {
                    exitCode: result.code,
                    stderr: result.stderr,
                  })
                  return
                }
                log.info("cleanup", { prune })
              }),
            )
          })

          /** 首次使用时建快照仓；已存在则只多一次 exists 检查。 */
          const ensureRepo = Effect.fnUntraced(function* () {
            const existed = yield* exists(state.gitdir)
            yield* fs.ensureDir(state.gitdir).pipe(Effect.orDie)
            if (existed) return
            yield* git(["init"], {
              env: { GIT_DIR: state.gitdir, GIT_WORK_TREE: state.worktree },
            })
            yield* git(["--git-dir", state.gitdir, "config", "core.autocrlf", "false"])
            yield* git(["--git-dir", state.gitdir, "config", "core.longpaths", "true"])
            yield* git(["--git-dir", state.gitdir, "config", "core.symlinks", "true"])
            yield* git(["--git-dir", state.gitdir, "config", "core.fsmonitor", "false"])
            log.info("initialized")
          })

          /** 把当前索引写成 tree 对象。**调用前索引必须已被 add() 刷新过。** */
          const writeTree = Effect.fnUntraced(function* () {
            const result = yield* git(args(["write-tree"]), { cwd: state.directory })
            const hash = result.text.trim()
            log.info("tracking", { hash, cwd: state.directory, git: state.gitdir })
            return hash
          })

          /** 相对某棵 tree 的改动文件，已滤掉源仓 gitignore 命中的。**索引须已刷新。** */
          const diffCached = Effect.fnUntraced(function* (hash: string) {
            const result = yield* git(
              [...quote, ...args(["diff", "--cached", "--no-ext-diff", "--name-only", hash, "--", "."])],
              {
                cwd: state.directory,
              },
            )
            if (result.code !== 0) {
              log.warn("failed to get diff", { hash, exitCode: result.code })
              return { hash, files: [] as string[] }
            }
            const files = result.text
              .trim()
              .split("\n")
              .map((x) => x.trim())
              .filter(Boolean)

            // Hide ignored-file removals from the user-facing patch output.
            const ignored = yield* ignore(files)

            return {
              hash,
              files: files
                .filter((item) => !ignored.has(item))
                .map((x) => path.join(state.worktree, x).replaceAll("\\", "/")),
            }
          })

          const track = Effect.fnUntraced(function* () {
            return yield* locked(
              Effect.gen(function* () {
                if (!(yield* enabled())) return
                yield* ensureRepo()
                yield* add()
                return yield* writeTree()
              }),
            )
          })

          /**
           * step-finish 专用：一次 `add()` 同时产出「完成快照」与「相对 from 的补丁」。
           *
           * 260903 cc 原先这里是 `track()` 紧接着 `patch(ctx.snapshot)` 两次独立调用，
           * 而两者各自都跑一遍 `add()` —— 那是一个 step 里最贵的一段（sync + diff-files +
           * ls-files + check-ignore + 逐文件 stat + git add，Windows 上每个 git 进程 30ms 起步）。
           * 两次调用之间只有内存记账与写会话库（会话库在 ~/.redcode/data，不在被跟踪的工作树里），
           * **工作树一个字节都没变**，所以第二遍 add() 纯属白跑。
           *
           * 合进同一个 locked 块还顺带堵一个隐患：原先两次调用之间锁是放开的，中间若有别的
           * fiber 动了索引，patch 算的就不是刚 write-tree 出来的那棵树。
           *
           * ⚠️ `patch()` 保留自己的 `add()` 不能删 —— `cleanup()`（流中断/出错的收尾路径）
           * 直接调它，前面没有 track。
           */
          const finish = Effect.fnUntraced(function* (from: string | undefined) {
            return yield* locked(
              Effect.gen(function* () {
                if (!(yield* enabled())) return { hash: undefined, patch: undefined }
                yield* ensureRepo()
                yield* add()
                const hash = yield* writeTree()
                if (from === undefined) return { hash, patch: undefined }
                return { hash, patch: yield* diffCached(from) }
              }),
            )
          })

          const patch = Effect.fnUntraced(function* (hash: string) {
            return yield* locked(
              Effect.gen(function* () {
                yield* add()
                return yield* diffCached(hash)
              }),
            )
          })

          const restore = Effect.fnUntraced(function* (snapshot: string) {
            return yield* locked(
              Effect.gen(function* () {
                log.info("restore", { commit: snapshot })
                const result = yield* git([...core, ...args(["read-tree", snapshot])], { cwd: state.worktree })
                if (result.code === 0) {
                  const checkout = yield* git([...core, ...args(["checkout-index", "-a", "-f"])], {
                    cwd: state.worktree,
                  })
                  if (checkout.code === 0) return
                  log.error("failed to restore snapshot", {
                    snapshot,
                    exitCode: checkout.code,
                    stderr: checkout.stderr,
                  })
                  return
                }
                log.error("failed to restore snapshot", {
                  snapshot,
                  exitCode: result.code,
                  stderr: result.stderr,
                })
              }),
            )
          })

          const revert = Effect.fnUntraced(function* (patches: Patch[]) {
            return yield* locked(
              Effect.gen(function* () {
                const ops: { hash: string; file: string; rel: string }[] = []
                const seen = new Set<string>()
                for (const item of patches) {
                  for (const file of item.files) {
                    if (seen.has(file)) continue
                    seen.add(file)
                    ops.push({
                      hash: item.hash,
                      file,
                      rel: path.relative(state.worktree, file).replaceAll("\\", "/"),
                    })
                  }
                }

                const single = Effect.fnUntraced(function* (op: (typeof ops)[number]) {
                  log.info("reverting", { file: op.file, hash: op.hash })
                  const result = yield* git([...core, ...args(["checkout", op.hash, "--", op.file])], {
                    cwd: state.worktree,
                  })
                  if (result.code === 0) return
                  const tree = yield* git([...core, ...args(["ls-tree", op.hash, "--", op.rel])], {
                    cwd: state.worktree,
                  })
                  if (tree.code === 0 && tree.text.trim()) {
                    log.info("file existed in snapshot but checkout failed, keeping", { file: op.file, hash: op.hash })
                    return
                  }
                  log.info("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                  yield* remove(op.file)
                })

                const clash = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

                for (let i = 0; i < ops.length;) {
                  const first = ops[i]!
                  const run = [first]
                  let j = i + 1
                  // Only batch adjacent files when their paths cannot affect each other.
                  while (j < ops.length && run.length < 100) {
                    const next = ops[j]!
                    if (next.hash !== first.hash) break
                    if (run.some((item) => clash(item.rel, next.rel))) break
                    run.push(next)
                    j += 1
                  }

                  if (run.length === 1) {
                    yield* single(first)
                    i = j
                    continue
                  }

                  const tree = yield* git(
                    [...core, ...args(["ls-tree", "--name-only", first.hash, "--", ...run.map((item) => item.rel)])],
                    {
                      cwd: state.worktree,
                    },
                  )

                  if (tree.code !== 0) {
                    log.info("batched ls-tree failed, falling back to single-file revert", {
                      hash: first.hash,
                      files: run.length,
                    })
                    for (const op of run) {
                      yield* single(op)
                    }
                    i = j
                    continue
                  }

                  const have = new Set(
                    tree.text
                      .trim()
                      .split("\n")
                      .map((item) => item.trim())
                      .filter(Boolean),
                  )
                  const list = run.filter((item) => have.has(item.rel))
                  if (list.length) {
                    log.info("reverting", { hash: first.hash, files: list.length })
                    const result = yield* git(
                      [...core, ...args(["checkout", first.hash, "--", ...list.map((item) => item.file)])],
                      {
                        cwd: state.worktree,
                      },
                    )
                    if (result.code !== 0) {
                      log.info("batched checkout failed, falling back to single-file revert", {
                        hash: first.hash,
                        files: list.length,
                      })
                      for (const op of run) {
                        yield* single(op)
                      }
                      i = j
                      continue
                    }
                  }

                  for (const op of run) {
                    if (have.has(op.rel)) continue
                    log.info("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                    yield* remove(op.file)
                  }

                  i = j
                }
              }),
            )
          })

          const diff = Effect.fnUntraced(function* (hash: string) {
            return yield* locked(
              Effect.gen(function* () {
                yield* add()
                const result = yield* git([...quote, ...args(["diff", "--cached", "--no-ext-diff", hash, "--", "."])], {
                  cwd: state.worktree,
                })
                if (result.code !== 0) {
                  log.warn("failed to get diff", {
                    hash,
                    exitCode: result.code,
                    stderr: result.stderr,
                  })
                  return ""
                }
                return result.text.trim()
              }),
            )
          })

          const diffFull = Effect.fnUntraced(function* (from: string, to: string) {
            return yield* locked(
              Effect.gen(function* () {
                type Row = {
                  file: string
                  status: "added" | "deleted" | "modified"
                  binary: boolean
                  additions: number
                  deletions: number
                }

                type Ref = {
                  file: string
                  side: "before" | "after"
                  ref: string
                }

                const show = Effect.fnUntraced(function* (row: Row) {
                  if (row.binary) return ["", ""]
                  if (row.status === "added") {
                    return [
                      "",
                      yield* git([...cfg, ...args(["show", `${to}:${row.file}`])]).pipe(
                        Effect.map((item) => item.text),
                      ),
                    ]
                  }
                  if (row.status === "deleted") {
                    return [
                      yield* git([...cfg, ...args(["show", `${from}:${row.file}`])]).pipe(
                        Effect.map((item) => item.text),
                      ),
                      "",
                    ]
                  }
                  return yield* Effect.all(
                    [
                      git([...cfg, ...args(["show", `${from}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                      git([...cfg, ...args(["show", `${to}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                    ],
                    { concurrency: 2 },
                  )
                })

                const load = Effect.fnUntraced(
                  function* (rows: Row[]) {
                    const refs = rows.flatMap((row) => {
                      if (row.binary) return []
                      if (row.status === "added")
                        return [{ file: row.file, side: "after", ref: `${to}:${row.file}` } satisfies Ref]
                      if (row.status === "deleted") {
                        return [{ file: row.file, side: "before", ref: `${from}:${row.file}` } satisfies Ref]
                      }
                      return [
                        { file: row.file, side: "before", ref: `${from}:${row.file}` } satisfies Ref,
                        { file: row.file, side: "after", ref: `${to}:${row.file}` } satisfies Ref,
                      ]
                    })
                    if (!refs.length) return new Map<string, { before: string; after: string }>()

                    const batch = yield* appProcess.run(
                      ChildProcess.make("git", [...cfg, ...args(["cat-file", "--batch"])], {
                        cwd: state.directory,
                        extendEnv: true,
                      }),
                      { stdin: refs.map((item) => item.ref).join("\n") + "\n", timeout: TIMEOUT },
                    )
                    if (batch.exitCode !== 0) {
                      log.info("git cat-file --batch failed during snapshot diff, falling back to per-file git show", {
                        stderr: batch.stderr.toString("utf8"),
                        refs: refs.length,
                      })
                      return
                    }
                    const out = batch.stdout

                    const fail = (msg: string, extra?: Record<string, string>) => {
                      log.info(msg, { ...extra, refs: refs.length })
                      return undefined
                    }

                    const map = new Map<string, { before: string; after: string }>()
                    const dec = new TextDecoder()
                    let i = 0
                    for (const ref of refs) {
                      let end = i
                      while (end < out.length && out[end] !== 10) end += 1
                      if (end >= out.length) {
                        return fail(
                          "git cat-file --batch returned a truncated header during snapshot diff, falling back to per-file git show",
                        )
                      }

                      const head = dec.decode(out.slice(i, end))
                      i = end + 1
                      const hit = map.get(ref.file) ?? { before: "", after: "" }
                      if (head.endsWith(" missing")) {
                        map.set(ref.file, hit)
                        continue
                      }

                      const match = head.match(/^[0-9a-f]+ blob (\d+)$/)
                      if (!match) {
                        return fail(
                          "git cat-file --batch returned an unexpected header during snapshot diff, falling back to per-file git show",
                          { head },
                        )
                      }

                      const size = Number(match[1])
                      if (!Number.isInteger(size) || size < 0 || i + size >= out.length || out[i + size] !== 10) {
                        return fail(
                          "git cat-file --batch returned truncated content during snapshot diff, falling back to per-file git show",
                          { head },
                        )
                      }

                      const text = dec.decode(out.slice(i, i + size))
                      if (ref.side === "before") hit.before = text
                      if (ref.side === "after") hit.after = text
                      map.set(ref.file, hit)
                      i += size + 1
                    }

                    if (i !== out.length) {
                      return fail(
                        "git cat-file --batch returned trailing data during snapshot diff, falling back to per-file git show",
                      )
                    }

                    return map
                  },
                  Effect.scoped,
                  Effect.catch(() =>
                    Effect.succeed<Map<string, { before: string; after: string }> | undefined>(undefined),
                  ),
                )

                const result: FileDiff[] = []
                const status = new Map<string, "added" | "deleted" | "modified">()

                const statuses = yield* git(
                  [...quote, ...args(["diff", "--no-ext-diff", "--name-status", "--no-renames", from, to, "--", "."])],
                  { cwd: state.directory },
                )
                if (statuses.code !== 0) {
                  log.warn("diffFull failed", { from, to, step: "name-status", exitCode: statuses.code, stderr: statuses.stderr })
                  return yield* new DiffError({ from, to, exitCode: statuses.code, stderr: statuses.stderr })
                }

                for (const line of statuses.text.trim().split("\n")) {
                  if (!line) continue
                  const [code, file] = line.split("\t")
                  if (!code || !file) continue
                  status.set(file, code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified")
                }

                const numstat = yield* git(
                  [...quote, ...args(["diff", "--no-ext-diff", "--no-renames", "--numstat", from, to, "--", "."])],
                  {
                    cwd: state.directory,
                  },
                )
                if (numstat.code !== 0) {
                  log.warn("diffFull failed", { from, to, step: "numstat", exitCode: numstat.code, stderr: numstat.stderr })
                  return yield* new DiffError({ from, to, exitCode: numstat.code, stderr: numstat.stderr })
                }

                const rows = numstat.text
                  .trim()
                  .split("\n")
                  .filter(Boolean)
                  .flatMap((line) => {
                    const [adds, dels, file] = line.split("\t")
                    if (!file) return []
                    const binary = adds === "-" && dels === "-"
                    const additions = binary ? 0 : parseInt(adds)
                    const deletions = binary ? 0 : parseInt(dels)
                    return [
                      {
                        file,
                        status: status.get(file) ?? "modified",
                        binary,
                        additions: Number.isFinite(additions) ? additions : 0,
                        deletions: Number.isFinite(deletions) ? deletions : 0,
                      } satisfies Row,
                    ]
                  })

                // Hide ignored-file removals from the user-facing diff output.
                const ignored = yield* ignore(rows.map((r) => r.file))
                if (ignored.size > 0) {
                  const filtered = rows.filter((r) => !ignored.has(r.file))
                  rows.length = 0
                  rows.push(...filtered)
                }

                const step = 100
                // 260709 Red 防 Myers diff 爆炸：大文件跳过全量 patch（add/del 计数仍来自 git numstat），
                // 小文件也加 timeout 兜底，避免病态编辑距离冻死事件循环（采样分析器实测此处曾卡 59s）。
                const MAX_DIFF_BYTES = 256 * 1024
                const DIFF_TIMEOUT_MS = 2000
                const patch = (file: string, before: string, after: string) => {
                  if (before.length + after.length > MAX_DIFF_BYTES) return ""
                  const sp = structuredPatch(file, file, before, after, "", "", {
                    context: Number.MAX_SAFE_INTEGER,
                    timeout: DIFF_TIMEOUT_MS,
                  })
                  return sp ? formatPatch(sp) : ""
                }

                for (let i = 0; i < rows.length; i += step) {
                  const run = rows.slice(i, i + step)
                  const text = yield* load(run)

                  for (const row of run) {
                    const hit = text?.get(row.file) ?? { before: "", after: "" }
                    const [before, after] = row.binary ? ["", ""] : text ? [hit.before, hit.after] : yield* show(row)
                    result.push({
                      file: row.file,
                      patch: row.binary ? "" : patch(row.file, before, after),
                      additions: row.additions,
                      deletions: row.deletions,
                      status: row.status,
                    })
                  }
                }

                return result
              }),
            )
          })

          yield* cleanup().pipe(
            Effect.catchCause((cause) => {
              log.error("cleanup loop failed", { cause: Cause.pretty(cause) })
              return Effect.void
            }),
            Effect.repeat(Schedule.spaced(Duration.hours(1))),
            Effect.delay(Duration.minutes(1)),
            Effect.forkScoped,
          )

          return { cleanup, track, patch, finish, restore, revert, diff, diffFull }
        }),
      )

      return Service.of({
        init: Effect.fn("Snapshot.init")(function* () {
          yield* InstanceState.get(state)
        }),
        cleanup: Effect.fn("Snapshot.cleanup")(function* () {
          return yield* InstanceState.useEffect(state, (s) => s.cleanup())
        }),
        track: Effect.fn("Snapshot.track")(function* () {
          return yield* InstanceState.useEffect(state, (s) => s.track())
        }),
        patch: Effect.fn("Snapshot.patch")(function* (hash: string) {
          return yield* InstanceState.useEffect(state, (s) => s.patch(hash))
        }),
        finish: Effect.fn("Snapshot.finish")(function* (from: string | undefined) {
          return yield* InstanceState.useEffect(state, (s) => s.finish(from))
        }),
        restore: Effect.fn("Snapshot.restore")(function* (snapshot: string) {
          return yield* InstanceState.useEffect(state, (s) => s.restore(snapshot))
        }),
        revert: Effect.fn("Snapshot.revert")(function* (patches: Patch[]) {
          return yield* InstanceState.useEffect(state, (s) => s.revert(patches))
        }),
        diff: Effect.fn("Snapshot.diff")(function* (hash: string) {
          return yield* InstanceState.useEffect(state, (s) => s.diff(hash))
        }),
        diffFull: Effect.fn("Snapshot.diffFull")(function* (from: string, to: string) {
          return yield* InstanceState.useEffect(state, (s) => s.diffFull(from, to))
        }),
      })
    }),
  )

export const defaultLayer = layer.pipe(
  Layer.provide(AppProcess.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Config.defaultLayer),
)

export * as Snapshot from "."
