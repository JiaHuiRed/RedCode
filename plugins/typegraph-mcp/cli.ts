#!/usr/bin/env npx tsx
/**
 * typegraph-mcp CLI — Setup, verify, and run the TypeGraph MCP server.
 *
 * Usage:
 *   typegraph-mcp setup   Install typegraph-mcp plugin into the current project
 *   typegraph-mcp check   Run health checks (12 checks)
 *   typegraph-mcp test    Run smoke tests (all 14 tools)
 *   typegraph-mcp start   Start the MCP server (stdin/stdout)
 *
 * Options:
 *   --yes   Skip confirmation prompts (accept all defaults)
 *   --clean-global-codex   Also remove a stale global Codex MCP entry for this project
 *   --help  Show help
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
import { resolveConfig } from "./config.js";

// ─── Types ───────────────────────────────────────────────────────────────────

type AgentId = "claude-code" | "cursor" | "codex" | "gemini" | "copilot" | "antigravity";

interface AgentDef {
  name: string;
  /** Files to include in the plugin directory (agent-specific) */
  pluginFiles: string[];
  /** Agent instruction file to update (null if agent has no instruction file) */
  agentFile: string | null;
  /** Whether this agent discovers skills from .agents/skills/ at project root */
  needsAgentsSkills: boolean;
  /** Detect if this agent is likely in use based on project files */
  detect: (projectRoot: string) => boolean;
}

interface LegacyGlobalCodexCleanup {
  globalConfigPath: string;
  nextContent: string;
}

interface RemovePluginOptions {
  removeGlobalCodex: boolean;
  legacyGlobalCodexCleanup: LegacyGlobalCodexCleanup | null;
  warnAboutGlobalCodex: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const AGENT_SNIPPET = `
## TypeScript Navigation (typegraph-mcp)

Where suitable, use the \`ts_*\` MCP tools instead of grep/glob for navigating TypeScript code. They resolve through barrel files, re-exports, and project references and return semantic results instead of string matches.

- Point queries: \`ts_find_symbol\`, \`ts_definition\`, \`ts_references\`, \`ts_type_info\`, \`ts_navigate_to\`, \`ts_trace_chain\`, \`ts_blast_radius\`, \`ts_module_exports\`
- Graph queries: \`ts_dependency_tree\`, \`ts_dependents\`, \`ts_import_cycles\`, \`ts_shortest_path\`, \`ts_subgraph\`, \`ts_module_boundary\`

Start with the navigation tools before reading entire files. Use direct file reads only after the MCP tools identify the exact symbols or lines that matter.

For quick architectural insight, prefer composition modules and entrypoints over top-level barrel files. If \`ts_module_exports\` on an \`index.ts\` or other barrel looks empty or uninformative, pivot to the app entrypoint, router, handler, service composition root, or API module that wires real behavior together.

Use \`rg\` or \`grep\` when semantic symbol navigation is not the right tool, especially for:

- docs, config, SQL, migrations, JSON, env vars, route strings, and other non-TypeScript assets
- broad text discovery when you do not yet know the symbol name
- exact string matching across the repo
- validating wording or finding repeated plan/document references

Practical rule:

- use \`ts_*\` first for TypeScript symbol definition, references, types, and dependency analysis
- use \`rg\`/\`grep\` for text search and non-TypeScript exploration
- combine both when a task spans TypeScript code and surrounding docs/config
`.trimStart();

const SNIPPET_MARKER = "## TypeScript Navigation (typegraph-mcp)";
const CLAUDE_NODE_PLACEHOLDER = "__TYPEGRAPH_NODE__";

const PLUGIN_DIR_NAME = "plugins/typegraph-mcp";

const AGENT_IDS: AgentId[] = ["claude-code", "cursor", "codex", "gemini", "copilot", "antigravity"];

const AGENTS: Record<AgentId, AgentDef> = {
  "claude-code": {
    name: "Claude Code",
    pluginFiles: [
      ".claude-plugin/plugin.json",
      "hooks/hooks.json",
      "scripts/ensure-deps.sh",
      "commands/check.md",
      "commands/test.md",
      "commands/bench.md",
      "commands/deep-survey.md",
    ],
    agentFile: "CLAUDE.md",
    needsAgentsSkills: false,
    detect: (root) =>
      fs.existsSync(path.join(root, "CLAUDE.md")) ||
      fs.existsSync(path.join(root, ".claude")),
  },
  cursor: {
    name: "Cursor",
    pluginFiles: [".cursor-plugin/plugin.json"],
    agentFile: null,
    needsAgentsSkills: false,
    detect: (root) => fs.existsSync(path.join(root, ".cursor")),
  },
  codex: {
    name: "Codex CLI",
    pluginFiles: [],
    agentFile: "AGENTS.md",
    needsAgentsSkills: true,
    detect: (root) => fs.existsSync(path.join(root, "AGENTS.md")),
  },
  gemini: {
    name: "Gemini CLI",
    pluginFiles: ["gemini-extension.json"],
    agentFile: "GEMINI.md",
    needsAgentsSkills: true,
    detect: (root) => fs.existsSync(path.join(root, "GEMINI.md")),
  },
  copilot: {
    name: "GitHub Copilot",
    pluginFiles: [],
    agentFile: ".github/copilot-instructions.md",
    needsAgentsSkills: true,
    detect: (root) =>
      fs.existsSync(path.join(root, ".github/copilot-instructions.md")),
  },
  antigravity: {
    name: "Antigravity",
    pluginFiles: [],
    agentFile: "AGENTS.md",
    needsAgentsSkills: true,
    detect: (root) => fs.existsSync(path.join(root, ".gemini/antigravity")),
  },
};

/** Core files always installed (server, modules, config, package manifest) */
const CORE_FILES = [
  "server.ts",
  "module-graph.ts",
  "tsserver-client.ts",
  "graph-queries.ts",
  "config.ts",
  "check.ts",
  "smoke-test.ts",
  "cli.ts",
  "package.json",
];

/** Skill files inside plugin dir (Claude Code + Cursor discover from skills/) */
const SKILL_FILES = [
  "skills/tool-selection/SKILL.md",
  "skills/impact-analysis/SKILL.md",
  "skills/refactor-safety/SKILL.md",
  "skills/dependency-audit/SKILL.md",
  "skills/code-exploration/SKILL.md",
  "skills/deep-survey/SKILL.md",
];

const CLAUDE_TEMPLATE_FILES = new Set([
  "commands/check.md",
  "commands/test.md",
  "commands/bench.md",
  "commands/deep-survey.md",
  "skills/deep-survey/SKILL.md",
]);


const SKILL_NAMES = [
  "tool-selection",
  "impact-analysis",
  "refactor-safety",
  "dependency-audit",
  "code-exploration",
  "deep-survey",
];

const HELP = `
typegraph-mcp — Type-aware codebase navigation for AI coding agents.

Usage: typegraph-mcp <command> [options]

Commands:
  setup    Install typegraph-mcp plugin into the current project
  remove   Uninstall typegraph-mcp from the current project
  check    Run health checks (12 checks)
  test     Run smoke tests (all 14 tools)
  bench    Run benchmarks (token, latency, accuracy)
  start    Start the MCP server (stdin/stdout)

Options:
  --yes                 Skip confirmation prompts (accept all defaults)
  --clean-global-codex  Also remove a stale global Codex MCP entry for this project
  --help                Show this help
`.trim();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function copyFile(src: string, dest: string): void {
  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  fs.copyFileSync(src, dest);
  // Preserve executable bit for scripts
  if (src.endsWith(".sh")) {
    fs.chmodSync(dest, 0o755);
  }
}

// ─── MCP Server Registration ────────────────────────────────────────────────

const MCP_SERVER_ENTRY = {
  command: "npx",
  args: ["tsx", "./plugins/typegraph-mcp/server.ts"],
  env: {
    TYPEGRAPH_PROJECT_ROOT: ".",
    TYPEGRAPH_TSCONFIG: "./tsconfig.json",
  },
};

function getAbsoluteMcpServerEntry(projectRoot: string): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return {
    command: "npx",
    args: ["tsx", path.resolve(projectRoot, PLUGIN_DIR_NAME, "server.ts")],
    env: {
      TYPEGRAPH_PROJECT_ROOT: projectRoot,
      TYPEGRAPH_TSCONFIG: path.resolve(projectRoot, "tsconfig.json"),
    },
  };
}

