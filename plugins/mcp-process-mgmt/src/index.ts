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

const manager = new TerminalManager()

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
