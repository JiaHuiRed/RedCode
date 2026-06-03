#!/usr/bin/env npx tsx

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

type DependencyTreeResult = {
  root: string;
  nodes: number;
  files: string[];
};

type TypeInfoResult = {
  type: string | null;
  documentation: string | null;
  kind?: string;
  source?: string;
};

type ModuleExportsResult = {
  file: string;
  exports: Array<{
    symbol: string;
    type: string | null;
  }>;
  count: number;
};

function normalize(file: string): string {
  return file.replaceAll("\\", "/");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  description: string,
  fn: () => Promise<void>,
  timeoutMs = 5_000,
  intervalMs = 50
): Promise<void> {
  const start = Date.now();
  let lastError: unknown;

  while (Date.now() - start < timeoutMs) {
    try {
      await fn();
      return;
    } catch (err) {
      lastError = err;
      await sleep(intervalMs);
    }
  }

  throw new Error(
    `${description} did not stabilize within ${timeoutMs}ms: ${String(lastError)}`
  );
}

function writeFile(root: string, relativePath: string, content: string): void {
  const absPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

async function main(): Promise<void> {
  const repoRoot = import.meta.dirname;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typegraph-engine-sync-"));
  const projectRoot = path.join(tempRoot, "project");

  fs.mkdirSync(projectRoot, { recursive: true });
  writeFile(
    projectRoot,
    "package.json",
    JSON.stringify(
      {
        name: "typegraph-engine-sync-fixture",
        private: true,
        type: "module",
      },
      null,
      2
    ) + "\n"
  );
  writeFile(
    projectRoot,
    "tsconfig.json",
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2
    ) + "\n"
  );

  writeFile(projectRoot, "src/a.ts", 'export const current = "a" as const;\n');
  writeFile(projectRoot, "src/b.ts", 'export const current = "b" as const;\n');
  writeFile(
    projectRoot,
    "src/main.ts",
    'import { current } from "./a";\nexport const value = current;\n'
  );
  writeFile(projectRoot, "src/test.ts", "export const oldName = 1 as const;\n");
  writeFile(projectRoot, "src/util.ts", "export const helper = 1 as const;\n");

  fs.mkdirSync(path.join(projectRoot, "node_modules"), { recursive: true });
  fs.symlinkSync(
    path.join(repoRoot, "node_modules/typescript"),
    path.join(projectRoot, "node_modules/typescript"),
    "dir"
  );

  const client = new Client({ name: "engine-sync-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: path.join(repoRoot, "node_modules/.bin/tsx"),
    args: [path.join(repoRoot, "server.ts")],
    cwd: projectRoot,
    env: {
      TYPEGRAPH_PROJECT_ROOT: projectRoot,
      TYPEGRAPH_TSCONFIG: path.join(projectRoot, "tsconfig.json"),
    },
  });

  async function callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name,
          arguments: args,
        },
      },
      CallToolResultSchema
    );

    const content = result.content[0];
    assert.ok(content?.type === "text", `Expected text response from ${name}`);
    return JSON.parse(content.text) as T;
  }

  try {
    await client.connect(transport);

    const initialType = await callTool<TypeInfoResult>("ts_type_info", {
      file: "src/main.ts",
      line: 2,
      column: 14,
    });
    assert.match(initialType.type ?? "", /"a"/);

    writeFile(projectRoot, "src/main.ts", 'import { current } from "./b";\nexport const value = current;\n');

    await waitFor("import swap to synchronize graph and tsserver", async () => {
      const deps = await callTool<DependencyTreeResult>("ts_dependency_tree", {
        file: "src/main.ts",
      });
      const normalizedDeps = deps.files.map(normalize);
      assert.ok(normalizedDeps.includes("src/b.ts"), `Expected src/b.ts in ${normalizedDeps}`);
      assert.ok(!normalizedDeps.includes("src/a.ts"), `Expected src/a.ts to be removed from ${normalizedDeps}`);

      const typeInfo = await callTool<TypeInfoResult>("ts_type_info", {
        file: "src/main.ts",
        line: 2,
        column: 14,
      });
      assert.match(typeInfo.type ?? "", /"b"/);
    });

    // Open test.ts through ts_module_exports, then rename the export on disk.
    const initialExports = await callTool<ModuleExportsResult>("ts_module_exports", {
      file: "src/test.ts",
    });
    assert.ok(initialExports.exports.some((item) => item.symbol === "oldName"));

    writeFile(projectRoot, "src/test.ts", "export const newName = 1 as const;\n");

    await waitFor("symbol rename to refresh mixed export metadata", async () => {
      const exportsResult = await callTool<ModuleExportsResult>("ts_module_exports", {
        file: "src/test.ts",
      });
      const next = exportsResult.exports.find((item) => item.symbol === "newName");
      assert.ok(next, `Expected newName in ${JSON.stringify(exportsResult.exports)}`);
      assert.match(next.type ?? "", /\bnewName\b/);
      assert.ok(!exportsResult.exports.some((item) => item.symbol === "oldName"));
    });

    // Open util.ts directly so tsserver tracks it, then delete it from disk.
    const utilInfo = await callTool<TypeInfoResult>("ts_type_info", {
      file: "src/util.ts",
      line: 1,
      column: 14,
    });
    assert.match(utilInfo.type ?? "", /\bhelper: 1\b/);
    fs.rmSync(path.join(projectRoot, "src/util.ts"));

    await waitFor("deleted file to disappear from semantic answers", async () => {
      const deletedInfo = await callTool<TypeInfoResult>("ts_type_info", {
        file: "src/util.ts",
        line: 1,
        column: 14,
      });
      assert.equal(
        deletedInfo.type,
        null,
        `Expected deleted file to have no type info, got ${JSON.stringify(deletedInfo)}`
      );
    });

    console.log("");
    console.log("typegraph-mcp Engine Sync Test");
    console.log("==============================");
    console.log("  ✓ import swaps keep dependency_tree and type_info aligned");
    console.log("  ✓ export renames refresh ts_module_exports semantic metadata");
    console.log("  ✓ deleted open files do not survive as tsserver ghost snapshots");
  } finally {
    await transport.close().catch(() => {});
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
