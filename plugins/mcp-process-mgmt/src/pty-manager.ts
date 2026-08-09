/**
 * PtyManager — PTY 会话管理（bun-pty 后端）。
 * 与 TerminalManager（pipe stdio）并存：PTY 适合交互式程序（REPL、全屏 TUI、需 stdin 的进程）。
 * 输出按行级 ring buffer 滚动（PTY_MAX_BUFFER_LINES），支持 regex 过滤与行号分页。
 */

import { spawn, type IPty } from "bun-pty"
import { randomUUID } from "node:crypto"
import { PTY_MAX_BUFFER_LINES } from "./config"

export interface PtySession {
  id: string
  pid: number
  pty: IPty
  command: string
  args: string[]
  title?: string
  startTime: number
  /** 行级 ring buffer（不含换行符） */
  lines: string[]
  /** 未完成行（chunk 尾部无换行的残段，跨 chunk 拼接） */
  pendingLine: string
  /** 增量读游标：无 offset 的 read 从此行号起返回新输出，读后推进 */
  readCursor: number
  exited: boolean
  exitCode: number | null
  error?: string
  /** 超时自毁定时器 */
  timeoutTimer?: ReturnType<typeof setTimeout>
}

export interface PtySpawnOptions {
  cwd?: string
  title?: string
  cols?: number
  rows?: number
  env?: Record<string, string>
  timeoutSeconds?: number
}

export interface PtyReadOptions {
  offset?: number
  limit?: number
  pattern?: string
  ignoreCase?: boolean
  /** 剥除 ANSI 转义序列（终端初始化/颜色码），默认 true——agent 读的是文本不是控制码 */
  stripAnsi?: boolean
}

export interface PtyReadResult {
  output: string
  offset: number
  totalLines: number
  matched: number
  exited: boolean
  exitCode: number | null
}

export interface PtyWaitResult {
  output: string
  exited: boolean
  exitCode: number | null
  ok: boolean
}

/** 解码 `\xNN` 转义序列（agent 在 JSON 里写 "\\x03" → 运行时 "\x03" → Ctrl+C）。 */
function decodeEscapes(data: string): string {
  return data.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

/** 剥除 ANSI CSI/OSC 转义序列（终端初始化、颜色码、标题设置等）。 */
function stripAnsiSeq(line: string): string {
  return line
    .replace(/\u001b\][^\u0007]*\u0007/g, "") // OSC: ESC ] ... BEL
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "") // CSI: ESC [ ... letter
    .replace(/\u001b[()][0-9A-B]/g, "") // charset select
}

export class PtyManager {
  private sessions = new Map<string, PtySession>()

  // -- lifecycle ---------------------------------------------------------

