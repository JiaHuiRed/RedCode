#!/usr/bin/env bun
/**
 * mcp-process-mgmt — MCP server for local process management.
 * Start, interact with, and terminate shell sessions via MCP tools.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { TerminalManager } from "./terminal-manager"
import { PtyManager } from "./pty-manager"

const manager = new TerminalManager()
const ptyManager = new PtyManager()

// -- Tool definitions -----------------------------------------------------

const TOOLS = [
  {
    name: "start_process",
    description:
      "Start a shell command in a new process. Returns a session ID for subsequent I/O.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run (optional — omit to start an interactive shell)" },
        cwd: { type: "string", description: "Working directory (optional)" },
        timeout: { type: "number", description: "Timeout in ms (default 30000)" },
      },
      required: [],
    },
  },
  {
    name: "list_processes",
    description: "List all active (and recently finished) process sessions.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_process_output",
    description: "Read output from a process session, with optional offset/limit for pagination.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID from start_process" },
        offset: { type: "number", description: "Character offset to read from" },
        limit: { type: "number", description: "Max characters to return (default 2000)" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "send_input",
    description: "Send text to a running process's stdin.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID" },
        input: { type: "string", description: "Text to write to stdin" },
      },
      required: ["session_id", "input"],
    },
  },
  {
    name: "wait_for_prompt",
    description: "Wait for a REPL prompt or process completion. Use after send_input to wait for the process to be ready for more input.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID" },
        timeout: { type: "number", description: "Max wait time in ms (default 10000)" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "stop_process",
    description: "Force-terminate a process session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session ID" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "pty_spawn",
    description:
      "Spawn a command in a real PTY (pseudo-terminal). Use for interactive programs (REPL, dev servers, full-screen TUI). Returns a session ID for subsequent I/O. Note: REPL input needs \\r\\n on Windows (real Enter semantics).",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Executable to run (do NOT wrap in a shell)" },
        args: { type: "array", items: { type: "string" }, description: "Arguments (optional)" },
        cwd: { type: "string", description: "Working directory (optional)" },
        title: { type: "string", description: "Session title (optional)" },
        cols: { type: "number", description: "Terminal columns (default 100)" },
        rows: { type: "number", description: "Terminal rows (default 30)" },
        timeoutSeconds: { type: "number", description: "Auto-kill after N seconds (optional)" },
      },
      required: ["command"],
    },
  },
  {
    name: "pty_write",
    description:
      "Send input to a PTY session. Escape sequences supported: \\x03 (Ctrl+C), \\x1b (ESC), etc.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "PTY session ID from pty_spawn" },
        data: { type: "string", description: "Text/escape sequences to write" },
      },
      required: ["session_id", "data"],
    },
  },
  {
    name: "pty_read",
    description:
      "Read PTY output with line-based pagination. Without offset: incremental read — returns only new output since the last read (cursor advances). With offset: paged read of the full buffer (cursor untouched). Optional regex filter and ANSI stripping (default on).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "PTY session ID" },
        offset: { type: "number", description: "Line offset for paged read (default: incremental from last read)" },
        limit: { type: "number", description: "Max lines to return (default 200)" },
        pattern: { type: "string", description: "Regex to filter lines (optional)" },
        ignoreCase: { type: "boolean", description: "Case-insensitive regex (default false)" },
        strip_ansi: { type: "boolean", description: "Strip ANSI escape sequences (default true)" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "pty_kill",
    description: "Terminate a PTY session. cleanup=true also removes it from the session list.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "PTY session ID" },
        cleanup: { type: "boolean", description: "Remove session after kill (default false)" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "pty_wait",
    description:
      "Wait for a PTY process to exit (or timeout), returning output produced while waiting. Use after long-running tasks instead of polling.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "PTY session ID" },
        timeout: { type: "number", description: "Max wait in ms (default 30000)" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "pty_resize",
    description: "Resize a PTY session (for full-screen programs like vim, top).",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "PTY session ID" },
        cols: { type: "number", description: "Columns" },
        rows: { type: "number", description: "Rows" },
      },
      required: ["session_id", "cols", "rows"],
    },
  },
  {
    name: "pty_list",
    description: "List all PTY sessions with status.",
    inputSchema: { type: "object", properties: {} },
  },
]

// -- Handlers -------------------------------------------------------------

function setupHandlers(srv: Server): void {
  srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  srv.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: args } = request.params

    try {
      switch (name) {
        case "start_process": {
          const { command, cwd, timeout } = args as { command?: string; cwd?: string; timeout?: number }
          const result = await manager.startProcess(command, { cwd, timeout })
          return {
            content: [{ type: "text", text: JSON.stringify({ session_id: result.sessionId, pid: result.pid, initial_output: result.initialOutput }) }],
          }
        }

        case "list_processes": {
          return { content: [{ type: "text", text: JSON.stringify(manager.listSessions(), null, 2) }] }
        }

        case "read_process_output": {
          const { session_id, offset, limit } = args as { session_id: string; offset?: number; limit?: number }
          const result = manager.readOutput(session_id, { offset, limit })
          return {
            content: [{ type: "text", text: JSON.stringify({ output: result.output, offset: result.offset, total_length: result.totalLength, exited: result.exited, exit_code: result.exitCode }) }],
          }
        }

        case "send_input": {
          const { session_id, input } = args as { session_id: string; input: string }
          manager.sendInput(session_id, input)
          return { content: [{ type: "text", text: `Sent input to session ${session_id}` }] }
        }

        case "wait_for_prompt": {
          const { session_id, timeout } = args as { session_id: string; timeout?: number }
          const result = await manager.waitForPrompt(session_id, { timeout })
          return { content: [{ type: "text", text: JSON.stringify({ output: result.output, prompt_detected: result.prompt, ok: result.ok }) }] }
        }

        case "stop_process": {
          const { session_id } = args as { session_id: string }
          const result = manager.forceTerminate(session_id)
          return { content: [{ type: "text", text: JSON.stringify({ exited: result.exited, exit_code: result.exitCode }) }] }
        }

        case "pty_spawn": {
          const { command, args: ptyArgs, cwd, title, cols, rows, timeoutSeconds } = args as {
            command: string
            args?: string[]
            cwd?: string
            title?: string
            cols?: number
            rows?: number
            timeoutSeconds?: number
          }
          const result = await ptyManager.spawnPty(command, ptyArgs ?? [], { cwd, title, cols, rows, timeoutSeconds })
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  session_id: result.sessionId,
                  pid: result.pid,
                  initial_output: result.initialOutput,
                }),
              },
            ],
          }
        }

        case "pty_write": {
          const { session_id, data } = args as { session_id: string; data: string }
          ptyManager.write(session_id, data)
          return { content: [{ type: "text", text: `Sent input to PTY session ${session_id}` }] }
        }

        case "pty_read": {
          const { session_id, offset, limit, pattern, ignoreCase, strip_ansi } = args as {
            session_id: string
            offset?: number
            limit?: number
            pattern?: string
            ignoreCase?: boolean
            strip_ansi?: boolean
          }
          const result = ptyManager.read(session_id, { offset, limit, pattern, ignoreCase, stripAnsi: strip_ansi })
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  output: result.output,
                  offset: result.offset,
                  total_lines: result.totalLines,
                  matched: result.matched,
                  exited: result.exited,
                  exit_code: result.exitCode,
                }),
              },
            ],
          }
        }

        case "pty_kill": {
          const { session_id, cleanup } = args as { session_id: string; cleanup?: boolean }
          const result = ptyManager.kill(session_id, cleanup)
          return { content: [{ type: "text", text: JSON.stringify({ exited: result.exited, exit_code: result.exitCode }) }] }
        }

        case "pty_wait": {
          const { session_id, timeout } = args as { session_id: string; timeout?: number }
          const result = await ptyManager.wait(session_id, { timeout })
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  output: result.output,
                  exited: result.exited,
                  exit_code: result.exitCode,
                  ok: result.ok,
                }),
              },
            ],
          }
        }

        case "pty_resize": {
          const { session_id, cols, rows } = args as { session_id: string; cols: number; rows: number }
          ptyManager.resize(session_id, cols, rows)
          return { content: [{ type: "text", text: `Resized PTY session ${session_id} to ${cols}x${rows}` }] }
        }

        case "pty_list": {
          return { content: [{ type: "text", text: JSON.stringify(ptyManager.list(), null, 2) }] }
        }

        default:
          throw new Error(`Unknown tool: ${name}`)
      }
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: String(err) }] }
    }
  })
}

// -- Entry points ---------------------------------------------------------

export function createServer(): Server {
  const srv = new Server(
    { name: "mcp-process-mgmt", version: "0.1.0" },
    { capabilities: { tools: {} } },
  )
  setupHandlers(srv)
  return srv
}

if (import.meta.main) {
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
