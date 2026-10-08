// 261008 Red stdio 真 transport 探针：必须在独立子进程里跑。
// lifecycle.test.ts 顶层 mock.module 会替换整个进程的模块注册表，同进程里
// 本模块拿到的是假 transport（组跑必挂、单跑才过的指纹）。探针由
// stdio.test.ts 以 `bun run` 拉起，注册表干净，退出码 0 = JSON-RPC 往返成功。
import { WindowsJobStdioClientTransport } from "../../../src/mcp/stdio"

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

const response = new Promise<unknown>((resolve, reject) => {
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
  const result = await response
  if (
    (result as { jsonrpc?: string; id?: number; result?: { ok?: boolean } }).result?.ok !== true ||
    (result as { id?: number }).id !== 1
  ) {
    console.error(`unexpected JSON-RPC response: ${JSON.stringify(result)}`)
    process.exit(1)
  }
  await transport.close()
  process.exit(0)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  await transport.close().catch(() => {})
  process.exit(1)
}
