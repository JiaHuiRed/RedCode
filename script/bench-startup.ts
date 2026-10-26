#!/usr/bin/env bun

import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readFileSync } from "node:fs"
import { parseBudgetConfig } from "./check-entry-graphs"

type Mode = "cli" | "server"
type Overrides = {
  mode?: Mode
  runs?: number
  warmup?: number
  timeoutMs?: number
  entry?: string
  healthPath?: string
  help?: boolean
}

type ChildContext = {
  startedAt: number
  deadline: number
  signal: AbortSignal
  stdout: () => string
  stderr: () => string
}

type ChildOptions = {
  cwd: string
  env?: Record<string, string>
  timeoutMs: number
  label?: string
  signal?: AbortSignal
}

const OUTPUT_LIMIT = 32 * 1024

function capture(stream: ReadableStream<Uint8Array>) {
  let text = ""
  const done = (async () => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      text = (text + decoder.decode(chunk.value, { stream: true })).slice(-OUTPUT_LIMIT)
    }
    text = (text + decoder.decode()).slice(-OUTPUT_LIMIT)
  })()
  return { done, text: () => text }
}

export async function withChildProcess<T>(
  command: string[],
  options: ChildOptions,
  action: (child: Bun.Subprocess, context: ChildContext) => Promise<T>,
) {
  const startedAt = performance.now()
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = capture(child.stdout)
  const stderr = capture(child.stderr)
  const controller = new AbortController()
  const deadline = startedAt + options.timeoutMs
  const context: ChildContext = {
    startedAt,
    deadline,
    signal: controller.signal,
    stdout: stdout.text,
    stderr: stderr.text,
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  let rejectTimeout: (error: Error) => void = () => {}
  let interrupted = false
  const interrupt = (message: string) => {
    if (interrupted) return
    interrupted = true
    controller.abort()
    if (child.exitCode === null) child.kill("SIGKILL")
    rejectTimeout(new Error(message))
  }
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject
    timeout = setTimeout(
      () => interrupt(`${options.label ?? "child"} timed out after ${options.timeoutMs}ms`),
      options.timeoutMs,
    )
  })
  const cancel = () => interrupt(`${options.label ?? "child"} cancelled`)
  options.signal?.addEventListener("abort", cancel, { once: true })
  if (options.signal?.aborted) cancel()
  const work = Promise.resolve()
    .then(() => action(child, context))
    .then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )

  try {
    const result = await Promise.race([work, timeoutPromise])
    if (!result.ok) throw result.error
    return result.value
  } finally {
    if (timeout) clearTimeout(timeout)
    options.signal?.removeEventListener("abort", cancel)
    controller.abort()
    if (child.exitCode === null) child.kill("SIGKILL")
    // 261026 Red Await only our killed child; a watchdog must not wait for its pipes or uncooperative action.
    await child.exited
    if (!interrupted) {
      await Promise.all([stdout.done, stderr.done])
    }
  }
}

