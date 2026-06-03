#!/usr/bin/env npx tsx

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

type ModuleExportRecord = {
  symbol: string;
  kind: string;
  line: number;
  type: string | null;
  exportKind: "value" | "type";
  isTypeOnly: boolean;
  isNamespace: boolean;
  source: "local" | "re-export" | "star-re-export";
  from: string | null;
  definedIn: string;
  definedLine: number | null;
};

type ModuleExportsResult = {
  file: string;
  exports: ModuleExportRecord[];
  count: number;
  localCount: number;
  reExportCount: number;
  typeOnlyCount: number;
  valueCount: number;
  namespaceExportCount: number;
  hasLocalRuntimeExports: boolean;
  isPrimarilyBarrel: boolean;
};

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function findExport(
  result: ModuleExportsResult,
  symbol: string,
  exportKind: "value" | "type"
): ModuleExportRecord {
  const found = result.exports.find(
    (item) => item.symbol === symbol && item.exportKind === exportKind
  );
  assert.ok(found, `Expected ${symbol}:${exportKind} in ${result.file}`);
  return found;
}

function assertProjectPath(actual: string | null, expected: string): void {
  assert.ok(actual, `Expected path ${expected}`);
  const normalized = actual.replaceAll("\\", "/");
  assert.equal(normalized, expected, `Expected ${normalized} to equal ${expected}`);
}

async function main(): Promise<void> {
  const repoRoot = import.meta.dirname;
  const fixtureRoot = path.join(repoRoot, ".fixtures/export-surface");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typegraph-export-surface-"));
  const projectRoot = path.join(tempRoot, "project");

  copyDir(fixtureRoot, projectRoot);
  fs.mkdirSync(path.join(projectRoot, "node_modules"), { recursive: true });
  fs.symlinkSync(
    path.join(repoRoot, "node_modules/typescript"),
    path.join(projectRoot, "node_modules/typescript"),
    "dir"
  );

  const client = new Client({ name: "export-surface-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: path.join(repoRoot, "node_modules/.bin/tsx"),
    args: [path.join(repoRoot, "server.ts")],
    cwd: projectRoot,
    env: {
      TYPEGRAPH_PROJECT_ROOT: projectRoot,
      TYPEGRAPH_TSCONFIG: path.join(projectRoot, "tsconfig.json"),
    },
  });

  try {
    await client.connect(transport);

    async function moduleExports(file: string): Promise<ModuleExportsResult> {
      const result = await client.request(
        {
          method: "tools/call",
          params: {
            name: "ts_module_exports",
            arguments: { file },
          },
        },
        CallToolResultSchema
      );

      const content = result.content[0];
      assert.ok(content?.type === "text", `Expected text response for ${file}`);
      return JSON.parse(content.text) as ModuleExportsResult;
    }

    const source = await moduleExports("src/source.ts");
    const defaultExport = findExport(source, "default", "value");
    assert.equal(defaultExport.source, "local");
    assert.equal(defaultExport.kind, "function");
    assert.equal(defaultExport.definedIn, "src/source.ts");
    assert.equal(defaultExport.definedLine, 1);

    const defaultExpression = await moduleExports("src/default-expression.ts");
    const expressionDefault = findExport(defaultExpression, "default", "value");
    assert.equal(expressionDefault.source, "local");
    assert.equal(expressionDefault.definedIn, "src/default-expression.ts");

    const barrel = await moduleExports("src/barrel.ts");
    const barrelValue = findExport(barrel, "value", "value");
    const barrelUserShape = findExport(barrel, "UserShape", "type");
    assert.equal(barrelValue.source, "star-re-export");
    assert.equal(barrelUserShape.source, "star-re-export");
    assert.equal(barrel.exports.some((item) => item.symbol === "default"), false);
    assert.equal(barrel.exports.some((item) => item.symbol === "buildUser"), false);
    assert.equal(barrelUserShape.isTypeOnly, true);
    assert.equal(barrel.typeOnlyCount, 2);
    assert.equal(barrel.isPrimarilyBarrel, true);
    assert.equal(barrel.hasLocalRuntimeExports, false);

    const typeReExport = await moduleExports("src/reexport-type.ts");
    const userShape = findExport(typeReExport, "UserShape", "type");
    assert.equal(userShape.source, "re-export");
    assert.equal(userShape.isTypeOnly, true);
    assert.equal(userShape.exportKind, "type");
    assert.equal(typeReExport.typeOnlyCount, 1);
    assert.equal(typeReExport.valueCount, 0);

    const namedReExport = await moduleExports("src/named-reexport.ts");
    const aliasedValue = findExport(namedReExport, "aliasedValue", "value");
    assert.equal(aliasedValue.source, "re-export");
    assertProjectPath(aliasedValue.from, "src/source.ts");
    assert.equal(aliasedValue.definedIn, "src/source.ts");
    assert.equal(namedReExport.namespaceExportCount, 0);

    const namespaceReExport = await moduleExports("src/namespace-reexport.ts");
    const models = findExport(namespaceReExport, "Models", "value");
    assert.equal(models.source, "re-export");
    assert.equal(models.isNamespace, true);
    assert.equal(namespaceReExport.namespaceExportCount, 1);

    const mixed = await moduleExports("src/mixed.ts");
    const localValue = findExport(mixed, "SessionId", "value");
    const localType = findExport(mixed, "SessionId", "type");
    const externalValue = findExport(mixed, "externalValue", "value");
    const externalUserShape = findExport(mixed, "ExternalUserShape", "type");
    assert.equal(localValue.source, "local");
    assert.equal(localType.source, "local");
    assert.equal(localType.kind, "type");
    assert.equal(localType.definedLine, 2);
    assert.equal(externalValue.source, "re-export");
    assert.equal(externalUserShape.source, "re-export");
    assert.equal(externalUserShape.isTypeOnly, true);
    assert.equal(mixed.localCount, 2);
    assert.equal(mixed.reExportCount, 2);
    assert.equal(mixed.typeOnlyCount, 2);
    assert.equal(mixed.hasLocalRuntimeExports, true);
    assert.equal(mixed.isPrimarilyBarrel, false);

    const collision = await moduleExports("src/collision-barrel.ts");
    assert.equal(collision.exports.some((item) => item.symbol === "dup"), false);
    assert.equal(collision.count, 0);

    console.log("");
    console.log("typegraph-mcp Export Surface Test");
    console.log("=================================");
    console.log("  ✓ local default exports are reported as default");
    console.log("  ✓ anonymous default exports stay visible");
    console.log("  ✓ barrel star re-exports");
    console.log("  ✓ barrel star re-exports exclude default exports");
    console.log("  ✓ type-only named re-exports");
    console.log("  ✓ named alias re-exports");
    console.log("  ✓ namespace re-exports");
    console.log("  ✓ mixed local + re-export modules");
    console.log("  ✓ conflicting star re-exports stay hidden");
  } finally {
    await transport.close().catch(() => {});
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
