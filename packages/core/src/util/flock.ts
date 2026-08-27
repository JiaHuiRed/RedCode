import path from "path"
import os from "os"
import { randomBytes, randomUUID } from "crypto"
import { mkdir, readFile, rm, stat, utimes, writeFile } from "fs/promises"
import { Hash } from "./hash"
import { Duration, Effect } from "effect"

export type FlockGlobal = {
  state: string
}

export namespace Flock {
  let global: FlockGlobal | undefined

  export function setGlobal(g: FlockGlobal) {
    global = g
  }

  const root = () => {
    if (!global) throw new Error("Flock global not set")
    return path.join(global.state, "locks")
  }

  // Defaults for callers that do not provide timing options.
  const defaultOpts = {
    staleMs: 60_000,
    timeoutMs: 5 * 60_000,
    baseDelayMs: 100,
    maxDelayMs: 2_000,
  }

  export interface WaitEvent {
    key: string
    attempt: number
    delay: number
    waited: number
  }

  export type Wait = (input: WaitEvent) => void | Promise<void>

  export interface Options {
    dir?: string
    signal?: AbortSignal
    staleMs?: number
    timeoutMs?: number
    baseDelayMs?: number
    maxDelayMs?: number
    onWait?: Wait
  }

  type Opts = {
    staleMs: number
    timeoutMs: number
    baseDelayMs: number
    maxDelayMs: number
  }

  type Owned = {
    acquired: true
    startHeartbeat: (intervalMs?: number) => void
    release: () => Promise<void>
  }

  export interface Lease {
    release: () => Promise<void>
    [Symbol.asyncDispose]: () => Promise<void>
  }

  function code(err: unknown) {
    if (typeof err !== "object" || err === null || !("code" in err)) return
    const value = err.code
    if (typeof value !== "string") return
    return value
  }

