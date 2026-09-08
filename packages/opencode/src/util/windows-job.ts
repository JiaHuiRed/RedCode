import { spawn as launch, type ChildProcess, type StdioOptions } from "child_process"
import { closeSync, openSync } from "fs"
import { devNull } from "os"
import type { Readable, Writable } from "stream"
import type { Child, Options, Stdio } from "./process"
import { fileURLToPath } from "url"

const RUNNER_ENV = "REDCODE_WINDOWS_JOB_RUNNER"
const MANAGED = Symbol("windows-job")

type Runner = ChildProcess & {
  connected: boolean
  send?: (message: unknown, callback?: (error: Error | null) => void) => boolean
  stdio: Array<Readable | Writable | null>
}

type Managed = Child & {
  [MANAGED]: {
    targetExited: boolean
    runner: Runner
  }
}

type Message =
  | { type: "ready" }
  | { type: "start"; command: string; args: string[]; cwd: string; env: Record<string, string> }
  | { type: "terminate" }
  | { type: "exit"; code: number }
  | {
      type: "error"
      error: { name: string; message: string; code?: string; errno?: string | number; syscall?: string; path?: string }
    }

function runnerInvocation() {
  if (typeof Bun === "undefined") {
    return [process.execPath, fileURLToPath(new URL("./windows-job-runner.js", import.meta.url))]
  }
  if (import.meta.filename.replaceAll("\\", "/").startsWith("B:/~BUN/")) return [process.execPath]
  return [process.execPath, fileURLToPath(new URL("./windows-job-runner.ts", import.meta.url))]
}

function targetEnvironment(opts: Options) {
  const source = opts.env === null ? {} : opts.env ? { ...process.env, ...opts.env } : process.env
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function stdio(value: Stdio | undefined, fallback: Stdio, inherited: number, ignored?: number) {
  const mode = value ?? fallback
  if (mode === "inherit") return inherited
  if (mode === "ignore" && ignored !== undefined) return ignored
  return mode
}

function errorFromMessage(error: Extract<Message, { type: "error" }>["error"]) {
  return Object.assign(new Error(error.message), {
    name: error.name,
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.errno === undefined ? {} : { errno: error.errno }),
    ...(error.syscall === undefined ? {} : { syscall: error.syscall }),
    ...(error.path === undefined ? {} : { path: error.path }),
  })
}

function isMessage(value: unknown): value is Extract<Message, { type: "ready" | "exit" | "error" }> {
  if (!value || typeof value !== "object") return false
  if ("type" in value && value.type === "ready") return true
  if ("type" in value && value.type === "exit") return "code" in value && typeof value.code === "number"
  if ("type" in value && value.type === "error") {
    return (
      "error" in value &&
      typeof value.error === "object" &&
      value.error !== null &&
      "name" in value.error &&
      typeof value.error.name === "string" &&
      "message" in value.error &&
      typeof value.error.message === "string"
    )
  }
  return false
}

export function spawn(command: string, args: string[], opts: Options): Child {
  const [runner, ...prefix] = runnerInvocation()
  const ignoredStdin = opts.stdin === "ignore" || opts.stdin === undefined ? openSync(devNull, "r") : undefined
  const ignoredStdout = opts.stdout === "ignore" || opts.stdout === undefined ? openSync(devNull, "w") : undefined
  const ignoredStderr = opts.stderr === "ignore" || opts.stderr === undefined ? openSync(devNull, "w") : undefined
  let child: Runner
  try {
    child = launch(runner, [...prefix, "--windows-job-runner"], {
      cwd: process.cwd(),
      env: { ...process.env, [RUNNER_ENV]: "1" },
      stdio: [
        stdio(opts.stdin, "ignore", 0, ignoredStdin),
        stdio(opts.stdout, "ignore", 1, ignoredStdout),
        stdio(opts.stderr, "ignore", 2, ignoredStderr),
        "ipc",
      ] as unknown as StdioOptions,
      windowsHide: true,
    }) as Runner
  } finally {
    if (ignoredStdin !== undefined) closeSync(ignoredStdin)
    if (ignoredStdout !== undefined) closeSync(ignoredStdout)
    if (ignoredStderr !== undefined) closeSync(ignoredStderr)
  }

  const direct = Promise.withResolvers<number>()
  const managed = child as Managed
  const state = {
    targetExited: false,
    runner: child,
  }
  let started = false
  Object.defineProperty(managed, MANAGED, { value: state })
  Object.defineProperties(managed, {
    stdin: { value: opts.stdin === "ignore" || opts.stdin === undefined ? null : child.stdin },
    stdout: { value: opts.stdout === "pipe" ? child.stdout : null },
    stderr: { value: opts.stderr === "pipe" ? child.stderr : null },
  })
  managed.kill = () => {
    if (state.targetExited || !child.connected) return false
    child.send?.({ type: "terminate" } satisfies Message)
    return true
  }
  managed.exited = direct.promise

  child.once("spawn", () => {
    if (child.send === undefined) {
      direct.reject(new Error("Windows Job runner has no IPC channel"))
      child.kill("SIGKILL")
    }
  })
  child.once("error", (error) => {
    if (!state.targetExited) direct.reject(error)
  })
  child.once("close", (code, signal) => {
    if (state.targetExited) return
    direct.reject(new Error(`Windows Job runner exited before the target result (${signal ?? code ?? "unknown"})`))
  })
  child.on("message", (value: unknown) => {
    if (!isMessage(value) || state.targetExited) return
    if (value.type === "ready") {
      if (started || child.send === undefined) return
      started = true
      child.send(
        {
          type: "start",
          command,
          args,
          cwd: opts.cwd ?? process.cwd(),
          env: targetEnvironment(opts),
        } satisfies Message,
        (error) => {
          if (error === null || state.targetExited) return
          direct.reject(error)
          child.kill("SIGKILL")
        },
      )
      return
    }
    state.targetExited = true
    if (value.type === "exit") {
      direct.resolve(value.code)
      return
    }
    direct.reject(errorFromMessage(value.error))
  })
  void direct.promise.catch(() => undefined)
  return managed
}

export function isManaged(child: ChildProcess): child is Managed {
  return MANAGED in child
}

export function exited(child: Managed) {
  return child[MANAGED].targetExited
}

export function terminate(child: Managed) {
  if (!child[MANAGED].runner.connected) return
  child[MANAGED].runner.send?.({ type: "terminate" } satisfies Message)
}

export * as WindowsJob from "./windows-job"
