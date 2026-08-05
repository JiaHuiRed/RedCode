import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function main() {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "./index.ts"],
    cwd: "D:\\AI\\RedCode\\.opencode\\search-server",
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  const tools = await client.listTools();
  console.error("Tools:", JSON.stringify(tools.tools.map(t => t.name)));
  const result = await client.callTool({ name: "web_search", arguments: { query: "hello world", count: 2 } });
  console.error("Result:", JSON.stringify(result).slice(0, 800));
  await client.close();
}

main().catch(e => { console.error("Error:", e.message); process.exit(1); });