function getCodexMcpServerEntry(projectRoot: string): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  return {
    command: path.resolve(projectRoot, PLUGIN_DIR_NAME, "node_modules/.bin/tsx"),
    args: [path.resolve(projectRoot, PLUGIN_DIR_NAME, "server.ts")],
    env: {
      TYPEGRAPH_PROJECT_ROOT: projectRoot,
      TYPEGRAPH_TSCONFIG: path.resolve(projectRoot, "tsconfig.json"),
    },
  };
}

function getCodexConfigPath(projectRoot: string): string {
  return path.resolve(projectRoot, ".codex/config.toml");
}

function getAntigravityMcpConfigPaths(): string[] {
  const home = process.env.HOME || "";
  return [
    path.join(home, ".gemini/antigravity/mcp_config.json"),
    path.join(home, ".gemini/antigravity-cli/plugins/typegraph-mcp/mcp_config.json"),
  ];
}

function ensureAntigravityCliPlugin(): void {
  const home = process.env.HOME || "";
  const pluginDir = path.join(home, ".gemini/antigravity-cli/plugins/typegraph-mcp");
  const pluginJsonPath = path.join(pluginDir, "plugin.json");
  if (!fs.existsSync(pluginJsonPath)) {
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      pluginJsonPath,
      JSON.stringify(
        {
          name: "typegraph-mcp",
          version: "1.0.0",
          description: "TypeGraph MCP server for TypeScript navigation",
        },
        null,
        2
      ) + "\n"
    );
  }
}

function isTomlSectionGroup(sectionName: string | null, prefix: string): boolean {
  return sectionName === prefix || sectionName?.startsWith(`${prefix}.`) === true;
}

function splitTomlBlocks(content: string): Array<{ sectionName: string | null; raw: string }> {
  const lines = content.split(/\r?\n/);
  const blocks: Array<{ sectionName: string | null; raw: string }> = [];
  let sectionName: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const match = line.match(/^\[([^\]]+)\]\s*$/);
    if (match) {
      if (currentLines.length > 0 || sectionName !== null) {
        blocks.push({ sectionName, raw: currentLines.join("\n") });
      }
      sectionName = match[1]!;
      currentLines = [line];
      continue;
    }

    currentLines.push(line);
  }

  if (currentLines.length > 0 || sectionName !== null) {
    blocks.push({ sectionName, raw: currentLines.join("\n") });
  }

  return blocks;
}

function removeTomlSectionGroup(
  content: string,
  prefix: string
): { content: string; removed: boolean; removedContent: string } {
  const blocks = splitTomlBlocks(content);
  const removedBlocks = blocks.filter((block) => isTomlSectionGroup(block.sectionName, prefix));
  if (removedBlocks.length === 0) {
    return { content, removed: false, removedContent: "" };
  }

  const keptBlocks = blocks.filter((block) => !isTomlSectionGroup(block.sectionName, prefix));
  const nextContent = keptBlocks
    .map((block) => block.raw)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();

  return {
    content: nextContent ? `${nextContent}\n` : "",
    removed: true,
    removedContent: removedBlocks.map((block) => block.raw).join("\n").trim(),
  };
}

