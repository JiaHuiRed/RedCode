import { defineConfig } from "tsup";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";

export default defineConfig({
  entry: [
    "cli.ts",
    "server.ts",
    "check.ts",
    "smoke-test.ts",
    "benchmark.ts",
    "config.ts",
    "module-graph.ts",
    "tsserver-client.ts",
    "graph-queries.ts",
  ],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  splitting: false,
  clean: true,
  external: [
    "@clack/prompts",
    "@modelcontextprotocol/sdk",
    "oxc-parser",
    "oxc-resolver",
    "zod",
  ],
  async onSuccess() {
    // Strip shebangs from all compiled files, then add node shebang to cli.js
    for (const file of readdirSync("dist").filter((f) => f.endsWith(".js"))) {
      const filePath = `dist/${file}`;
      let content = readFileSync(filePath, "utf-8");
      content = content.replace(/^#!.*\n/gm, "");
      if (file === "cli.js") {
        content = "#!/usr/bin/env node\n" + content;
      }
      writeFileSync(filePath, content);
    }
  },
});
