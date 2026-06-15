import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { DEFAULT_COMMAND_TIMEOUT, DEFAULT_OUTPUT_LIMIT } from "./config"
import { analyzeProcessState } from "./process-detection"

export interface TerminalSession {
  id: string
  pid: number
  process: ChildProcess
  shell: string
  command: string
  startTime: number
  /** Accumulated stdout + stderr output, UTF-8 clean */
  output: string
  /** Whether this process has exited */
  exited: boolean
  exitCode: number | null
  errorOutput: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Detect the available shell on the current platform. */
function getShell(): { shell: string; args: string[] } {
  if (process.platform === "win32") {
    return { shell: "cmd.exe", args: ["/Q"] }
  }
  return { shell: "bash", args: ["--norc"] }
}

/** Attempt to fix corrupt PATHEXT on Windows. */
function ensurePathext(): void {
  if (process.platform !== "win32") return
  const pathext = process.env.PATHEXT
  if (!pathext || !pathext.includes(".EXE")) {
    process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC"
  }
}

// ---------------------------------------------------------------------------
// Terminal Manager
// ---------------------------------------------------------------------------

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>()

  constructor() {
    ensurePathext()
  }

  // -- lifecycle ---------------------------------------------------------

  async startProcess(
    command?: string,
    options?: { timeout?: number; cwd?: string; env?: Record<string, string> },
  ): Promise<{ sessionId: string; pid: number; initialOutput: string }> {
    const { shell, args } = getShell()
    const sessionId = randomUUID()

    // Spawn interactive shell — no command arg
    const child = spawn(shell, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: options?.cwd,
      env: options?.env ? { ...process.env, ...options.env } : process.env,
      windowsHide: true,
      windowsVerbatimArguments: process.platform === "win32",
      timeout: options?.timeout ?? DEFAULT_COMMAND_TIMEOUT,
    })

    const session: TerminalSession = {
      id: sessionId,
      pid: child.pid ?? 0,
      process: child,
      shell,
      command: command ?? "",
      startTime: Date.now(),
      output: "",
      exited: false,
      exitCode: null,
      errorOutput: "",
    }

    // If a command was provided, send it via stdin
    if (command) {
      const toSend = command.endsWith("\n") ? command : command + "\n"
      child.stdin?.write(toSend)
    }

    // Background reader: collect stdout
    child.stdout?.on("data", (chunk: Buffer) => {
      // Strip null bytes (Windows quirk)
      session.output += chunk.toString("utf-8").replace(/\0/g, "")
    })

    // Background reader: collect stderr
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").replace(/\0/g, "")
      session.errorOutput += text
      session.output += text // merge into main output for simplicity
    })

    // Handle exit
    child.on("exit", (code) => {
      session.exited = true
      session.exitCode = code
    })

    child.on("error", (err) => {
      session.exited = true
      session.exitCode = -1
      session.errorOutput += `Process error: ${err.message}\n`
      session.output += `Process error: ${err.message}\n`
    })

    this.sessions.set(sessionId, session)

    // Give the process a moment to produce initial output
    await this.sleep(200)

    const initialOutput = this.readOutputRaw(session)
    return { sessionId, pid: child.pid ?? 0, initialOutput }
  }

  // -- I/O ---------------------------------------------------------------

  sendInput(sessionId: string, input: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)
    if (session.exited) throw new Error(`Session ${sessionId} has already exited`)

    session.process.stdin?.write(input)
  }

  readOutput(
    sessionId: string,
    options?: { offset?: number; limit?: number },
  ): { output: string; offset: number; totalLength: number; exited: boolean; exitCode: number | null } {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)

    const full = session.output
    const totalLength = full.length
    const offset = options?.offset ?? Math.max(0, totalLength - DEFAULT_OUTPUT_LIMIT)
    const limit = options?.limit ?? DEFAULT_OUTPUT_LIMIT

    return {
      output: full.slice(offset, offset + limit),
      offset,
      totalLength,
      exited: session.exited,
      exitCode: session.exitCode,
    }
  }

  /** Wait for REPL prompt or timeout, then return new output. */
  async waitForPrompt(
    sessionId: string,
    options?: { timeout?: number; pollInterval?: number },
  ): Promise<{ output: string; prompt: string | undefined; ok: boolean }> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)

    const timeout = options?.timeout ?? 10_000
    const pollMs = options?.pollInterval ?? 200
    const deadline = Date.now() + timeout

    // Snapshot of output length before waiting
    const startLen = session.output.length

    while (Date.now() < deadline) {
      const newOutput = session.output.slice(startLen)
      const state = analyzeProcessState(newOutput)

      if (state.isWaitingForInput) {
        return { output: newOutput, prompt: state.detectedPrompt, ok: true }
      }
      if (session.exited) {
        return { output: newOutput, prompt: undefined, ok: true }
      }

      await this.sleep(pollMs)
    }

    return { output: session.output.slice(startLen), prompt: undefined, ok: false }
  }

  // -- termination -------------------------------------------------------

  forceTerminate(sessionId: string): { exited: boolean; exitCode: number | null } {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)

    if (!session.exited) {
      session.process.kill("SIGTERM")
      // On Windows fallback: taskkill
      if (process.platform === "win32") {
        try {
          spawn("taskkill", ["/PID", String(session.pid), "/F", "/T"])
        } catch {
          // best-effort
        }
      }
      session.exited = true
      session.exitCode = null
    }

    this.sessions.delete(sessionId)
    return { exited: true, exitCode: session.exitCode }
  }

  // -- listing -----------------------------------------------------------

  listSessions(): Array<{
    id: string
    pid: number
    shell: string
    command: string
    startedAt: number
    running: boolean
    outputLength: number
  }> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      pid: s.pid,
      shell: s.shell,
      command: s.command,
      startedAt: s.startTime,
      running: !s.exited,
      outputLength: s.output.length,
    }))
  }

  getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId)
  }

  // -- internal helpers --------------------------------------------------

  private readOutputRaw(session: TerminalSession): string {
    const len = session.output.length
    return session.output.slice(Math.max(0, len - DEFAULT_OUTPUT_LIMIT), len)
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }
}