function upsertCodexMcpSection(content: string, block: string): { content: string; changed: boolean } {
  const sectionRe = /\n?\[mcp_servers\.typegraph\]\n[\s\S]*?(?=\n\[|$)/;
  const normalizedBlock = block.trim();

  if (sectionRe.test(content)) {
    const existingSection = (content.match(sectionRe)?.[0] ?? "").trim();
    if (existingSection === normalizedBlock) {
      return { content, changed: false };
    }

    const nextContent = content.replace(sectionRe, `\n${normalizedBlock}\n`);
    return { content: nextContent.trimEnd() + "\n", changed: true };
  }

  const nextContent = content
    ? content.trimEnd() + "\n\n" + normalizedBlock + "\n"
    : normalizedBlock + "\n";
  return { content: nextContent, changed: true };
}

function makeCodexMcpBlock(projectRoot: string): string {
  const absoluteEntry = getCodexMcpServerEntry(projectRoot);
  const args = absoluteEntry.args.map((arg) => `"${arg}"`).join(", ");
  return [
    "",
    "[mcp_servers.typegraph]",
    `command = "${absoluteEntry.command}"`,
    `args = [${args}]`,
    `env = { TYPEGRAPH_PROJECT_ROOT = "${absoluteEntry.env.TYPEGRAPH_PROJECT_ROOT}", TYPEGRAPH_TSCONFIG = "${absoluteEntry.env.TYPEGRAPH_TSCONFIG}" }`,
    "",
  ].join("\n");
}

function isCodexProjectTrusted(projectRoot: string): boolean {
  const home = process.env.HOME;
  if (!home) return false;

  const globalConfigPath = path.join(home, ".codex/config.toml");
  if (!fs.existsSync(globalConfigPath)) return false;

  const content = fs.readFileSync(globalConfigPath, "utf-8");
  const lines = content.split(/\r?\n/);
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

function pathEqualsOrContains(candidatePath: string, targetPath: string): boolean {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedTarget = path.resolve(targetPath);
  if (resolvedCandidate === resolvedTarget || resolvedCandidate.startsWith(`${resolvedTarget}${path.sep}`)) {
    return true;
  }

  try {
    const realCandidate = fs.realpathSync(candidatePath);
    const realTarget = fs.realpathSync(targetPath);
    return realCandidate === realTarget || realCandidate.startsWith(`${realTarget}${path.sep}`);
  } catch {
    return false;
  }
}

function findLegacyGlobalCodexCleanup(projectRoot: string): LegacyGlobalCodexCleanup | null {
  const home = process.env.HOME;
  if (!home) return null;

  const globalConfigPath = path.join(home, ".codex/config.toml");
  if (!fs.existsSync(globalConfigPath)) return null;

  const content = fs.readFileSync(globalConfigPath, "utf-8");
  const { content: nextContent, removed, removedContent } = removeTomlSectionGroup(content, "mcp_servers.typegraph");
  if (!removed) return null;

  const pluginRoot = path.resolve(projectRoot, PLUGIN_DIR_NAME);
  const quotedPaths = Array.from(removedContent.matchAll(/"([^"\n]+)"/g), (match) => match[1]!);
  const looksProjectSpecific = quotedPaths.some((quotedPath) =>
    pathEqualsOrContains(quotedPath, projectRoot) ||
    pathEqualsOrContains(quotedPath, pluginRoot)
  );

  if (!looksProjectSpecific) {
    return null;
  }

  return { globalConfigPath, nextContent };
}

function removeLegacyGlobalCodexMcp(cleanup: LegacyGlobalCodexCleanup): void {
  if (cleanup.nextContent === "") {
    fs.unlinkSync(cleanup.globalConfigPath);
  } else {
    fs.writeFileSync(cleanup.globalConfigPath, cleanup.nextContent);
  }

  p.log.info("~/.codex/config.toml: removed stale global typegraph MCP server entry for this project");
}

async function resolveRemovePluginOptions(
  projectRoot: string,
  yes: boolean,
  cleanGlobalCodex: boolean
): Promise<RemovePluginOptions> {
  const legacyGlobalCodexCleanup = findLegacyGlobalCodexCleanup(projectRoot);
  let removeGlobalCodex = cleanGlobalCodex;

  if (legacyGlobalCodexCleanup && !cleanGlobalCodex && !yes) {
    const shouldRemoveGlobal = await p.confirm({
      message: "Also remove the stale global Codex MCP entry for this project from ~/.codex/config.toml?",
      initialValue: false,
    });
    if (p.isCancel(shouldRemoveGlobal)) {
      p.cancel("Removal cancelled.");
      process.exit(0);
    }
    removeGlobalCodex = shouldRemoveGlobal;
  }

  return {
    removeGlobalCodex,
    legacyGlobalCodexCleanup,
    warnAboutGlobalCodex: legacyGlobalCodexCleanup !== null && !removeGlobalCodex,
  };
}

function warnAboutStaleGlobalCodex(): void {
  p.log.warn(
    "Left a stale global Codex MCP entry for this project in ~/.codex/config.toml. " +
    "Codex may show MCP startup warnings or errors until you remove it. " +
    "Re-run `typegraph-mcp remove --clean-global-codex` or remove the `typegraph` block manually."
  );
}

/** Register the typegraph MCP server in agent-specific config files */
function registerMcpServers(projectRoot: string, selectedAgents: AgentId[]): void {
  if (selectedAgents.includes("cursor")) {
    registerJsonMcp(projectRoot, ".cursor/mcp.json", "mcpServers");
  }
  if (selectedAgents.includes("codex")) {
    registerCodexMcp(projectRoot);
  }
  if (selectedAgents.includes("copilot")) {
    registerJsonMcp(projectRoot, ".vscode/mcp.json", "servers");
  }
  if (selectedAgents.includes("antigravity")) {
    registerAntigravityMcp(projectRoot);
  }
}

/** Deregister the typegraph MCP server from all agent config files */
function deregisterMcpServers(projectRoot: string): void {
  deregisterJsonMcp(projectRoot, ".cursor/mcp.json", "mcpServers");
  deregisterCodexMcp(projectRoot);
  deregisterJsonMcp(projectRoot, ".vscode/mcp.json", "servers");
  deregisterAntigravityMcp(projectRoot);
}

/** Register MCP server in a JSON config file (Cursor or Copilot format) */
function registerJsonMcp(projectRoot: string, configPath: string, rootKey: string): void {
  const fullPath = path.resolve(projectRoot, configPath);
  let config: Record<string, unknown> = {};

  if (fs.existsSync(fullPath)) {
    try {
      config = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
    } catch {
      p.log.warn(`Could not parse ${configPath} — skipping MCP registration`);
      return;
    }
  }

  const servers = (config[rootKey] as Record<string, unknown>) ?? {};
  const entry: Record<string, unknown> = { ...MCP_SERVER_ENTRY };
  // Copilot requires "type": "stdio"
  if (rootKey === "servers") {
    entry.type = "stdio";
  }
  servers["typegraph"] = entry;
  config[rootKey] = servers;

  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(fullPath, JSON.stringify(config, null, 2) + "\n");
  p.log.success(`${configPath}: registered typegraph MCP server`);
}

/** Deregister MCP server from a JSON config file */
function deregisterJsonMcp(projectRoot: string, configPath: string, rootKey: string): void {
  const fullPath = path.resolve(projectRoot, configPath);
  if (!fs.existsSync(fullPath)) return;

  try {
    const config = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
    const servers = config[rootKey];
    if (!servers || !servers["typegraph"]) return;

    delete servers["typegraph"];

    // Clean up empty objects
    if (Object.keys(servers).length === 0) {
      delete config[rootKey];
    }

    // If config is now empty, remove the file
    if (Object.keys(config).length === 0) {
      fs.unlinkSync(fullPath);
    } else {
      fs.writeFileSync(fullPath, JSON.stringify(config, null, 2) + "\n");
    }
    p.log.info(`${configPath}: removed typegraph MCP server`);
  } catch {
    // Ignore parse errors
  }
}

/** Register MCP server in Codex CLI's TOML config */
function registerCodexMcp(projectRoot: string): void {
  const configPath = ".codex/config.toml";
  const fullPath = getCodexConfigPath(projectRoot);
  const block = makeCodexMcpBlock(projectRoot);
  let content = "";

  if (fs.existsSync(fullPath)) {
    content = fs.readFileSync(fullPath, "utf-8");
  }

  const dir = path.dirname(fullPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const { content: nextContent, changed } = upsertCodexMcpSection(content, block);
  if (changed) {
    fs.writeFileSync(fullPath, nextContent);
    p.log.success(`${configPath}: registered typegraph MCP server`);
  } else {
    p.log.info(`${configPath}: typegraph MCP server already registered`);
  }

  if (!isCodexProjectTrusted(projectRoot)) {
    p.log.info(`Codex CLI: trust ${projectRoot} in ~/.codex/config.toml to load project MCP settings`);
  }
}

/** Deregister MCP server from Codex CLI's TOML config */
function deregisterCodexMcp(projectRoot: string): void {
  const configPath = ".codex/config.toml";
  const fullPath = getCodexConfigPath(projectRoot);
  if (fs.existsSync(fullPath)) {
    const content = fs.readFileSync(fullPath, "utf-8");
    const { content: nextContent, removed } = removeTomlSectionGroup(content, "mcp_servers.typegraph");

    if (removed) {
      if (nextContent === "") {
        fs.unlinkSync(fullPath);
      } else {
        fs.writeFileSync(fullPath, nextContent);
      }
      p.log.info(`${configPath}: removed typegraph MCP server`);
    }
  }
}

/** Register MCP server in Antigravity's config files */
function registerAntigravityMcp(projectRoot: string): void {
  const home = process.env.HOME || "";
  const pluginDir = path.resolve(projectRoot, PLUGIN_DIR_NAME);
  const tsConfigPath = path.resolve(projectRoot, "tsconfig.json");
  ensureAntigravityCliPlugin();

  const entry = {
    command: process.execPath,
    args: [
      path.join(pluginDir, "node_modules/tsx/dist/cli.mjs"),
      path.join(pluginDir, "server.ts"),
    ],
    env: {
      TYPEGRAPH_PROJECT_ROOT: projectRoot,
      TYPEGRAPH_TSCONFIG: tsConfigPath,
    },
  };

  for (const configPath of getAntigravityMcpConfigPaths()) {
    let config: any = { mcpServers: {} };
    if (fs.existsSync(configPath)) {
      try {
        config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      } catch {
        p.log.warn(`Could not parse ~${configPath.replace(home, "")} — skipping MCP registration`);
        continue;
      }
    }
    if (!config.mcpServers) config.mcpServers = {};
    config.mcpServers["typegraph-mcp"] = entry;

    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    p.log.success(`~${configPath.replace(home, "")}: registered typegraph-mcp server`);
  }
}

/** Deregister MCP server from Antigravity's config files */
function deregisterAntigravityMcp(projectRoot: string): void {
  const home = process.env.HOME || "";

  for (const configPath of getAntigravityMcpConfigPaths()) {
    if (!fs.existsSync(configPath)) continue;
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (config.mcpServers && config.mcpServers["typegraph-mcp"]) {
        delete config.mcpServers["typegraph-mcp"];
        if (Object.keys(config.mcpServers).length === 0) {
          delete config.mcpServers;
        }
        if (Object.keys(config).length === 0) {
          fs.unlinkSync(configPath);
        } else {
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
        }
        p.log.info(`~${configPath.replace(home, "")}: removed typegraph-mcp server`);
      }
    } catch {
      // Ignore
    }
  }
}

// ─── TSConfig Exclude ─────────────────────────────────────────────────────────

function ensureTsconfigExclude(projectRoot: string): void {
  const tsconfigPath = path.resolve(projectRoot, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) return;

  try {
    const raw = fs.readFileSync(tsconfigPath, "utf-8");
    const excludeArrayMatch = raw.match(/("exclude"\s*:\s*\[)([\s\S]*?)(\])/);
    if (excludeArrayMatch && /["']plugins(?:\/\*\*|\/\*|)["']/.test(excludeArrayMatch[2])) {
      return;
    }

    // Insert "plugins/**" into the exclude array in the original file
    if (excludeArrayMatch) {
      // Existing exclude array — append to it
      const updated = raw.replace(
        /("exclude"\s*:\s*\[)([\s\S]*?)(\])/,
        (_match, open, items, close) => {
          const trimmed = items.trimEnd();
          const needsComma = trimmed.length > 0 && !trimmed.endsWith(",");
          return `${open}${items.trimEnd()}${needsComma ? "," : ""}\n    "plugins/**"${close}`;
        }
      );
      fs.writeFileSync(tsconfigPath, updated);
    } else {
      // No exclude field — add one before the closing brace
      const lastBrace = raw.lastIndexOf("}");
      if (lastBrace !== -1) {
        const before = raw.slice(0, lastBrace).trimEnd();
        const needsComma = !before.endsWith(",") && !before.endsWith("{");
        const patched = `${before}${needsComma ? "," : ""}\n  "exclude": ["plugins/**"]\n}\n`;
        fs.writeFileSync(tsconfigPath, patched);
      }
    }

    p.log.success('Added "plugins/**" to tsconfig.json exclude (prevents build errors)');
  } catch {
    // Don't fail setup over tsconfig parsing issues
    p.log.warn('Could not update tsconfig.json — manually add "plugins/**" to the exclude array to prevent build errors');
  }
}

// ─── Lint Ignore ─────────────────────────────────────────────────────────────

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

type LintConfig =
  | { tool: "ESLint"; fileName: string; fullPath: string; format: "flat" }
  | { tool: "Oxlint"; fileName: string; fullPath: string; format: "json" | "module" };

function findLintConfigs(projectRoot: string): LintConfig[] {
  const configs: LintConfig[] = [];

  for (const fileName of ESLINT_CONFIG_NAMES) {
    const fullPath = path.resolve(projectRoot, fileName);
    if (fs.existsSync(fullPath)) {
      configs.push({ tool: "ESLint", fileName, fullPath, format: "flat" });
    }
  }

  for (const fileName of OXLINT_CONFIG_NAMES) {
    const fullPath = path.resolve(projectRoot, fileName);
    if (fs.existsSync(fullPath)) {
      configs.push({
        tool: "Oxlint",
        fileName,
        fullPath,
        format: fileName.endsWith(".json") ? "json" : "module",
      });
    }
  }

  return configs;
}

function appendToArrayLiteral(raw: string, propertyPattern: RegExp, valueLiteral: string): string | null {
  if (!propertyPattern.test(raw)) return null;
  return raw.replace(propertyPattern, (_match, open, items, close) => {
    const trimmed = items.trimEnd();
    const needsComma = trimmed.length > 0 && !trimmed.endsWith(",");
    return `${open}${items.trimEnd()}${needsComma ? "," : ""} ${valueLiteral}${close}`;
  });
}

function insertTopLevelJsonArrayProperty(raw: string, propertyName: string, valueLiteral: string): string | null {
  const lastBrace = raw.lastIndexOf("}");
  if (lastBrace === -1) return null;
  const before = raw.slice(0, lastBrace).trimEnd();
  const needsComma = !before.endsWith(",") && !before.endsWith("{");
  return `${before}${needsComma ? "," : ""}\n  "${propertyName}": [${valueLiteral}]\n}\n`;
}

function patchEslintConfig(raw: string): string | null {
  const updatedIgnores = appendToArrayLiteral(raw, /(ignores\s*:\s*\[)([\s\S]*?)(\])/, '"plugins/**"');
  if (updatedIgnores) return updatedIgnores;

  // Matches: export default [ or export default tseslint.config(
  const exportArrayRe = /(export\s+default\s+(?:\w+\.config\(|\[))\s*\n?/;
  if (exportArrayRe.test(raw)) {
    return raw.replace(exportArrayRe, (match) => `${match}  { ignores: ["plugins/**"] },\n`);
  }

  return null;
}

function patchOxlintJsonConfig(raw: string): string | null {
  const updatedIgnores = appendToArrayLiteral(
    raw,
    /("ignorePatterns"\s*:\s*\[)([\s\S]*?)(\])/,
    '"plugins/**"'
  );
  if (updatedIgnores) return updatedIgnores;
  return insertTopLevelJsonArrayProperty(raw, "ignorePatterns", '"plugins/**"');
}

function patchOxlintModuleConfig(raw: string): string | null {
  const updatedIgnores = appendToArrayLiteral(
    raw,
    /(ignorePatterns\s*:\s*\[)([\s\S]*?)(\])/,
    '"plugins/**"'
  );
  if (updatedIgnores) return updatedIgnores;

  const exportObjectRe = /(export\s+default\s*\{)\s*\n?/;
  if (exportObjectRe.test(raw)) {
    return raw.replace(exportObjectRe, (match) => `${match}\n  ignorePatterns: ["plugins/**"],`);
  }

  return null;
}

function ensureLintIgnores(projectRoot: string): void {
  const configs = findLintConfigs(projectRoot);
  for (const config of configs) {
    try {
      const raw = fs.readFileSync(config.fullPath, "utf-8");
      if (/["']plugins\/\*\*["']/.test(raw)) continue;

      const updated =
        config.tool === "ESLint"
          ? patchEslintConfig(raw)
          : config.format === "json"
            ? patchOxlintJsonConfig(raw)
            : patchOxlintModuleConfig(raw);

      if (updated) {
        fs.writeFileSync(config.fullPath, updated);
        const propertyName = config.tool === "ESLint" ? "ignores" : "ignorePatterns";
        p.log.success(`Added "plugins/**" to ${config.fileName} ${propertyName}`);
      } else {
        const propertyName = config.tool === "ESLint" ? "ignores" : "ignorePatterns";
        p.log.warn(
          `Could not patch ${config.fileName} — manually add "plugins/**" to ${propertyName}`
        );
      }
    } catch {
      const propertyName = config.tool === "ESLint" ? "ignores" : "ignorePatterns";
      p.log.warn(
        `Could not update ${config.fileName} — manually add "plugins/**" to ${propertyName}`
      );
    }
  }
}

// ─── Agent Selection ─────────────────────────────────────────────────────────

function detectAgents(projectRoot: string): AgentId[] {
  return AGENT_IDS.filter((id) => AGENTS[id].detect(projectRoot));
}

async function selectAgents(projectRoot: string, yes: boolean): Promise<AgentId[]> {
  const detected = detectAgents(projectRoot);

  if (yes) {
    const selected = detected.length > 0 ? detected : [...AGENT_IDS];
    p.log.info(`Auto-selected: ${selected.map((id) => AGENTS[id].name).join(", ")}`);
    return selected;
  }

  p.log.info("space = toggle  |  up/down = navigate  |  enter = confirm");

  const result = await p.multiselect({
    message: "Select which AI agents to configure:",
    options: AGENT_IDS.map((id) => ({
      value: id,
      label: AGENTS[id].name,
      hint: detected.includes(id) ? "detected" : undefined,
    })),
    initialValues: detected.length > 0 ? detected : [...AGENT_IDS],
    required: false,
  });

  if (p.isCancel(result)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const selected = (result as AgentId[]).length > 0 ? (result as AgentId[]) : (detected.length > 0 ? detected : [...AGENT_IDS]);

  p.log.info(`Selected: ${selected.map((id) => AGENTS[id].name).join(", ")}`);

  return selected;
}

// ─── Setup Command ───────────────────────────────────────────────────────────

async function setup(yes: boolean): Promise<void> {
  const sourceDir = path.basename(import.meta.dirname) === "dist"
    ? path.resolve(import.meta.dirname, "..")
    : import.meta.dirname;
  const projectRoot = process.cwd();

  process.stdout.write("\x1Bc"); // Clear terminal
  p.intro("TypeGraph MCP Setup");

  p.log.info(`Project: ${projectRoot}`);

  // 1. Validate project
  const pkgJsonPath = path.resolve(projectRoot, "package.json");
  const tsconfigPath = path.resolve(projectRoot, "tsconfig.json");

  if (!fs.existsSync(pkgJsonPath)) {
    p.cancel("No package.json found. Run this from the root of your TypeScript project.");
    process.exit(1);
  }

  if (!fs.existsSync(tsconfigPath)) {
    p.cancel("No tsconfig.json found. typegraph-mcp requires a TypeScript project.");
    process.exit(1);
  }

  p.log.success("Found package.json and tsconfig.json");

  // 2. Check for existing installation
  const targetDir = path.resolve(projectRoot, PLUGIN_DIR_NAME);
  const isUpdate = fs.existsSync(targetDir);

  if (isUpdate && !yes) {
    const action = await p.select({
      message: `${PLUGIN_DIR_NAME}/ already exists.`,
      options: [
        { value: "update", label: "Update", hint: "reinstall plugin files" },
        { value: "remove", label: "Remove", hint: "uninstall typegraph-mcp from this project" },
        { value: "exit", label: "Exit", hint: "keep existing installation" },
      ],
    });

    if (p.isCancel(action)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    if (action === "remove") {
      const removeOptions = await resolveRemovePluginOptions(projectRoot, false, false);
      await removePlugin(projectRoot, targetDir, removeOptions);
      if (removeOptions.warnAboutGlobalCodex) {
        warnAboutStaleGlobalCodex();
      }
      return;
    }

    if (action === "exit") {
      p.outro("No changes made.");
      return;
    }
  }

  // 3. Agent selection
  const selectedAgents = await selectAgents(projectRoot, yes);

  const needsPluginSkills = selectedAgents.includes("claude-code") || selectedAgents.includes("cursor") || selectedAgents.includes("antigravity");
  const needsAgentsSkills = selectedAgents.some((id) => AGENTS[id].needsAgentsSkills);

  p.log.step(`Installing to ${PLUGIN_DIR_NAME}/...`);

  const s = p.spinner();
  s.start("Copying files...");

  // Assemble file list based on selected agents
  const filesToCopy = [...CORE_FILES];

  // Skills are always needed (either for in-plugin discovery or as source for .agents/skills/ copies)
  if (needsPluginSkills || needsAgentsSkills) {
    filesToCopy.push(...SKILL_FILES);
  }

  // Add agent-specific files
  for (const agentId of selectedAgents) {
    filesToCopy.push(...AGENTS[agentId].pluginFiles);
  }

  // Copy files

  let copied = 0;
  for (const file of filesToCopy) {
    const src = path.join(sourceDir, file);
    const dest = path.join(targetDir, file);
    if (fs.existsSync(src)) {
      if (selectedAgents.includes("claude-code") && CLAUDE_TEMPLATE_FILES.has(file)) {
        const content = fs.readFileSync(src, "utf-8")
          .replaceAll(CLAUDE_NODE_PLACEHOLDER, process.execPath);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content);
      } else {
        copyFile(src, dest);
      }
      copied++;
    } else {
      p.log.warn(`Source file not found: ${file}`);
    }
  }

  // Generate .mcp.json for Claude Code plugin discovery
  if (selectedAgents.includes("claude-code")) {
    const mcpConfig = {
      mcpServers: {
        typegraph: {
          command: process.execPath,
          args: ["${CLAUDE_PLUGIN_ROOT}/node_modules/tsx/dist/cli.mjs", "${CLAUDE_PLUGIN_ROOT}/server.ts"],
          env: {
            TYPEGRAPH_PROJECT_ROOT: ".",
            TYPEGRAPH_TSCONFIG: "./tsconfig.json",
          },
        },
      },
    };
    const mcpPath = path.join(targetDir, ".mcp.json");
    fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
    fs.writeFileSync(mcpPath, JSON.stringify(mcpConfig, null, 2) + "\n");
    copied++;
  }

  s.message("Installing dependencies...");
  try {
    execSync("npm install --include=optional", { cwd: targetDir, stdio: "pipe" });
    s.stop(`${isUpdate ? "Updated" : "Installed"} ${copied} files with dependencies`);
  } catch (err) {
    s.stop(`${isUpdate ? "Updated" : "Installed"} ${copied} files`);
    p.log.warn(`Dependency install failed: ${err instanceof Error ? err.message : String(err)}`);
    p.log.info(`Run manually: cd ${PLUGIN_DIR_NAME} && npm install --include=optional`);
  }

  // 4. Copy skills to .agents/skills/ for cross-platform discovery
  if (needsAgentsSkills) {
    const agentsNames = selectedAgents
      .filter((id) => AGENTS[id].needsAgentsSkills)
      .map((id) => AGENTS[id].name);

    const agentsSkillsDir = path.resolve(projectRoot, ".agents/skills");
    let copiedSkills = 0;
    for (const skill of SKILL_NAMES) {
      const src = path.join(targetDir, "skills", skill, "SKILL.md");
      const destDir = path.join(agentsSkillsDir, skill);
      const dest = path.join(destDir, "SKILL.md");
      if (!fs.existsSync(src)) continue;
      if (fs.existsSync(dest)) {
        const srcContent = fs.readFileSync(src, "utf-8");
        const destContent = fs.readFileSync(dest, "utf-8");
        if (srcContent === destContent) continue;
      }
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(src, dest);
      copiedSkills++;
    }
    if (copiedSkills > 0) {
      p.log.success(`Copied ${copiedSkills} skills to .agents/skills/ (${agentsNames.join(", ")})`);
    } else {
      p.log.info(".agents/skills/ already up to date");
    }
  }

  // 5. Remove old .claude/mcp.json entry if Claude Code is selected
  if (selectedAgents.includes("claude-code")) {
    const mcpJsonPath = path.resolve(projectRoot, ".claude/mcp.json");
    if (fs.existsSync(mcpJsonPath)) {
      try {
        const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
        if (mcpJson.mcpServers?.["typegraph"]) {
          delete mcpJson.mcpServers["typegraph"];
          fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2) + "\n");
          p.log.info("Removed old typegraph entry from .claude/mcp.json");
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  // 6. Agent instructions
  await setupAgentInstructions(projectRoot, selectedAgents);

  // 7. Register MCP server in agent-specific configs
  registerMcpServers(projectRoot, selectedAgents);

  // 8. Ensure plugins/ is excluded from tsconfig
  ensureTsconfigExclude(projectRoot);

  // 9. Ensure plugins/ is ignored by supported lint configs
  ensureLintIgnores(projectRoot);

  // 10. Verification
  await runVerification(targetDir, selectedAgents);
}

// ─── Remove Command ──────────────────────────────────────────────────────────

async function removePlugin(
  projectRoot: string,
  pluginDir: string,
  options: RemovePluginOptions
): Promise<void> {
  const s = p.spinner();
  s.start("Removing typegraph-mcp...");

  // 1. Deregister MCP server from agent config files while project paths still exist
  deregisterMcpServers(projectRoot);
  if (options.removeGlobalCodex && options.legacyGlobalCodexCleanup) {
    removeLegacyGlobalCodexMcp(options.legacyGlobalCodexCleanup);
  }

  // 2. Remove plugin directory
  if (fs.existsSync(pluginDir)) {
    fs.rmSync(pluginDir, { recursive: true });
  }

  // 3. Remove .agents/skills/ entries (only typegraph-mcp skills, not the whole dir)
  const agentsSkillsDir = path.resolve(projectRoot, ".agents/skills");
  for (const skill of SKILL_NAMES) {
    const skillDir = path.join(agentsSkillsDir, skill);
    if (fs.existsSync(skillDir)) {
      fs.rmSync(skillDir, { recursive: true });
    }
  }
  // Clean up .agents/skills/ and .agents/ if empty
  if (fs.existsSync(agentsSkillsDir) && fs.readdirSync(agentsSkillsDir).length === 0) {
    fs.rmSync(agentsSkillsDir, { recursive: true });
    const agentsDir = path.resolve(projectRoot, ".agents");
    if (fs.existsSync(agentsDir) && fs.readdirSync(agentsDir).length === 0) {
      fs.rmSync(agentsDir, { recursive: true });
    }
  }

  // 4. Remove agent instruction snippet from all known agent files
  const allAgentFiles = AGENT_IDS
    .map((id) => AGENTS[id].agentFile)
    .filter((f): f is string => f !== null);

  const seenRealPaths = new Set<string>();
  for (const agentFile of allAgentFiles) {
    const filePath = path.resolve(projectRoot, agentFile);
    if (!fs.existsSync(filePath)) continue;
    const realPath = fs.realpathSync(filePath);
    if (seenRealPaths.has(realPath)) continue;
    seenRealPaths.add(realPath);

    let content = fs.readFileSync(realPath, "utf-8");
    if (content.includes(SNIPPET_MARKER)) {
      // Remove the snippet block (from marker to end of the bullet list)
      content = content.replace(/\n?## TypeScript Navigation \(typegraph-mcp\)\n[\s\S]*?(?=\n## |\n# |$)/, "");
      // Clean up trailing whitespace
      content = content.replace(/\n{3,}$/, "\n");
      fs.writeFileSync(realPath, content);
    }
  }

  // 5. Remove --plugin-dir ./plugins/typegraph-mcp from CLAUDE.md
  const claudeMdPath = path.resolve(projectRoot, "CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) {
    let content = fs.readFileSync(claudeMdPath, "utf-8");
    content = content.replace(/ --plugin-dir \.\/plugins\/typegraph-mcp/g, "");
    fs.writeFileSync(claudeMdPath, content);
  }

  s.stop("Removed typegraph-mcp");

  p.outro("typegraph-mcp has been uninstalled from this project.");
}

async function setupAgentInstructions(projectRoot: string, selectedAgents: AgentId[]): Promise<void> {
  // Collect agent instruction files for selected agents
  const agentFiles = selectedAgents
    .map((id) => AGENTS[id].agentFile)
    .filter((f): f is string => f !== null);

  if (agentFiles.length === 0) {
    return; // No agents with instruction files selected (e.g. Cursor only)
  }

  // Ensure each selected agent file exists and has the snippet once. Resolve
  // symlinks to avoid writing duplicate content through multiple aliases.
  const seenRealPaths = new Map<string, string>(); // realPath -> first agentFile name
  for (const agentFile of agentFiles) {
    const filePath = path.resolve(projectRoot, agentFile);
    if (!fs.existsSync(filePath)) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, AGENT_SNIPPET + "\n");
      p.log.success(`${agentFile}: created with typegraph-mcp instructions`);
      continue;
    }

    const realPath = fs.realpathSync(filePath);
    const previousFile = seenRealPaths.get(realPath);
    if (previousFile) {
      p.log.info(`${agentFile}: same file as ${previousFile} (skipped)`);
      continue;
    }

    seenRealPaths.set(realPath, agentFile);
    const content = fs.readFileSync(realPath, "utf-8");
    if (content.includes(SNIPPET_MARKER)) {
      p.log.info(`${agentFile}: already has typegraph-mcp instructions`);
      continue;
    }

    const appendContent = (content.endsWith("\n") ? "" : "\n") + "\n" + AGENT_SNIPPET;
    fs.appendFileSync(realPath, appendContent);
    p.log.success(`${agentFile}: appended typegraph-mcp instructions`);
  }

  // Update --plugin-dir line in CLAUDE.md if Claude Code is selected
  if (selectedAgents.includes("claude-code")) {
    const claudeMdPath = path.resolve(projectRoot, "CLAUDE.md");
    if (fs.existsSync(claudeMdPath)) {
      let content = fs.readFileSync(claudeMdPath, "utf-8");
      const pluginDirPattern = /(`claude\s+)((?:--plugin-dir\s+\S+\s*)+)(`)/;
      const match = content.match(pluginDirPattern);

      if (match && !match[2]!.includes("./plugins/typegraph-mcp")) {
        const existingFlags = match[2]!.trimEnd();
        content = content.replace(
          pluginDirPattern,
          `$1${existingFlags} --plugin-dir ./plugins/typegraph-mcp$3`
        );
        fs.writeFileSync(claudeMdPath, content);
        p.log.success("CLAUDE.md: added --plugin-dir ./plugins/typegraph-mcp");
      } else if (match) {
        p.log.info("CLAUDE.md: --plugin-dir already includes typegraph-mcp");
      }
    }
  }
}

async function runVerification(pluginDir: string, selectedAgents: AgentId[]): Promise<void> {
  const config = resolveConfig(pluginDir);

  console.log("");
  const { main: checkMain } = await import("./check.js");
  const checkResult = await checkMain(config);

  console.log("");

  if (checkResult.failed > 0) {
    p.cancel("Health check has failures — fix the issues above before running smoke tests.");
    process.exit(1);
  }

  const { main: testMain } = await import("./smoke-test.js");
  const testResult = await testMain(config);

  console.log("");

  if (checkResult.failed === 0 && testResult.failed === 0) {
    if (selectedAgents.includes("claude-code")) {
      p.outro("Setup complete! Run: claude --plugin-dir ./plugins/typegraph-mcp\n  Slash commands: /typegraph:check, /typegraph:test, /typegraph:bench, /typegraph:deep-survey");
    } else {
      p.outro("Setup complete! typegraph-mcp tools are now available to your agents.\n  CLI: npx typegraph-mcp check | test | bench");
    }
  } else {
    p.cancel("Setup completed with issues. Fix the failures above and re-run.");
    process.exit(1);
  }
}

// ─── Remove Command (standalone) ─────────────────────────────────────────────

async function remove(yes: boolean): Promise<void> {
  const projectRoot = process.cwd();
  const pluginDir = path.resolve(projectRoot, PLUGIN_DIR_NAME);
  const cleanGlobalCodex = args.includes("--clean-global-codex");

  process.stdout.write("\x1Bc");
  p.intro("TypeGraph MCP Remove");

  if (!fs.existsSync(pluginDir)) {
    p.cancel("typegraph-mcp is not installed in this project.");
    process.exit(1);
  }

  if (!yes) {
    const confirmed = await p.confirm({ message: "Remove typegraph-mcp from this project?" });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("Removal cancelled.");
      process.exit(0);
    }
  }

  const removeOptions = await resolveRemovePluginOptions(projectRoot, yes, cleanGlobalCodex);
  await removePlugin(projectRoot, pluginDir, removeOptions);

  if (removeOptions.warnAboutGlobalCodex) {
    warnAboutStaleGlobalCodex();
  }
}

// ─── Check Command ───────────────────────────────────────────────────────────

function resolvePluginDir(): string {
  // Prefer the installed plugin in the user's project over the npx cache
  const installed = path.resolve(process.cwd(), PLUGIN_DIR_NAME);
  if (fs.existsSync(installed)) return installed;
  // Fall back to the source directory (running from the repo itself)
  return path.basename(import.meta.dirname) === "dist"
    ? path.resolve(import.meta.dirname, "..")
    : import.meta.dirname;
}

async function check(): Promise<void> {
  const config = resolveConfig(resolvePluginDir());
  const { main: checkMain } = await import("./check.js");
  const result = await checkMain(config);
  process.exit(result.failed > 0 ? 1 : 0);
}

// ─── Test Command ────────────────────────────────────────────────────────────

async function test(): Promise<void> {
  const config = resolveConfig(resolvePluginDir());
  const { main: testMain } = await import("./smoke-test.js");
  const result = await testMain(config);
  process.exit(result.failed > 0 ? 1 : 0);
}

// ─── Benchmark Command ───────────────────────────────────────────────────────

async function benchmark(): Promise<void> {
  const config = resolveConfig(resolvePluginDir());
  const { main: benchMain } = await import("./benchmark.js");
  await benchMain(config);
}

// ─── Start Command ───────────────────────────────────────────────────────────

async function start(): Promise<void> {
  await import("./server.js");
}

// ─── CLI Dispatch ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith("-"));
const yes = args.includes("--yes") || args.includes("-y");
const help = args.includes("--help") || args.includes("-h");

// Clear npx download noise (warnings, "Ok to proceed?" prompt)
process.stdout.write("\x1Bc");

if (help || !command) {
  console.log(HELP);
  process.exit(0);
}

switch (command) {
  case "setup":
    setup(yes).catch((err) => {
      console.error("Fatal:", err);
      process.exit(1);
    });
    break;
  case "remove":
    remove(yes).catch((err) => {
      console.error("Fatal:", err);
      process.exit(1);
    });
    break;
  case "check":
    check().catch((err) => {
      console.error("Fatal:", err);
      process.exit(1);
    });
    break;
  case "test":
    test().catch((err) => {
      console.error("Fatal:", err);
      process.exit(1);
    });
    break;
  case "bench":
  case "benchmark":
    benchmark().catch((err) => {
      console.error("Fatal:", err);
      process.exit(1);
    });
    break;
  case "start":
    start().catch((err) => {
      console.error("Fatal:", err);
      process.exit(1);
    });
    break;
  default:
    console.log(`Unknown command: ${command}`);
    console.log("");
    console.log(HELP);
    process.exit(1);
}
