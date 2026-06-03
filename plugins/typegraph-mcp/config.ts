/**
 * Shared configuration for typegraph-mcp.
 *
 * Extracts the project root detection logic used by server.ts, check.ts,
 * and smoke-test.ts into a single module.
 */

import * as path from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TypegraphConfig {
  /** Absolute path to the target project root */
  projectRoot: string;
  /** Relative tsconfig path (e.g. "./tsconfig.json") */
  tsconfigPath: string;
  /** Absolute path to the typegraph-mcp tool directory */
  toolDir: string;
  /** Whether typegraph-mcp is embedded inside the project (e.g. plugins/typegraph-mcp/) */
  toolIsEmbedded: boolean;
  /** Path to tool dir — relative to projectRoot if embedded, else absolute */
  toolRelPath: string;
}

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * Resolve typegraph-mcp configuration from the tool directory location.
 *
 * Project root detection (three-level fallback):
 *   1. TYPEGRAPH_PROJECT_ROOT env var (explicit override)
 *   2. If toolDir is inside a `plugins/` directory, go up two levels
 *   3. Otherwise, use cwd (standalone deployment, run from target project)
 */
export function resolveConfig(toolDir: string): TypegraphConfig {
  const cwd = process.cwd();

  const projectRoot = process.env["TYPEGRAPH_PROJECT_ROOT"]
    ? path.resolve(cwd, process.env["TYPEGRAPH_PROJECT_ROOT"])
    : path.basename(path.dirname(toolDir)) === "plugins"
      ? path.resolve(toolDir, "../..")
      : cwd;

  const tsconfigPath = process.env["TYPEGRAPH_TSCONFIG"] || "./tsconfig.json";

  const toolIsEmbedded = toolDir.startsWith(projectRoot + path.sep);
  const toolRelPath = toolIsEmbedded ? path.relative(projectRoot, toolDir) : toolDir;

  return { projectRoot, tsconfigPath, toolDir, toolIsEmbedded, toolRelPath };
}
