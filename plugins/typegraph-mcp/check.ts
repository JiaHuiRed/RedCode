#!/usr/bin/env npx tsx
/**
 * typegraph-mcp Health Check — Verifies all setup requirements are met.
 *
 * Run from project root:
 *   npx tsx plugins/typegraph-mcp/check.ts
 *
 * Or from plugins/typegraph-mcp/:
 *   npm run check
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { resolveConfig, type TypegraphConfig } from "./config.js";

// ─── Result Type ─────────────────────────────────────────────────────────────

export interface CheckResult {
  passed: number;
  failed: number;
  warned: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Find first .ts file in the project (for resolver smoke test) */
function findFirstTsFile(dir: string): string | null {
  const skipDirs = new Set(["node_modules", "dist", ".git", ".wrangler", "coverage"]);
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        return path.join(dir, entry.name);
      }
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !skipDirs.has(entry.name) && !entry.name.startsWith(".")) {
        const found = findFirstTsFile(path.join(dir, entry.name));
        if (found) return found;
      }
    }
  } catch {
    // Permission error or similar
  }
  return null;
}

/** Spawn tsserver, send configure, verify response, shut down */
function testTsserver(projectRoot: string): Promise<boolean> {
  return new Promise((resolve) => {
    let tsserverPath: string;
    try {
      const require = createRequire(path.resolve(projectRoot, "package.json"));
      tsserverPath = require.resolve("typescript/lib/tsserver.js");
    } catch {
      resolve(false);
      return;
    }

    const child = spawn("node", [tsserverPath, "--disableAutomaticTypingAcquisition"], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 10000);

    let buffer = "";
    child.stdout.on("data", (chunk: { toString(): string }) => {
      buffer += chunk.toString();
      // tsserver sends Content-Length framed JSON — look for success response
      if (buffer.includes('"success":true')) {
        clearTimeout(timeout);
        child.kill();
        resolve(true);
      }
    });

    child.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });

    child.on("exit", () => {
      clearTimeout(timeout);
      // If we haven't resolved yet, it failed
    });

    // Send configure request (newline-delimited JSON, not Content-Length framed)
    const request = JSON.stringify({
      seq: 1,
      type: "request",
      command: "configure",
      arguments: {
        preferences: { disableSuggestions: true },
      },
    });
    child.stdin.write(request + "\n");
  });
}

function readProjectCodexConfig(projectRoot: string): string | null {
  const configPath = path.resolve(projectRoot, ".codex/config.toml");
  if (!fs.existsSync(configPath)) return null;
  return fs.readFileSync(configPath, "utf-8");
}

function hasCodexTypegraphRegistration(content: string): boolean {
  return /\[mcp_servers\.typegraph\]/.test(content);
}

function hasCodexTsxLauncher(content: string): boolean {
  return (
    /command\s*=\s*"[^"]*tsx(?:\.cmd)?"/.test(content) ||
    /args\s*=\s*\[[\s\S]*"tsx"/.test(content)
  );
}

function hasCompleteCodexTypegraphRegistration(content: string): boolean {
  return (
    hasCodexTypegraphRegistration(content) &&
    /command\s*=\s*"[^"]+"/.test(content) &&
    /args\s*=\s*\[[\s\S]*\]/.test(content) &&
    hasCodexTsxLauncher(content) &&
    /TYPEGRAPH_PROJECT_ROOT\s*=/.test(content) &&
    /TYPEGRAPH_TSCONFIG\s*=/.test(content)
  );
}

function hasTrustedCodexProject(projectRoot: string): boolean | null {
  const home = process.env.HOME;
  if (!home) return null;

  const globalConfigPath = path.join(home, ".codex/config.toml");
  if (!fs.existsSync(globalConfigPath)) return null;

  const lines = fs.readFileSync(globalConfigPath, "utf-8").split(/\r?\n/);
  let currentProject: string | null = null;
  let currentTrusted = false;

  const matchesTrustedProject = (): boolean =>
    currentProject !== null &&
    currentTrusted &&
    (projectRoot === currentProject || projectRoot.startsWith(currentProject + path.sep));

  for (const line of lines) {
    const sectionMatch = line.match(/^\[projects\."([^"]+)"\]\s*$/);
    if (sectionMatch) {
      if (matchesTrustedProject()) return true;
      currentProject = path.resolve(sectionMatch[1]!);
      currentTrusted = false;
      continue;
    }

    if (line.startsWith("[")) {
      if (matchesTrustedProject()) return true;
      currentProject = null;
      currentTrusted = false;
      continue;
    }

    if (currentProject && /\btrust_level\s*=\s*"trusted"/.test(line)) {
      currentTrusted = true;
    }
  }

  return matchesTrustedProject();
}

