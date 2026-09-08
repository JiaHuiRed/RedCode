import { expect, test } from "bun:test"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import { WindowsJobStdioClientTransport } from "../../src/mcp/stdio"

test("stdio transport sends and receives JSON-RPC messages", async () => {
  const server = [
    'let input = ""',
    'process.stdin.on("data", (chunk) => {',
    "  input += chunk",
    "  let newline",
    '  while ((newline = input.indexOf("\\n")) !== -1) {',
    "    const line = input.slice(0, newline)",
    "    input = input.slice(newline + 1)",
    "    const message = JSON.parse(line)",
    '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true } }) + "\\n")',
    "  }",
    "})",
  ].join("\n")
  const transport = new WindowsJobStdioClientTransport({
    command: process.platform === "win32" ? "node" : process.execPath,
    args: ["-e", server],
    stderr: "pipe",
  })
  const response = new Promise<JSONRPCMessage>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for JSON-RPC response")), 5_000)
    transport.onmessage = (message) => {
      clearTimeout(timer)
      resolve(message)
    }
    transport.onerror = (error) => {
      clearTimeout(timer)
      reject(error)
    }
    transport.onclose = () => {
      clearTimeout(timer)
      reject(new Error("MCP server closed before response"))
    }
  })

  try {
    await transport.start()
    await transport.send({ jsonrpc: "2.0", id: 1, method: "ping", params: {} })
    expect(await response).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    })
  } finally {
    await transport.close()
  }
}, 10_000)