  async spawnPty(
    command: string,
    args: string[] = [],
    options: PtySpawnOptions = {},
  ): Promise<{ sessionId: string; pid: number; initialOutput: string }> {
    if (!command) throw new Error("command is required")
    const sessionId = randomUUID()

    // bun-pty 的 env 要求 Record<string, string>；process.env 允许 undefined，过滤掉
    const baseEnv = Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined),
    ) as Record<string, string>

    const pty = spawn(command, args, {
      name: options.title ?? "redcode-pty",
      cols: options.cols ?? 100,
      rows: options.rows ?? 30,
      cwd: options.cwd,
      env: options.env ? { ...baseEnv, ...options.env } : baseEnv,
    })

    const session: PtySession = {
      id: sessionId,
      pid: pty.pid,
      pty,
      command,
      args,
      title: options.title,
      startTime: Date.now(),
      lines: [],
      pendingLine: "",
      readCursor: 0,
      exited: false,
      exitCode: null,
    }

    pty.onData((chunk) => this.handleData(session, chunk))
    pty.onExit(({ exitCode }) => {
      session.exited = true
      session.exitCode = exitCode
      // 收尾：把残留的未完成行落进 buffer
      if (session.pendingLine) {
        session.lines.push(session.pendingLine)
        session.pendingLine = ""
        this.trimLines(session)
      }
    })

    if (options.timeoutSeconds && options.timeoutSeconds > 0) {
      session.timeoutTimer = setTimeout(() => {
        if (!session.exited) {
          session.error = `Timed out after ${options.timeoutSeconds}s`
          this.killSession(session)
        }
      }, options.timeoutSeconds * 1000)
    }

    this.sessions.set(sessionId, session)

    // 给进程一点时间产出初始输出（对齐 TerminalManager.startProcess 行为——
    // 否则 agent 在 spawn 返回后立即 write 会被启动中的 REPL 吞掉输入）
    await this.sleep(200)
    const initialOutput = session.lines.join("\n")

    return { sessionId, pid: pty.pid, initialOutput }
  }

  // -- I/O ---------------------------------------------------------------

  write(sessionId: string, data: string): void {
    const session = this.require(sessionId)
    if (session.exited) throw new Error(`PTY session ${sessionId} has already exited`)
    session.pty.write(decodeEscapes(data))
  }

  read(sessionId: string, options: PtyReadOptions = {}): PtyReadResult {
    const session = this.require(sessionId)

    // 无显式 offset = 增量读（从上次游标起），读后游标推进到扫描末尾；
    // 有显式 offset = 分页读，不动游标。
    const startIdx = options.offset ?? session.readCursor

    const stripAnsi = options.stripAnsi ?? true
    const lines = stripAnsi ? session.lines.map(stripAnsiSeq) : session.lines
    const scanned = lines.slice(startIdx)
    const regex = options.pattern ? new RegExp(options.pattern, options.ignoreCase ? "i" : "") : null
    const matched = regex ? scanned.filter((line) => regex.test(line)) : scanned
    const totalLines = session.lines.length
    const matchedTotal = matched.length

    const limit = options.limit ?? 200
    const offset = options.offset ?? 0
    const page = matched.slice(offset, offset + limit)

    if (options.offset === undefined) {
      session.readCursor = startIdx + scanned.length
    }

    return {
      output: page.join("\n"),
      offset,
      totalLines,
      matched: matchedTotal,
      exited: session.exited,
      exitCode: session.exitCode,
    }
  }

  /** 等待进程退出（或超时），返回等待期间的增量输出。替代轮询；MCP 协议下 server 无法主动 push。 */
  async wait(sessionId: string, options: { timeout?: number } = {}): Promise<PtyWaitResult> {
    const session = this.require(sessionId)
    const timeout = options.timeout ?? 30_000
    const startLine = session.lines.length
    const deadline = Date.now() + timeout

    while (Date.now() < deadline) {
      if (session.exited) {
        return {
          output: session.lines.slice(startLine).join("\n"),
          exited: true,
          exitCode: session.exitCode,
          ok: true,
        }
      }
      await this.sleep(100)
    }

    return {
      output: session.lines.slice(startLine).join("\n"),
      exited: session.exited,
      exitCode: session.exitCode,
      ok: session.exited,
    }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.require(sessionId)
    if (session.exited) throw new Error(`PTY session ${sessionId} has already exited`)
    session.pty.resize(cols, rows)
  }

  // -- termination -------------------------------------------------------

  kill(sessionId: string, cleanup = false): { exited: boolean; exitCode: number | null } {
    const session = this.require(sessionId)
    const result = this.killSession(session)
    if (cleanup) this.sessions.delete(sessionId)
    return result
  }

  // -- listing -----------------------------------------------------------

  list(): Array<{
    id: string
    pid: number
    command: string
    title?: string
    startedAt: number
    running: boolean
    lineCount: number
    exitCode: number | null
  }> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      pid: s.pid,
      command: s.command,
      title: s.title,
      startedAt: s.startTime,
      running: !s.exited,
      lineCount: s.lines.length,
      exitCode: s.exitCode,
    }))
  }

  // -- internal helpers --------------------------------------------------

  private require(sessionId: string): PtySession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`PTY session ${sessionId} not found`)
    return session
  }

  private handleData(session: PtySession, chunk: string): void {
    const combined = session.pendingLine + chunk
    const parts = combined.split(/\r\n|\n/)
    // 最后一段无换行 → 留给下一个 chunk
    session.pendingLine = parts.pop() ?? ""
    for (const part of parts) {
      session.lines.push(part.replace(/\r$/, ""))
    }
    this.trimLines(session)
  }

  private trimLines(session: PtySession): void {
    if (session.lines.length > PTY_MAX_BUFFER_LINES) {
      session.lines.splice(0, session.lines.length - PTY_MAX_BUFFER_LINES)
    }
  }

  private killSession(session: PtySession): { exited: boolean; exitCode: number | null } {
    if (session.timeoutTimer) clearTimeout(session.timeoutTimer)
    if (!session.exited) {
      try {
        session.pty.kill()
      } catch {
        // best-effort
      }
      // Windows 兜底：ConPTY 树杀（bun-pty kill 只发信号，可能留子进程）
      if (process.platform === "win32") {
        try {
          const { spawn } = require("node:child_process") as typeof import("node:child_process")
          spawn("taskkill", ["/PID", String(session.pid), "/F", "/T"])
        } catch {
          // best-effort
        }
      }
      session.exited = true
      session.exitCode = null
    }
    return { exited: true, exitCode: session.exitCode }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }
}