function hasCompleteJsonTypegraphRegistration(
  config: unknown,
  serverName: string,
  projectRoot: string
): boolean {
  if (typeof config !== "object" || config === null) return false;
  const servers = (config as Record<string, unknown>)["mcpServers"];
  if (typeof servers !== "object" || servers === null) return false;
  const entry = (servers as Record<string, unknown>)[serverName];
  if (typeof entry !== "object" || entry === null) return false;

  const record = entry as Record<string, unknown>;
  const command = record["command"];
  const args = record["args"];
  const env = record["env"];
  const serializedArgs = JSON.stringify(args ?? []);

  return (
    typeof command === "string" &&
    command.length > 0 &&
    Array.isArray(args) &&
    serializedArgs.includes("server.ts") &&
    serializedArgs.includes("tsx") &&
    typeof env === "object" &&
    env !== null &&
    (env as Record<string, unknown>)["TYPEGRAPH_PROJECT_ROOT"] === projectRoot &&
    typeof (env as Record<string, unknown>)["TYPEGRAPH_TSCONFIG"] === "string"
  );
}

function readJsonConfig(configPath: string): unknown | null {
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return null;
  }
}

function getAntigravityMcpConfigPaths(): string[] {
  const home = process.env.HOME || "";
  return [
    path.join(home, ".gemini/antigravity/mcp_config.json"),
    path.join(home, ".gemini/antigravity-cli/plugins/typegraph-mcp/mcp_config.json"),
  ];
}

function findAntigravityRegistration(projectRoot: string): string | null {
  const home = process.env.HOME || "";
  for (const configPath of getAntigravityMcpConfigPaths()) {
    const config = readJsonConfig(configPath);
    if (hasCompleteJsonTypegraphRegistration(config, "typegraph-mcp", projectRoot)) {
      return configPath.replace(home, "~");
    }
  }
  return null;
}