export function summarizeSamples(warmups: number[], samples: number[]) {
  if (samples.length === 0) throw new Error("at least one measured sample is required")
  const sorted = samples.toSorted((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
  // 261026 Red Warmup values are deliberately excluded from every reported statistic.
  void warmups
  return {
    samples,
    min: sorted[0] ?? 0,
    median,
    average: samples.reduce((sum, sample) => sum + sample, 0) / samples.length,
    max: sorted.at(-1) ?? 0,
  }
}

export function isHealthyResponse(status: number, body: unknown) {
  return (
    status === 200 &&
    typeof body === "object" &&
    body !== null &&
    "healthy" in body &&
    body.healthy === true &&
    "version" in body &&
    typeof body.version === "string"
  )
}

export function hasCliStartupMarker(output: string) {
  const marker = output.trim().split(/\r?\n/).at(-1)?.trim()
  return marker !== undefined && marker.length > 0 && Number.isFinite(Number(marker))
}

function parseArgs(args: string[]): Overrides {
  const result: Overrides = {}
  for (let index = 0; index < args.length; index++) {
    const name = args[index]
    if (name === "--help" || name === "-h") {
      result.help = true
      continue
    }
    if (!["--mode", "--runs", "--warmup", "--timeout-ms", "--entry", "--health-path"].includes(name))
      throw new Error(`unknown argument: ${name}`)
    const value = args[++index]
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`)
    if (name === "--mode") {
      if (value !== "cli" && value !== "server") throw new Error("--mode must be cli or server")
      result.mode = value
    }
    if (name === "--runs") result.runs = Number(value)
    if (name === "--warmup") result.warmup = Number(value)
    if (name === "--timeout-ms") result.timeoutMs = Number(value)
    if (name === "--entry") result.entry = value
    if (name === "--health-path") result.healthPath = value
  }
  return result
}

function resolveOptions(defaults: ReturnType<typeof parseBudgetConfig>["startup"], overrides: Overrides) {
  const mode = overrides.mode
  if (!mode) throw new Error("--mode cli|server is required")
  const runs = overrides.runs ?? defaults.runs
  const warmup = overrides.warmup ?? defaults.warmup
  const timeoutMs = overrides.timeoutMs ?? defaults.timeoutMs
  for (const [name, value, minimum] of [
    ["runs", runs, 1],
    ["warmup", warmup, 0],
    ["timeoutMs", timeoutMs, 1],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
  }
  const entry = overrides.entry ?? (mode === "cli" ? defaults.cliEntry : defaults.serverEntry)
  const healthPath = overrides.healthPath ?? defaults.healthPath
  if (
    typeof entry !== "string" ||
    entry.startsWith("/") ||
    /^[a-z]:/i.test(entry) ||
    entry.replaceAll("\\", "/").split("/").includes("..") ||
    !entry.startsWith("packages/opencode/")
  )
    throw new Error("entry must be a repository-relative path inside packages/opencode")
  if (!healthPath.startsWith("/") || healthPath.startsWith("//") || healthPath.includes("?") || healthPath.includes("#"))
    throw new Error("healthPath must be an absolute path without query or fragment")
  return {
    mode,
    runs,
    warmup,
    timeoutMs,
    probeTimeoutMs: defaults.probeTimeoutMs,
    pollIntervalMs: defaults.pollIntervalMs,
    entry,
    healthPath,
  }
}

function isolatedEnv(home: string) {
  const env: Record<string, string> = {}
  for (const name of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  const redcodeHome = path.join(home, ".redcode")
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    REDCODE_TEST_HOME: home,
    REDCODE_CONFIG_DIR: redcodeHome,
    REDCODE_DB: path.join(redcodeHome, "data", "benchmark.db"),
    REDCODE_PURE: "1",
    REDCODE_DISABLE_MODELS_FETCH: "1",
    REDCODE_DISABLE_PLUGIN_DEP_INSTALL: "1",
  })
  return env
}

function listeningOrigin(output: string) {
  const match = /redcode server listening on (http:\/\/\S+)/.exec(output)
  if (!match) return undefined
  const url = new URL(match[1])
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname) ||
    !url.port ||
    Number(url.port) < 1 ||
    Number(url.port) > 65535
  )
    throw new Error(`server announced a non-loopback or invalid benchmark address: ${url.href}`)
  return url.origin
}

async function probeServer(origin: string, healthPath: string, signal: AbortSignal) {
  const response = await fetch(new URL(healthPath, origin), { signal })
  // 261026 Red A non-JSON or incomplete response is a not-ready probe, not a benchmark success.
  const body = await response.json().catch(() => undefined)
  return isHealthyResponse(response.status, body)
}

async function waitForServer(
  child: Bun.Subprocess,
  context: ChildContext,
  healthPath: string,
  probeTimeoutMs: number,
  pollIntervalMs: number,
) {
  while (true) {
    if (context.signal.aborted) throw new Error("server health check cancelled")
    if (child.exitCode !== null)
      throw new Error(`server exited with code ${child.exitCode} before health became ready`)
    const origin = listeningOrigin(`${context.stdout()}\n${context.stderr()}`)
    if (origin) {
      // 261026 Red The listener address discovers a port only; a successful health payload defines readiness.
      try {
        if (
          await probeServer(
            origin,
            healthPath,
            AbortSignal.any([context.signal, AbortSignal.timeout(probeTimeoutMs)]),
          )
        )
          return performance.now() - context.startedAt
      } catch {
        // The loopback listener can refuse connections or time out until the health handler is ready.
        if (context.signal.aborted) throw new Error("server health check cancelled")
      }
    }
    await Bun.sleep(pollIntervalMs)
  }
}

async function runSample(
  options: ReturnType<typeof resolveOptions>,
  root: string,
  home: string,
  scratchParent: string,
  defaults: ReturnType<typeof parseBudgetConfig>["startup"],
  signal: AbortSignal,
) {
  const packageRoot = path.join(root, "packages", "opencode")
  const entryPath = path.resolve(root, options.entry)
  const relativeEntry = path.relative(packageRoot, entryPath)
  if (relativeEntry.startsWith(`..${path.sep}`) || relativeEntry === ".." || path.isAbsolute(relativeEntry))
    throw new Error(`entry is outside packages/opencode: ${options.entry}`)
  if (!/\.tsx?$/i.test(entryPath) || !readFileSync(entryPath, "utf8"))
    throw new Error(`entry must be a readable TypeScript source: ${options.entry}`)
  const parent = await stat(scratchParent)
  if (!parent.isDirectory()) throw new Error(`scratch project parent is not a directory: ${scratchParent}`)
  const cwd = await mkdtemp(path.join(scratchParent, "project-"))
  const args = options.mode === "cli" ? defaults.cliArgs : defaults.serverArgs
  const command = [process.execPath, "run", "--conditions=browser", entryPath, ...args]
  return withChildProcess(
    command,
    {
      cwd,
      env: isolatedEnv(home),
      timeoutMs: options.timeoutMs,
      label: `${options.mode} startup`,
      signal,
    },
    async (child, context) => {
      if (options.mode === "cli") {
        const exitCode = await child.exited
        if (exitCode !== 0) throw new Error(`CLI startup exited with code ${exitCode}: ${context.stderr()}`)
        const output = context.stdout().trim()
        if (!hasCliStartupMarker(output))
          throw new Error(`debug startup did not emit its timing marker: ${output}`)
        return performance.now() - context.startedAt
      }
      return waitForServer(
        child,
        context,
        options.healthPath,
        options.probeTimeoutMs,
        options.pollIntervalMs,
      )
    },
  )
}

async function main(args: string[]) {
  const overrides = parseArgs(args)
  if (overrides.help) {
    console.log(
      "Usage: bun run bench:startup -- --mode cli|server [--runs N] [--warmup N] [--timeout-ms N] [--entry PATH] [--health-path PATH]",
    )
    return
  }
  const root = path.resolve(import.meta.dir, "..")
  const config = parseBudgetConfig(JSON.parse(readFileSync(path.join(import.meta.dir, "entry-graph-budgets.json"), "utf8")) as unknown)
  const options = resolveOptions(config.startup, overrides)
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "redcode-startup-bench-"))
  const home = path.join(tempRoot, "home")
  const tempStat = await stat(tempRoot)
  if (!tempStat.isDirectory()) throw new Error(`temporary benchmark root is not a directory: ${tempRoot}`)
  const scratchParent = path.join(tempRoot, "project-cwds")
  await mkdir(scratchParent)
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once("SIGINT", cancel)
  process.once("SIGTERM", cancel)
  try {
    const warmups: number[] = []
    const samples: number[] = []
    for (let index = 0; index < options.warmup; index++) {
      const value = await runSample(
        options,
        root,
        path.join(home, `warmup-${index + 1}`),
        scratchParent,
        config.startup,
        controller.signal,
      )
      warmups.push(value)
      console.log(`warmup ${index + 1}/${options.warmup}: ${value.toFixed(2)}ms (excluded)`)
    }
    for (let index = 0; index < options.runs; index++) {
      const value = await runSample(
        options,
        root,
        path.join(home, `sample-${index + 1}`),
        scratchParent,
        config.startup,
        controller.signal,
      )
      samples.push(value)
      console.log(`sample ${index + 1}/${options.runs}: ${value.toFixed(2)}ms`)
    }
    const summary = summarizeSamples(warmups, samples)
    console.log(
      `startup mode=${options.mode} readiness=${options.mode === "cli" ? "debug-startup-exit-0" : `GET ${options.healthPath} healthy=true`}`,
    )
    console.log(
      `stats min=${summary.min.toFixed(2)}ms median=${summary.median.toFixed(2)}ms ` +
        `avg=${summary.average.toFixed(2)}ms max=${summary.max.toFixed(2)}ms runs=${summary.samples.length}`,
    )
    console.log(`samples_ms=${summary.samples.map((sample) => sample.toFixed(2)).join(",")}`)
  } finally {
    process.removeListener("SIGINT", cancel)
    process.removeListener("SIGTERM", cancel)
    await rm(tempRoot, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  main(Bun.argv.slice(2)).catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
