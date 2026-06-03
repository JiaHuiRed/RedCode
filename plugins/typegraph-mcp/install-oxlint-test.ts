#!/usr/bin/env npx tsx

import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

function runTsx(
  toolRoot: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  return execFileSync(path.join(toolRoot, "node_modules/.bin/tsx"), args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    env,
  });
}

function assertIncludes(text: string, expected: string): void {
  assert.ok(
    text.includes(expected),
    `Expected output to include:\n${expected}\n\nActual output:\n${text}`
  );
}

async function main(): Promise<void> {
  const repoRoot = import.meta.dirname;
  const fixtureRoot = path.join(repoRoot, ".fixtures/install-oxlint");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "typegraph-install-oxlint-"));
  const projectRoot = path.join(tempRoot, "project");
  const homeRoot = path.join(tempRoot, "home");

  copyDir(fixtureRoot, projectRoot);
  fs.mkdirSync(path.join(projectRoot, "node_modules"), { recursive: true });
  fs.symlinkSync(
    path.join(repoRoot, "node_modules/typescript"),
    path.join(projectRoot, "node_modules/typescript"),
    "dir"
  );

  try {
    fs.mkdirSync(homeRoot, { recursive: true });
    const testEnv = { ...process.env, HOME: homeRoot };
    const setupOutput = runTsx(
      repoRoot,
      [path.join(repoRoot, "cli.ts"), "setup", "--yes"],
      projectRoot,
      testEnv
    );
    const pluginRoot = path.join(projectRoot, "plugins/typegraph-mcp");

    const tsconfig = fs.readFileSync(path.join(projectRoot, "tsconfig.json"), "utf-8");
    const oxlint = fs.readFileSync(path.join(projectRoot, ".oxlintrc.json"), "utf-8");

    assertIncludes(tsconfig, '"$schema": "http://json.schemastore.org/tsconfig"');
    assertIncludes(tsconfig, '"exclude": ["plugins/**"]');
    assertIncludes(oxlint, '"ignorePatterns": [');
    assertIncludes(oxlint, '"plugins/**"');
    assert.ok(fs.existsSync(path.join(pluginRoot, "cli.ts")), "Expected installed plugin CLI");

    assertIncludes(setupOutput, 'Added "plugins/**" to tsconfig.json exclude');
    assertIncludes(setupOutput, 'Added "plugins/**" to .oxlintrc.json ignorePatterns');
    assertIncludes(setupOutput, "Oxlint ignores plugins/ (.oxlintrc.json)");

    const checkOutput = runTsx(
      pluginRoot,
      [path.join(pluginRoot, "cli.ts"), "check"],
      projectRoot,
      testEnv
    );
    assertIncludes(checkOutput, "Oxlint ignores plugins/ (.oxlintrc.json)");
    assert.ok(
      !checkOutput.includes("Lint config check (no ESLint or Oxlint config found)"),
      `Did not expect lint config detection to be skipped:\n${checkOutput}`
    );

    console.log("");
    console.log("typegraph-mcp Install Oxlint Test");
    console.log("=================================");
    console.log("  ✓ tsconfig schema URL preserved during exclude patch");
    console.log("  ✓ tsconfig exclude patch ignores unrelated plugins text");
    console.log("  ✓ .oxlintrc.json patched with plugins ignore");
    console.log("  ✓ installed plugin health check recognizes Oxlint config");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