function readProjectPackageJson(projectRoot: string): Record<string, unknown> | null {
  const packageJsonPath = path.resolve(projectRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getProjectInstallCommand(projectRoot: string, packageJson: Record<string, unknown> | null): string {
  const packageManager = typeof packageJson?.["packageManager"] === "string"
    ? packageJson["packageManager"]
    : "";

  if (packageManager.startsWith("pnpm@") || fs.existsSync(path.join(projectRoot, "pnpm-lock.yaml"))) {
    return "pnpm install";
  }
  if (packageManager.startsWith("yarn@") || fs.existsSync(path.join(projectRoot, "yarn.lock"))) {
    return "yarn install";
  }
  return "npm install";
}

function hasDeclaredDependency(packageJson: Record<string, unknown> | null, packageName: string): boolean {
  const depKeys = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const;

  return depKeys.some((key) => {
    const deps = packageJson?.[key];
    return typeof deps === "object" && deps !== null && packageName in deps;
  });
}

const ESLINT_CONFIG_NAMES = [
  "eslint.config.mjs",
  "eslint.config.js",
  "eslint.config.ts",
  "eslint.config.cjs",
];
const OXLINT_CONFIG_NAMES = [
  ".oxlintrc.json",
  "oxlint.config.ts",
  "oxlint.config.js",
  "oxlint.config.mjs",
  "oxlint.config.cjs",
];

type LintConfigCheck =
  | { tool: "ESLint"; fileName: string; fullPath: string; propertyName: "ignores" }
  | { tool: "Oxlint"; fileName: string; fullPath: string; propertyName: "ignorePatterns" };

function findLintConfigs(projectRoot: string): LintConfigCheck[] {
  const configs: LintConfigCheck[] = [];

  for (const fileName of ESLINT_CONFIG_NAMES) {
    const fullPath = path.resolve(projectRoot, fileName);
    if (fs.existsSync(fullPath)) {
      configs.push({ tool: "ESLint", fileName, fullPath, propertyName: "ignores" });
    }
  }

  for (const fileName of OXLINT_CONFIG_NAMES) {
    const fullPath = path.resolve(projectRoot, fileName);
    if (fs.existsSync(fullPath)) {
      configs.push({ tool: "Oxlint", fileName, fullPath, propertyName: "ignorePatterns" });
    }
  }

  return configs;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function main(configOverride?: TypegraphConfig): Promise<CheckResult> {
  const { projectRoot, tsconfigPath, toolDir, toolIsEmbedded, toolRelPath } =
    configOverride ?? resolveConfig(import.meta.dirname);

  let passed = 0;
  let failed = 0;
  let warned = 0;
  const projectPackageJson = readProjectPackageJson(projectRoot);
  const installCommand = getProjectInstallCommand(projectRoot, projectPackageJson);

  function pass(msg: string): void {
    console.log(`  \u2713 ${msg}`);
    passed++;
  }

  function fail(msg: string, fix: string): void {
    console.log(`  \u2717 ${msg}`);
    console.log(`    Fix: ${fix}`);
    failed++;
  }

  function warn(msg: string, note: string): void {
    console.log(`  ! ${msg}`);
    console.log(`    ${note}`);
    warned++;
  }

  function skip(msg: string): void {
    console.log(`  - ${msg} (skipped)`);
  }

  console.log("");
  console.log("typegraph-mcp Health Check");
  console.log("=======================");
  console.log(`Project root: ${projectRoot}`);
  console.log("");

  // 1. Node.js version
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1).split(".")[0]!, 10);
  if (nodeMajor >= 22) {
    pass(`Node.js ${nodeVersion} (>= 22 required)`);
  } else {
    fail(`Node.js ${nodeVersion} is too old`, "Upgrade Node.js to >= 22");
  }

  // 2. tsx availability (if we're running, tsx works — but check it's in the project)
  const tsxInRoot = fs.existsSync(path.join(projectRoot, "node_modules/.bin/tsx"));
  const tsxInTool = fs.existsSync(path.join(toolDir, "node_modules/.bin/tsx"));
  if (tsxInRoot || tsxInTool) {
    pass(`tsx available (in ${tsxInRoot ? "project" : "tool"} node_modules)`);
  } else {
    // We're running via tsx, so it must be available somehow (global or npx)
    pass("tsx available (via npx/global)");
  }

  // 3. TypeScript in project
  let tsVersion: string | null = null;
  try {
    const require = createRequire(path.resolve(projectRoot, "package.json"));
    const tsserverPath = require.resolve("typescript/lib/tsserver.js");
    const tsPkgPath = path.resolve(path.dirname(tsserverPath), "..", "package.json");
    const tsPkg = JSON.parse(fs.readFileSync(tsPkgPath, "utf-8"));
    tsVersion = tsPkg.version;
    pass(`TypeScript found (v${tsVersion})`);
  } catch {
    const hasDeclaredTs = hasDeclaredDependency(projectPackageJson, "typescript");
    fail(
      hasDeclaredTs
        ? "TypeScript is declared but not installed in project"
        : "TypeScript not found in project",
      hasDeclaredTs
        ? `Run \`${installCommand}\` to install project dependencies`
        : `Add \`typescript\` to devDependencies and run \`${installCommand}\``
    );
  }

  // 4. tsconfig.json exists
  const tsconfigAbs = path.resolve(projectRoot, tsconfigPath);
  if (fs.existsSync(tsconfigAbs)) {
    pass(`tsconfig.json exists at ${tsconfigPath}`);
  } else {
    fail(`tsconfig.json not found at ${tsconfigPath}`, `Create a tsconfig.json at ${tsconfigPath}`);
  }

  // 5. MCP registration
  // Check for plugin .mcp.json in the tool directory (embedded plugin install)
  const pluginMcpPath = path.join(toolDir, ".mcp.json");
  const hasPluginMcp = fs.existsSync(pluginMcpPath) && fs.existsSync(path.join(toolDir, ".claude-plugin/plugin.json"));
  const projectCodexConfig = readProjectCodexConfig(projectRoot);
  const hasProjectCodexRegistration =
    projectCodexConfig !== null && hasCompleteCodexTypegraphRegistration(projectCodexConfig);
  const codexGet = spawnSync("codex", ["mcp", "get", "typegraph"], {
    stdio: "pipe",
    encoding: "utf-8",
  });
  const hasGlobalCodexRegistration = codexGet.status === 0;
  const antigravityRegistrationPath = findAntigravityRegistration(projectRoot);
  if (process.env.CLAUDE_PLUGIN_ROOT) {
    pass("MCP registered via plugin (CLAUDE_PLUGIN_ROOT set)");
  } else if (hasPluginMcp) {
    pass("MCP registered via plugin (.mcp.json + .claude-plugin/ present)");
  } else if (projectCodexConfig !== null) {
    const codexConfigPath = path.resolve(projectRoot, ".codex/config.toml");
    const hasSection = hasCodexTypegraphRegistration(projectCodexConfig);
    const hasCommand = /command\s*=\s*"[^"]+"/.test(projectCodexConfig);
    const hasArgs = /args\s*=\s*\[[\s\S]*\]/.test(projectCodexConfig);
    const hasTsxLauncher = hasCodexTsxLauncher(projectCodexConfig);
    const hasEnvRoot = /TYPEGRAPH_PROJECT_ROOT\s*=/.test(projectCodexConfig);
    const hasEnvTsconfig = /TYPEGRAPH_TSCONFIG\s*=/.test(projectCodexConfig);
    if (hasProjectCodexRegistration) {
      pass("MCP registered in project .codex/config.toml");
      const trusted = hasTrustedCodexProject(projectRoot);
      if (trusted === false) {
        warn(
          "Project Codex config may be ignored",
          "Add the project (or a parent directory) to ~/.codex/config.toml with trust_level = \"trusted\""
        );
      }
    } else {
      const issues: string[] = [];
      if (!hasSection) issues.push("[mcp_servers.typegraph] section is missing");
      if (!hasCommand) issues.push("command is missing");
      if (!hasArgs) issues.push("args are missing");
      if (!hasTsxLauncher) issues.push("command should point to tsx or args should include 'tsx'");
      if (!hasEnvRoot) issues.push("TYPEGRAPH_PROJECT_ROOT is missing");
      if (!hasEnvTsconfig) issues.push("TYPEGRAPH_TSCONFIG is missing");
      fail(
        `Project .codex/config.toml registration incomplete: ${issues.join(", ")}`,
        `Update ${codexConfigPath} with a complete [mcp_servers.typegraph] entry`
      );
    }
  } else if (hasGlobalCodexRegistration) {
    pass("MCP registered in global Codex CLI config");
  } else if (antigravityRegistrationPath !== null) {
    pass(`MCP registered in Antigravity config (${antigravityRegistrationPath})`);
  } else {
    const codexConfigPath = path.resolve(projectRoot, ".codex/config.toml");
    const mcpJsonPath = path.resolve(projectRoot, ".claude/mcp.json");
    if (fs.existsSync(mcpJsonPath)) {
      try {
        const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
        const tsNav = mcpJson?.mcpServers?.["typegraph"];
        if (tsNav) {
          const hasCommand = tsNav.command === "npx";
          const hasArgs = Array.isArray(tsNav.args) && tsNav.args.includes("tsx");
          const hasEnv = tsNav.env?.["TYPEGRAPH_PROJECT_ROOT"] && tsNav.env?.["TYPEGRAPH_TSCONFIG"];
          if (hasCommand && hasArgs && hasEnv) {
            pass("MCP registered in .claude/mcp.json");
          } else {
            const issues: string[] = [];
            if (!hasCommand) issues.push("command should be 'npx'");
            if (!hasArgs) issues.push("args should include 'tsx'");
            if (!hasEnv) issues.push("env should set TYPEGRAPH_PROJECT_ROOT and TYPEGRAPH_TSCONFIG");
            fail(
              `MCP registration incomplete: ${issues.join(", ")}`,
              "See README for correct .claude/mcp.json format"
            );
          }
        } else {
          const serverPath = toolIsEmbedded
            ? `./${toolRelPath}/server.ts`
            : path.resolve(toolDir, "server.ts");
          fail(
            "MCP entry 'typegraph' not found in .claude/mcp.json",
            `Add to .claude/mcp.json:\n` +
              `    {\n` +
              `      "mcpServers": {\n` +
              `        "typegraph": {\n` +
              `          "command": "npx",\n` +
              `          "args": ["tsx", "${serverPath}"],\n` +
              `          "env": { "TYPEGRAPH_PROJECT_ROOT": ".", "TYPEGRAPH_TSCONFIG": "./tsconfig.json" }\n` +
              `        }\n` +
              `      }\n` +
              `    }`
          );
        }
      } catch (err) {
        fail(
          "Failed to parse .claude/mcp.json",
          `Check JSON syntax: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } else {
      fail(
        "No MCP registration found",
        `Create ${codexConfigPath} with [mcp_servers.typegraph] or create .claude/mcp.json with typegraph server registration`
      );
    }
  }

  // 6. typegraph-mcp dependencies installed
  const toolNodeModules = path.join(toolDir, "node_modules");
  if (fs.existsSync(toolNodeModules)) {
    const requiredPkgs = ["@modelcontextprotocol/sdk", "oxc-parser", "oxc-resolver", "zod"];
    const missing = requiredPkgs.filter(
      (pkg) => !fs.existsSync(path.join(toolNodeModules, ...pkg.split("/")))
    );
    if (missing.length === 0) {
      pass(`Dependencies installed (${requiredPkgs.length} packages)`);
    } else {
      fail(`Missing packages: ${missing.join(", ")}`, `Run \`cd ${toolRelPath} && npm install\``);
    }
  } else {
    fail("typegraph-mcp dependencies not installed", `Run \`cd ${toolRelPath} && npm install\``);
  }

  // 7. oxc-parser smoke test
  try {
    const oxcParserReq = createRequire(path.join(toolDir, "package.json"));
    const { parseSync } = await import(oxcParserReq.resolve("oxc-parser"));
    const result = parseSync("test.ts", 'import { x } from "./y";');
    if (result.module?.staticImports?.length === 1) {
      pass("oxc-parser working");
    } else {
      fail(
        "oxc-parser parseSync returned unexpected result",
        `Reinstall: \`cd ${toolRelPath} && rm -rf node_modules && npm install\``
      );
    }
  } catch (err) {
    fail(
      `oxc-parser failed: ${err instanceof Error ? err.message : String(err)}`,
      `Reinstall: \`cd ${toolRelPath} && rm -rf node_modules && npm install\``
    );
  }

  // 8. oxc-resolver smoke test
  try {
    const oxcResolverReq = createRequire(path.join(toolDir, "package.json"));
    const { ResolverFactory } = await import(oxcResolverReq.resolve("oxc-resolver"));
    const resolver = new ResolverFactory({
      tsconfig: { configFile: tsconfigAbs, references: "auto" },
      extensions: [".ts", ".tsx", ".js"],
      extensionAlias: { ".js": [".ts", ".tsx", ".js"] },
    });
    // Find any .ts file in the project to test resolution
    let resolveOk = false;
    const testFile = findFirstTsFile(projectRoot);
    if (testFile) {
      const dir = path.dirname(testFile);
      const base = "./" + path.basename(testFile);
      const result = resolver.sync(dir, base);
      resolveOk = !!result.path;
    }
    if (resolveOk) {
      pass("oxc-resolver working");
    } else {
      // Resolver loaded but couldn't resolve — still partially working
      warn(
        "oxc-resolver loaded but couldn't resolve a test import",
        "Check tsconfig.json is valid and has correct `references`"
      );
    }
  } catch (err) {
    fail(
      `oxc-resolver failed: ${err instanceof Error ? err.message : String(err)}`,
      `Reinstall: \`cd ${toolRelPath} && rm -rf node_modules && npm install\``
    );
  }

  // 9. tsserver startup test
  if (tsVersion) {
    try {
      const ok = await testTsserver(projectRoot);
      if (ok) {
        pass("tsserver responds to configure");
      } else {
        fail(
          "tsserver did not respond",
          "Verify `typescript` is installed and tsconfig.json is valid"
        );
      }
    } catch (err) {
      fail(
        `tsserver failed to start: ${err instanceof Error ? err.message : String(err)}`,
        "Verify `typescript` is installed and tsconfig.json is valid"
      );
    }
  } else {
    skip("tsserver test (TypeScript not found)");
  }

  // 10. Module graph build test
  try {
    let buildGraph: (root: string, tsconfig: string) => Promise<{ graph: { files: Set<string>; forward: Map<string, unknown[]> } }>;
    try {
      ({ buildGraph } = await import(path.resolve(toolDir, "module-graph.js")));
    } catch {
      // Fallback: plugin dir has .ts files only (no tsx at runtime), use the co-bundled version
      ({ buildGraph } = await import("./module-graph.js"));
    }
    const start = performance.now();
    const { graph } = await buildGraph(projectRoot, tsconfigPath);
    const elapsed = (performance.now() - start).toFixed(0);
    const edgeCount = [...graph.forward.values()].reduce(
      (s: number, e: unknown[]) => s + e.length,
      0
    );
    if (graph.files.size > 0 && edgeCount > 0) {
      pass(`Module graph: ${graph.files.size} files, ${edgeCount} edges [${elapsed}ms]`);
    } else if (graph.files.size > 0) {
      warn(
        `Module graph: ${graph.files.size} files but 0 edges`,
        "Files found but no internal imports resolved. Check tsconfig references."
      );
    } else {
      fail(
        "Module graph: 0 files discovered",
        "Check tsconfig.json includes source files and project root is correct"
      );
    }
  } catch (err) {
    fail(
      `Module graph build failed: ${err instanceof Error ? err.message : String(err)}`,
      "Check that oxc-parser and oxc-resolver are installed correctly"
    );
  }

  // 11. Lint ignores (only when typegraph-mcp is embedded inside the project)
  if (toolIsEmbedded) {
    const lintConfigs = findLintConfigs(projectRoot);
    if (lintConfigs.length > 0) {
      // Determine the parent directory (e.g. "plugins") for the ignore pattern
      const parentDir = path.basename(path.dirname(toolDir));
      const parentIgnorePattern = new RegExp(`["']${parentDir}\\/\\*\\*["']`);

      for (const config of lintConfigs) {
        const content = fs.readFileSync(config.fullPath, "utf-8");
        const hasParentIgnore = parentIgnorePattern.test(content);

        if (hasParentIgnore) {
          pass(`${config.tool} ignores ${parentDir}/ (${config.fileName})`);
        } else {
          fail(
            `${config.tool} missing ignore: "${parentDir}/**" (${config.fileName})`,
            `Add to ${config.propertyName} in ${config.fileName}:\n    "${parentDir}/**",`
          );
        }
      }
    } else {
      skip("Lint config check (no ESLint or Oxlint config found)");
    }
  } else {
    skip("Lint config check (typegraph-mcp is external to project)");
  }

  // 12. .gitignore check (optional)
  const gitignorePath = path.resolve(projectRoot, ".gitignore");
  if (fs.existsSync(gitignorePath)) {
    const gitignoreContent = fs.readFileSync(gitignorePath, "utf-8");
    const lines = gitignoreContent
      .split("\n")
      .map((l: string) => l.trim())
      .filter((l: string) => l && !l.startsWith("#"));
    const ignoresClaude = lines.some(
      (l: string) => l === ".claude/" || l === ".claude" || l === "/.claude"
    );

    // Check parent dir exclusion when typegraph-mcp is embedded
    const parentDir = toolIsEmbedded ? path.basename(path.dirname(toolDir)) : null;
    const ignoresParent =
      parentDir &&
      lines.some((l: string) => l === `${parentDir}/` || l === parentDir || l === `/${parentDir}`);

    if (!ignoresParent && !ignoresClaude) {
      pass(".gitignore does not exclude .claude/" + (parentDir ? ` or ${parentDir}/` : ""));
    } else {
      const excluded: string[] = [];
      if (ignoresParent) excluded.push(`${parentDir}/`);
      if (ignoresClaude) excluded.push(".claude/");
      warn(
        `.gitignore excludes ${excluded.join(" and ")}`,
        "Remove these entries so MCP config and tool source are tracked in git"
      );
    }
  } else {
    skip(".gitignore check (no .gitignore)");
  }

  // ─── Summary ─────────────────────────────────────────────────────────────

  console.log("");
  const total = passed + failed;
  if (failed === 0) {
    console.log(
      `${passed}/${total} checks passed` +
        (warned > 0 ? ` (${warned} warning${warned > 1 ? "s" : ""})` : "") +
        " -- typegraph-mcp is ready"
    );
  } else {
    console.log(
      `${passed}/${total} checks passed, ${failed} failed` +
        (warned > 0 ? `, ${warned} warning${warned > 1 ? "s" : ""}` : "") +
        " -- fix issues above"
    );
  }
  console.log("");

  return { passed, failed, warned };
}
