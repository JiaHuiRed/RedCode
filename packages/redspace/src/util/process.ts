import { type ChildProcess } from "child_process"
import launch from "cross-spawn"
import { buffer } from "node:stream/consumers"
import { errorMessage } from "./error"
import { WindowsJob } from "./windows-job"

export type Stdio = "inherit" | "pipe" | "ignore"
export type Shell = boolean | string

export interface Options {
  cwd?: string
  env?: NodeJS.ProcessEnv | null
  stdin?: Stdio
  stdout?: Stdio
  stderr?: Stdio
  shell?: Shell
  abort?: AbortSignal
  kill?: NodeJS.Signals | number
  timeout?: number
}

export interface RunOptions extends Omit<Options, "stdout" | "stderr"> {
  nothrow?: boolean
  maxOutputBytes?: number
  maxErrorBytes?: number
}

export interface Result {
  code: number
  stdout: Buffer
  stderr: Buffer
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

export interface TextResult extends Result {
  text: string
}

export class RunFailedError extends Error {
  readonly cmd: string[]
  readonly code: number
  readonly stdout: Buffer
  readonly stderr: Buffer

  constructor(cmd: string[], code: number, stdout: Buffer, stderr: Buffer) {
    const text = stderr.toString().trim()
    super(
      text
        ? `Command failed with code ${code}: ${cmd.join(" ")}\n${text}`
        : `Command failed with code ${code}: ${cmd.join(" ")}`,
    )
    this.name = "ProcessRunFailedError"
    this.cmd = [...cmd]
    this.code = code
    this.stdout = stdout
    this.stderr = stderr
  }
}

export type Child = ChildProcess & { exited: Promise<number> }

type CollectedOutput = {
  buffer: Buffer
  truncated: boolean
}

async function collect(stream: NodeJS.ReadableStream, maxBytes?: number): Promise<CollectedOutput> {
  if (maxBytes === undefined) {
    return { buffer: await buffer(stream), truncated: false }
  }

  const chunks: Buffer[] = []
  const limit = Math.max(0, maxBytes)
  let bytes = 0
  let truncated = false
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk
    const remaining = limit - bytes
    if (remaining > 0) chunks.push(data.subarray(0, remaining))
    if (data.length > remaining) truncated = true
    bytes += data.length
  }

  return { buffer: Buffer.concat(chunks), truncated }
}

export function spawn(cmd: string[], opts: Options = {}): Child {
  if (cmd.length === 0) throw new Error("Command is required")
  opts.abort?.throwIfAborted()

  const proc =
    process.platform === "win32" && typeof Bun !== "undefined" && !opts.shell
      ? WindowsJob.spawn(cmd[0]!, cmd.slice(1), opts)
      : launch(cmd[0], cmd.slice(1), {
          cwd: opts.cwd,
          shell: opts.shell,
          env: opts.env === null ? {} : opts.env ? { ...process.env, ...opts.env } : undefined,
          stdio: [opts.stdin ?? "ignore", opts.stdout ?? "ignore", opts.stderr ?? "ignore"],
          windowsHide: process.platform === "win32",
        })

  let closed = false
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined

  const abort = () => {
    if (closed) return
    if (WindowsJob.isManaged(proc) ? WindowsJob.exited(proc) : proc.exitCode !== null || proc.signalCode !== null)
      return
    closed = true

    proc.kill(opts.kill ?? "SIGTERM")

    const ms = opts.timeout ?? 5_000
    if (ms <= 0) return
    killTimer = setTimeout(() => proc.kill("SIGKILL"), ms)
  }

  const done = () => {
    opts.abort?.removeEventListener("abort", abort)
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (killTimer) clearTimeout(killTimer)
  }

  const exited = WindowsJob.isManaged(proc)
    ? proc.exited
    : new Promise<number>((resolve, reject) => {
        proc.once("exit", (code, signal) => {
          done()
          resolve(code ?? (signal ? 1 : 0))
        })

        proc.once("error", (error) => {
          done()
          reject(error)
        })
      })
  void exited.then(done, done)
  void exited.catch(() => undefined)

  if (opts.abort) {
    opts.abort.addEventListener("abort", abort, { once: true })
    if (opts.abort.aborted) abort()
  }
  if (opts.timeout !== undefined) timeoutTimer = setTimeout(abort, opts.timeout)

  const child = proc as Child
  child.exited = exited
  return child
}

export async function run(cmd: string[], opts: RunOptions = {}): Promise<Result> {
  const proc = spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin,
    shell: opts.shell,
    abort: opts.abort,
    kill: opts.kill,
    timeout: opts.timeout,
    stdout: "pipe",
    stderr: "pipe",
  })

  if (!proc.stdout || !proc.stderr) throw new Error("Process output not available")
  const stdout = proc.stdout
  const stderr = proc.stderr

  const out = await Promise.all([
    proc.exited,
    collect(stdout, opts.maxOutputBytes),
    collect(stderr, opts.maxErrorBytes),
  ])
    .then(([code, stdout, stderr]) => ({
      code,
      stdout: stdout.buffer,
      stderr: stderr.buffer,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    }))
    .catch((err: unknown) => {
      if (!opts.nothrow) throw err
      return {
        code: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(errorMessage(err)),
        stdoutTruncated: false,
        stderrTruncated: false,
      }
    })
  if (out.code === 0 || opts.nothrow) return out
  throw new RunFailedError(cmd, out.code, out.stdout, out.stderr)
}

// Duplicated in `packages/sdk/js/src/process.ts` because the SDK cannot import
// `redcode` without creating a cycle. Keep both copies in sync.
export async function stop(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return

  if (WindowsJob.isManaged(proc)) {
    WindowsJob.terminate(proc)
    return
  }

  if (process.platform !== "win32" || !proc.pid) {
    proc.kill()
    return
  }

  const out = await run(["taskkill", "/pid", String(proc.pid), "/T", "/F"], {
    nothrow: true,
  })

  if (out.code === 0) return
  proc.kill()
}

export async function text(cmd: string[], opts: RunOptions = {}): Promise<TextResult> {
  const out = await run(cmd, opts)
  return {
    ...out,
    text: out.stdout.toString(),
  }
}

export async function lines(cmd: string[], opts: RunOptions = {}): Promise<string[]> {
  return (await text(cmd, opts)).text.split(/\r?\n/).filter(Boolean)
}

export * as Process from "./process"
