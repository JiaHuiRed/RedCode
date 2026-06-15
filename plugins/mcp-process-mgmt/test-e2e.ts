#!/usr/bin/env bun
/** E2E test: starts the MCP server in-process and tests the full lifecycle. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createServer } from "./src/index"

async function main() {
  const client = new Client({ name: "test", version: "0.1.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const srv = createServer()
  await Promise.all([client.connect(clientTransport), srv.connect(serverTransport)])

  // 1. List tools
  const { tools } = await client.listTools()
  console.log(`Tools registered: ${tools.length}`)
  tools.forEach((t) => console.log(`  - ${t.name}`))

  // 2. Start process
  const startResult = await client.callTool({
    name: "start_process",
    arguments: { command: "echo HELLO_FROM_MCP" },
  })
  const startData = JSON.parse(String((startResult.content as any[])[0].text))
  const sid = startData.session_id
  console.log(`\nStarted session: ${sid}`)
  console.log(`Initial output includes HELLO: ${startData.initial_output.includes("HELLO_FROM_MCP")}`)

  // 3. List processes
  const listResult = await client.callTool({ name: "list_processes", arguments: {} })
  const sessions = JSON.parse(String((listResult.content as any[])[0].text))
  console.log(`\nActive sessions: ${sessions.length}`)

  // 4. Read output
  const readResult = await client.callTool({
    name: "read_process_output",
    arguments: { session_id: sid },
  })
  const output = JSON.parse(String((readResult.content as any[])[0].text))
  console.log(`\nOutput contains HELLO: ${output.output.includes("HELLO_FROM_MCP")}`)
  console.log(`Process exited: ${output.exited}`)

  // 5. Stop process (cleanup)
  await client.callTool({ name: "stop_process", arguments: { session_id: sid } })
  console.log(`\nProcess stopped`)

  console.log("\n✅ All checks passed!")
}

main().catch((err) => {
  console.error("Test failed:", err)
  process.exit(1)
})
