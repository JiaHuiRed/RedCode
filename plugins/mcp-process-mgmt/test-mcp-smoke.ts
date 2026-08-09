// MCP 协议级冒烟：连真实 server，验证 pty 工具全链路
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", "src/index.ts"],
})
const client = new Client({ name: "smoke", version: "1.0.0" })
await client.connect(transport)

// tools/list — 确认 pty 工具注册
const { tools } = await client.listTools()
const ptyTools = tools.filter((t) => t.name.startsWith("pty_"))
console.log(`[tools] total=${tools.length}, pty=${ptyTools.length}: ${ptyTools.map((t) => t.name).join(", ")}`)

// pty_spawn node REPL
const spawn = await client.callTool({ name: "pty_spawn", arguments: { command: "node", title: "mcp-smoke" } })
const spawnText = (spawn.content as Array<{ type: string; text: string }>)[0].text
const { session_id, pid, initial_output } = JSON.parse(spawnText)
console.log(`[spawn] session=${session_id} pid=${pid}`)
console.log(`[spawn initial_output] ${JSON.stringify(initial_output?.slice(0, 120))}`)

// 诊断：原始输出
await new Promise((r) => setTimeout(r, 800))
const diag = await client.callTool({ name: "pty_read", arguments: { session_id, limit: 30, strip_ansi: false } })
const diagText = JSON.parse((diag.content as Array<{ type: string; text: string }>)[0].text)
console.log(`[diag raw] ${JSON.stringify(diagText.output.slice(0, 200))}`)

// pty_write + pty_read 交互
const writeResp = await client.callTool({ name: "pty_write", arguments: { session_id, data: "6*7\r\n" } })
console.log(`[write resp] ${JSON.stringify(writeResp)}`)
await new Promise((r) => setTimeout(r, 800))
const readRaw = await client.callTool({ name: "pty_read", arguments: { session_id, limit: 40, strip_ansi: false, offset: 0 } })
const rawParsed = JSON.parse((readRaw.content as Array<{ type: string; text: string }>)[0].text)
console.log(`[read raw offset0] ${JSON.stringify(rawParsed.output.slice(0, 300))}`)
const read = await client.callTool({ name: "pty_read", arguments: { session_id, limit: 20 } })
const readText = (read.content as Array<{ type: string; text: string }>)[0].text
const parsed = JSON.parse(readText)
console.log(`[read] total_lines=${parsed.total_lines} offset=${parsed.offset} matched=${parsed.matched}`)
console.log(`[read] output=${JSON.stringify(parsed.output.slice(-60))} exited=${parsed.exited}`)
console.log(`[check] contains '42' = ${parsed.output.includes("42")}`)

// pty_list
const list = await client.callTool({ name: "pty_list", arguments: {} })
console.log(`[list] ${(list.content as Array<{ type: string; text: string }>)[0].text.slice(0, 120)}`)

// pty_kill
const kill = await client.callTool({ name: "pty_kill", arguments: { session_id, cleanup: true } })
console.log(`[kill] ${(kill.content as Array<{ type: string; text: string }>)[0].text}`)

await client.close()
console.log("[done] MCP smoke passed")