  function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("Aborted"))
        return
      }

      let timer: NodeJS.Timeout | undefined

      const done = () => {
        signal?.removeEventListener("abort", abort)
        resolve()
      }

      const abort = () => {
        if (timer) {
          clearTimeout(timer)
        }
        signal?.removeEventListener("abort", abort)
        reject(signal?.reason ?? new Error("Aborted"))
      }

      signal?.addEventListener("abort", abort, { once: true })
      timer = setTimeout(done, ms)
    })
  }

  function jitter(ms: number) {
    const j = Math.floor(ms * 0.3)
    const d = Math.floor(Math.random() * (2 * j + 1)) - j
    return Math.max(0, ms + d)
  }

  function mono() {
    return performance.now()
  }

  function wall() {
    return performance.timeOrigin + mono()
  }

  async function stats(file: string) {
    try {
      return await stat(file)
    } catch (err) {
      const errCode = code(err)
      if (errCode === "ENOENT" || errCode === "ENOTDIR") return
      throw err
    }
  }

  async function stale(lockDir: string, heartbeatPath: string, metaPath: string, staleMs: number) {
    // Stale detection allows automatic recovery after crashed owners.
    const now = wall()
    const heartbeat = await stats(heartbeatPath)
    if (heartbeat) {
      return now - heartbeat.mtimeMs > staleMs
    }

    const meta = await stats(metaPath)
    if (meta) {
      return now - meta.mtimeMs > staleMs
    }

    const dir = await stats(lockDir)
    if (!dir) {
      return false
    }

    return now - dir.mtimeMs > staleMs
  }

  async function tryAcquireLockDir(lockDir: string, opts: Opts): Promise<Owned | { acquired: false }> {
    const token = randomUUID?.() ?? randomBytes(16).toString("hex")
    const metaPath = path.join(lockDir, "meta.json")
    const heartbeatPath = path.join(lockDir, "heartbeat")

    try {
      await mkdir(lockDir, { mode: 0o700 })
    } catch (err) {
      if (code(err) !== "EEXIST") {
        throw err
      }

      if (!(await stale(lockDir, heartbeatPath, metaPath, opts.staleMs))) {
        return { acquired: false }
      }

      const breakerPath = lockDir + ".breaker"
      try {
        await mkdir(breakerPath, { mode: 0o700 })
      } catch (claimErr) {
        const errCode = code(claimErr)
        if (errCode === "EEXIST") {
          const breaker = await stats(breakerPath)
          if (breaker && wall() - breaker.mtimeMs > opts.staleMs) {
            await rm(breakerPath, { recursive: true, force: true }).catch(() => undefined)
          }
          return { acquired: false }
        }

        if (errCode === "ENOENT" || errCode === "ENOTDIR") {
          return { acquired: false }
        }

        throw claimErr
      }

      try {
        // Breaker ownership ensures only one contender performs stale cleanup.
        if (!(await stale(lockDir, heartbeatPath, metaPath, opts.staleMs))) {
          return { acquired: false }
        }

        await rm(lockDir, { recursive: true, force: true })

        try {
          await mkdir(lockDir, { mode: 0o700 })
        } catch (retryErr) {
          const errCode = code(retryErr)
          if (errCode === "EEXIST" || errCode === "ENOTEMPTY") {
            return { acquired: false }
          }
          throw retryErr
        }
      } finally {
        await rm(breakerPath, { recursive: true, force: true }).catch(() => undefined)
      }
    }

    const meta = {
      token,
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: new Date().toISOString(),
    }

    await writeFile(heartbeatPath, "", { flag: "wx" }).catch(async () => {
      await rm(lockDir, { recursive: true, force: true })
      throw new Error("Lock acquired but heartbeat already existed (possible compromise).")
    })

    await writeFile(metaPath, JSON.stringify(meta, null, 2), { flag: "wx" }).catch(async () => {
      await rm(lockDir, { recursive: true, force: true })
      throw new Error("Lock acquired but meta.json already existed (possible compromise).")
    })

    let timer: NodeJS.Timeout | undefined

    const startHeartbeat = (intervalMs = Math.max(100, Math.floor(opts.staleMs / 3))) => {
      if (timer) return
      // Heartbeat prevents long critical sections from being evicted as stale.
      timer = setInterval(() => {
        const t = new Date()
        void utimes(heartbeatPath, t, t).catch(() => undefined)
      }, intervalMs)
      timer.unref?.()
    }

    const release = async () => {
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }

      const current = await readFile(metaPath, "utf8")
        .then((raw) => {
          const parsed = JSON.parse(raw)
          if (!parsed || typeof parsed !== "object") return {}
          return {
            token: "token" in parsed && typeof parsed.token === "string" ? parsed.token : undefined,
          }
        })
        .catch((err) => {
          const errCode = code(err)
          if (errCode === "ENOENT" || errCode === "ENOTDIR") {
            throw new Error("Refusing to release: lock is compromised (metadata missing).")
          }
          if (err instanceof SyntaxError) {
            throw new Error("Refusing to release: lock is compromised (metadata invalid).")
          }
          throw err
        })
      // Token check prevents deleting a lock that was re-acquired by another process.
      if (current.token !== token) {
        throw new Error("Refusing to release: lock token mismatch (not the owner).")
      }

      await rm(lockDir, { recursive: true, force: true })
    }

    return {
      acquired: true,
      startHeartbeat,
      release,
    }
  }

  async function acquireLockDir(
    lockDir: string,
    input: { key: string; onWait?: Wait; signal?: AbortSignal },
    opts: Opts,
  ) {
    const stop = mono() + opts.timeoutMs
    let attempt = 0
    let waited = 0
    let delay = opts.baseDelayMs

    while (true) {
      input.signal?.throwIfAborted()

      const res = await tryAcquireLockDir(lockDir, opts)
      if (res.acquired) {
        return res
      }

      if (mono() > stop) {
        throw new Error(`Timed out waiting for lock: ${input.key}`)
      }

      attempt += 1
      const ms = jitter(delay)
      await input.onWait?.({
        key: input.key,
        attempt,
        delay: ms,
        waited,
      })
      await sleep(ms, input.signal)
      waited += ms
      delay = Math.min(opts.maxDelayMs, Math.floor(delay * 1.7))
    }
  }

  export async function acquire(key: string, input: Options = {}): Promise<Lease> {
    input.signal?.throwIfAborted()
    const cfg: Opts = {
      staleMs: input.staleMs ?? defaultOpts.staleMs,
      timeoutMs: input.timeoutMs ?? defaultOpts.timeoutMs,
      baseDelayMs: input.baseDelayMs ?? defaultOpts.baseDelayMs,
      maxDelayMs: input.maxDelayMs ?? defaultOpts.maxDelayMs,
    }
    const dir = input.dir ?? root()

    await mkdir(dir, { recursive: true })
    const lockfile = path.join(dir, Hash.fast(key) + ".lock")
    const lock = await acquireLockDir(
      lockfile,
      {
        key,
        onWait: input.onWait,
        signal: input.signal,
      },
      cfg,
    )
    lock.startHeartbeat()

    const release = () => lock.release()
    return {
      release,
      [Symbol.asyncDispose]() {
        return release()
      },
    }
  }

  export async function withLock<T>(key: string, fn: () => Promise<T>, input: Options = {}) {
    await using _ = await acquire(key, input)
    input.signal?.throwIfAborted()
    return await fn()
  }

  function resolveOpts(input: Options): Opts {
    return {
      staleMs: input.staleMs ?? defaultOpts.staleMs,
      timeoutMs: input.timeoutMs ?? defaultOpts.timeoutMs,
      baseDelayMs: input.baseDelayMs ?? defaultOpts.baseDelayMs,
      maxDelayMs: input.maxDelayMs ?? defaultOpts.maxDelayMs,
    }
  }

  // 260827 cc 单次尝试、不等待：拿不到就返回 undefined。给下面 Effect 侧的等待循环用。
  // 刻意不复用 acquire()——它内部自带等待循环，正是这里要拆掉的那部分。
  export async function tryAcquire(key: string, input: Options = {}): Promise<Lease | undefined> {
    input.signal?.throwIfAborted()
    const cfg = resolveOpts(input)
    const dir = input.dir ?? root()

    await mkdir(dir, { recursive: true })
    const lockfile = path.join(dir, Hash.fast(key) + ".lock")
    const lock = await tryAcquireLockDir(lockfile, cfg)
    if (!lock.acquired) return undefined
    lock.startHeartbeat()

    const release = () => lock.release()
    return {
      release,
      [Symbol.asyncDispose]() {
        return release()
      },
    }
  }

  const waitForLock = (key: string, input: Options, cfg: Opts) =>
    Effect.gen(function* () {
      let attempt = 0
      let waited = 0
      let delay = cfg.baseDelayMs

      while (true) {
        if (input.signal?.aborted) return yield* Effect.die(input.signal.reason ?? new Error("Aborted"))

        // 单次尝试不可中断：它只有几个 fs 系统调用、不等待，挡住中断的时间可忽略；
        // 而中途被打断的代价是留下一个建好却没人持有的锁目录——heartbeat 已经起来了会
        // 一直刷，stale 检测（staleMs）因此永远不触发，等于永久泄漏。
        const lease = yield* Effect.uninterruptible(
          Effect.promise(() => Flock.tryAcquire(key, { dir: input.dir, staleMs: cfg.staleMs })),
        )
        if (lease) return lease

        if (waited >= cfg.timeoutMs) return yield* Effect.die(new Error(`Timed out waiting for lock: ${key}`))

        attempt += 1
        const ms = jitter(delay)
        if (input.onWait) {
          const onWait = input.onWait
          yield* Effect.promise(async () => {
            await onWait({ key, attempt, delay: ms, waited })
          })
        }
        // 等待可中断：scope 关闭 / fiber 被中断在这里立刻生效，这就是本次改动的全部目的
        yield* Effect.sleep(Duration.millis(ms))
        waited += ms
        delay = Math.min(cfg.maxDelayMs, Math.floor(delay * 1.7))
      }
    }).pipe(Effect.withSpan("Flock.acquire", { attributes: { key } }))

  // 260827 cc 等锁挪到 Effect 侧做，原因只有一个：可中断性。
  //
  // 原实现是 Effect.acquireRelease(Effect.promise((signal) => Flock.acquire(key, { signal })))，
  // 而 acquireRelease 的 acquire 段**不可中断**——传给 Effect.promise 的那个 AbortSignal
  // 永远不会被触发，于是一个正在等锁的 fiber 在拿到锁之前根本打断不了，最长 timeoutMs
  // （默认 5 分钟）。实测形态：ModelsDev 每次建层都 forkScoped 一个后台 refresh，测试里
  // 第二个用例的那个堵在这里，它的 layer scope 关不掉，整条用例被拖满上一个持锁者的
  // 下载时长（4~9s，默认 5000ms 超时下必红）。
  //
  // 改法不是把 acquire 直接放开成可中断——那会漏锁：Flock.acquire 可能在中断落地前一瞬间
  // 刚好建好锁目录并起了 heartbeat，而我们已经没机会把它交给 release 了（见 waitForLock
  // 里那段注释）。所以按可中断性重新切分粒度：**等待**（退避 sleep）可中断，**单次尝试**
  // 不可中断，拿到之后在 uninterruptibleMask 的不可中断段里注册 finalizer——中断插不进这个缝。
  //
  // 超时仍然是 defect（原来 Effect.promise 里 reject 也是 defect），行为不变。
  export const effect = Effect.fn("Flock.effect")(function* (key: string, input: Options = {}) {
    const cfg = resolveOpts(input)
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const lease = yield* restore(waitForLock(key, input, cfg))
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => lease.release().catch(() => undefined)).pipe(Effect.withSpan("Flock.release")),
        )
      }),
    ).pipe(Effect.asVoid)
  })
}
