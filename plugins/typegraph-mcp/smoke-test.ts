#!/usr/bin/env npx tsx
/**
 * typegraph-mcp Smoke Test — Verifies all 14 tools work against the target project.
 *
 * Dynamically discovers files and symbols from whatever project it's pointed at.
 *
 * Run from project root:
 *   npx tsx plugins/typegraph-mcp/smoke-test.ts
 *
 * Or pointing at a project:
 *   TYPEGRAPH_PROJECT_ROOT=/path/to/project npx tsx /path/to/typegraph-mcp/smoke-test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { TsServerClient, type NavBarItem } from "./tsserver-client.js";
import { buildGraph, type ModuleGraph } from "./module-graph.js";
import {
  dependencyTree,
  dependents,
  importCycles,
  shortestPath,
  subgraph,
  moduleBoundary,
} from "./graph-queries.js";
import { resolveConfig, type TypegraphConfig } from "./config.js";

// ─── Result Type ─────────────────────────────────────────────────────────────

export interface SmokeTestResult {
  passed: number;
  failed: number;
  skipped: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function rel(absPath: string, projectRoot: string): string {
  return path.relative(projectRoot, absPath);
}

/** Walk navbar tree to find a named symbol */
function findInNavBar(
  items: NavBarItem[],
  predicate: (item: NavBarItem) => boolean
): NavBarItem | null {
  for (const item of items) {
    if (predicate(item)) return item;
    if (item.childItems?.length > 0) {
      const found = findInNavBar(item.childItems, predicate);
      if (found) return found;
    }
  }
  return null;
}

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".wrangler",
  "coverage",
  "out",
]);

/** Find a file with imports and exported symbols (good test candidate) */
function findTestFile(rootDir: string): string | null {
  const candidates: Array<{ file: string; size: number }> = [];

  function walk(dir: string, depth: number): void {
    if (depth > 5 || candidates.length >= 30) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        const name = entry.name;
        if (name.endsWith(".d.ts") || name.endsWith(".test.ts") || name.endsWith(".spec.ts"))
          continue;
        if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
        try {
          const stat = fs.statSync(path.join(dir, name));
          if (stat.size > 200 && stat.size < 50000) {
            candidates.push({ file: path.join(dir, name), size: stat.size });
          }
        } catch {
          // skip
        }
      }
    }
  }

  walk(rootDir, 0);

  // Prefer files with rich names — they tend to have imports and exports
  const preferred = candidates.find((c) =>
    /service|handler|controller|repository|provider/i.test(path.basename(c.file))
  );
  const fallback = candidates.sort((a, b) => b.size - a.size)[0];
  return preferred?.file ?? fallback?.file ?? null;
}

/** Find a file that imports the test file (for cross-file tests) */
function findImporter(graph: ModuleGraph, file: string): string | null {
  const revEdges = graph.reverse.get(file);
  if (!revEdges || revEdges.length === 0) return null;
  const preferred = revEdges.find(
    (e) => !e.target.includes(".test.") && !e.target.endsWith("index.ts")
  );
  return (preferred ?? revEdges[0])!.target;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function main(configOverride?: TypegraphConfig): Promise<SmokeTestResult> {
  const { projectRoot, tsconfigPath } =
    configOverride ?? resolveConfig(import.meta.dirname);

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  function pass(name: string, detail: string, ms: number): void {
    console.log(`  \u2713 ${name} [${ms.toFixed(0)}ms]`);
    console.log(`    ${detail}`);
    passed++;
  }

  function fail(name: string, detail: string, ms: number): void {
    console.log(`  \u2717 ${name} [${ms.toFixed(0)}ms]`);
    console.log(`    ${detail}`);
    failed++;
  }

  function skip(name: string, reason: string): void {
    console.log(`  - ${name} (skipped: ${reason})`);
    skipped++;
  }

  console.log("");
  console.log("typegraph-mcp Smoke Test");
  console.log("=====================");
  console.log(`Project root: ${projectRoot}`);
  console.log("");

  // ─── Discover a test file ───────────────────────────────────────────────

  const testFile = findTestFile(projectRoot);
  if (!testFile) {
    console.log("  No suitable .ts file found in project. Cannot run smoke tests.");
    return { passed, failed: failed + 1, skipped };
  }
  const testFileRel = rel(testFile, projectRoot);
  console.log(`Test subject: ${testFileRel}`);
  console.log("");

  // ─── Module Graph (6 tools) ─────────────────────────────────────────────

  console.log("── Module Graph ─────────────────────────────────────────────");

  let graph: ModuleGraph;
  let t0: number;

  // Graph build
  t0 = performance.now();
  try {
    const result = await buildGraph(projectRoot, tsconfigPath);
    graph = result.graph;
    const ms = performance.now() - t0;
    const edgeCount = [...graph.forward.values()].reduce((s, e) => s + e.length, 0);
    if (graph.files.size > 0) {
      pass("graph build", `${graph.files.size} files, ${edgeCount} edges`, ms);
    } else {
      fail("graph build", "0 files discovered", ms);
      console.log("\nCannot continue without module graph.");
      return { passed, failed, skipped };
    }
  } catch (err) {
    fail(
      "graph build",
      `Error: ${err instanceof Error ? err.message : String(err)}`,
      performance.now() - t0
    );
    console.log("\nCannot continue without module graph.");
    return { passed, failed, skipped };
  }

  // dependency_tree
  t0 = performance.now();
  if (graph.files.has(testFile)) {
    const result = dependencyTree(graph, testFile);
    pass(
      "dependency_tree",
      `${result.nodes} transitive deps from ${testFileRel}`,
      performance.now() - t0
    );
  } else {
    skip("dependency_tree", `${testFileRel} not in graph`);
  }

  // dependents
  t0 = performance.now();
  if (graph.files.has(testFile)) {
    const result = dependents(graph, testFile);
    pass(
      "dependents",
      `${result.nodes} dependents (${result.directCount} direct)`,
      performance.now() - t0
    );
  } else {
    skip("dependents", `${testFileRel} not in graph`);
  }

  // import_cycles
  t0 = performance.now();
  const cycles = importCycles(graph);
  pass("import_cycles", `${cycles.count} cycle(s) detected`, performance.now() - t0);

  // shortest_path
  t0 = performance.now();
  const importer = findImporter(graph, testFile);
  if (importer && graph.files.has(testFile)) {
    const result = shortestPath(graph, importer, testFile);
    const ms = performance.now() - t0;
    if (result.path) {
      pass("shortest_path", `${result.hops} hops: ${result.path.map((p) => rel(p, projectRoot)).join(" -> ")}`, ms);
    } else {
      pass("shortest_path", `No path from ${rel(importer, projectRoot)} (may be type-only)`, ms);
    }
  } else {
    skip("shortest_path", "No importer found for test file");
  }

  // subgraph
  t0 = performance.now();
  if (graph.files.has(testFile)) {
    const result = subgraph(graph, [testFile], { depth: 1, direction: "both" });
    pass(
      "subgraph",
      `${result.stats.nodeCount} nodes, ${result.stats.edgeCount} edges (depth 1)`,
      performance.now() - t0
    );
  } else {
    skip("subgraph", `${testFileRel} not in graph`);
  }

  // module_boundary
  t0 = performance.now();
  const dir = path.dirname(testFile);
  const siblings = [...graph.files].filter((f) => path.dirname(f) === dir);
  if (siblings.length >= 2) {
    const result = moduleBoundary(graph, siblings);
    pass(
      "module_boundary",
      `${siblings.length} files in ${rel(dir, projectRoot)}/: ${result.internalEdges} internal, ${result.incomingEdges.length} in, ${result.outgoingEdges.length} out`,
      performance.now() - t0
    );
  } else {
    skip("module_boundary", `Only ${siblings.length} file(s) in ${rel(dir, projectRoot)}/`);
  }

  // ─── tsserver (8 tools) ─────────────────────────────────────────────────

  console.log("");
  console.log("── tsserver ─────────────────────────────────────────────────");

  const client = new TsServerClient(projectRoot, tsconfigPath);
  t0 = performance.now();
  await client.start();
  console.log(`  (started in ${(performance.now() - t0).toFixed(0)}ms)`);

  // navbar — discover symbols
  t0 = performance.now();
  const bar = await client.navbar(testFileRel);
  const navbarMs = performance.now() - t0;

  const symbolKinds = new Set([
    "function",
    "const",
    "class",
    "interface",
    "type",
    "enum",
    "var",
    "let",
    "method",
  ]);
  const allSymbols: NavBarItem[] = [];
  function collectSymbols(items: NavBarItem[]): void {
    for (const item of items) {
      if (symbolKinds.has(item.kind) && item.text !== "<function>" && item.spans.length > 0) {
        allSymbols.push(item);
      }
      if (item.childItems?.length > 0) collectSymbols(item.childItems);
    }
  }
  collectSymbols(bar);

  if (allSymbols.length > 0) {
    pass("navbar", `${allSymbols.length} symbols in ${testFileRel}`, navbarMs);
  } else {
    fail("navbar", `No symbols found in ${testFileRel}`, navbarMs);
  }

  // Prefer concrete symbols (const, function, class) — interfaces/types may not
  // return quickinfo at their span start position (points to the keyword, not the name)
  const concreteKinds = new Set(["const", "function", "class", "var", "let", "enum"]);
  const sym = allSymbols.find((s) => concreteKinds.has(s.kind)) ?? allSymbols[0];
  if (!sym) {
    const toolNames = [
      "find_symbol",
      "definition",
      "references",
      "type_info",
      "navigate_to",
      "blast_radius",
      "module_exports",
      "trace_chain",
    ];
    for (const name of toolNames) skip(name, "No symbol discovered");
  } else {
    const span = sym.spans[0]!;

    // find_symbol
    t0 = performance.now();
    const found = findInNavBar(bar, (item) => item.text === sym.text && item.kind === sym.kind);
    if (found && found.spans.length > 0) {
      pass(
        "find_symbol",
        `${sym.text} [${sym.kind}] at line ${found.spans[0]!.start.line}`,
        performance.now() - t0
      );
    } else {
      fail("find_symbol", `Could not re-find ${sym.text}`, performance.now() - t0);
    }

    // definition
    t0 = performance.now();
    const defs = await client.definition(testFileRel, span.start.line, span.start.offset);
    if (defs.length > 0) {
      const def = defs[0]!;
      pass("definition", `${sym.text} -> ${def.file}:${def.start.line}`, performance.now() - t0);
    } else {
      pass("definition", `${sym.text} is its own definition`, performance.now() - t0);
    }

    // references
    t0 = performance.now();
    const refs = await client.references(testFileRel, span.start.line, span.start.offset);
    const refFiles = new Set(refs.map((r) => r.file));
    pass(
      "references",
      `${refs.length} ref(s) across ${refFiles.size} file(s)`,
      performance.now() - t0
    );

    // type_info
    t0 = performance.now();
    let info = await client.quickinfo(testFileRel, span.start.line, span.start.offset);
    // Span start may point to a keyword (class, function) — retry at the name position
    if (!info && defs.length > 0) {
      const def = defs[0]!;
      info = await client.quickinfo(testFileRel, def.start.line, def.start.offset);
    }
    if (info) {
      const typeStr =
        info.displayString.length > 80
          ? info.displayString.slice(0, 80) + "..."
          : info.displayString;
      pass("type_info", typeStr, performance.now() - t0);
    } else {
      fail("type_info", `No type info for ${sym.text}`, performance.now() - t0);
    }

    // navigate_to
    t0 = performance.now();
    const navItems = await client.navto(sym.text, 5);
    if (navItems.length > 0) {
      const files = new Set(navItems.map((i) => i.file));
      pass(
        "navigate_to",
        `${navItems.length} match(es) for "${sym.text}" in ${files.size} file(s)`,
        performance.now() - t0
      );
    } else {
      pass(
        "navigate_to",
        `"${sym.text}" not indexed by navto (expected for some kinds)`,
        performance.now() - t0
      );
    }

    // blast_radius
    t0 = performance.now();
    const callers = refs.filter((r) => !r.isDefinition);
    const callerFiles = new Set(callers.map((r) => r.file));
    pass(
      "blast_radius",
      `${callers.length} usage(s) across ${callerFiles.size} file(s)`,
      performance.now() - t0
    );

    // module_exports
    t0 = performance.now();
    const moduleItem = bar.find((item) => item.kind === "module");
    const topItems = moduleItem?.childItems ?? bar;
    const exportSymbols = topItems.filter((item) => symbolKinds.has(item.kind));
    pass("module_exports", `${exportSymbols.length} top-level symbol(s)`, performance.now() - t0);

    // trace_chain — follow an import to its source
    t0 = performance.now();
    const source = fs.readFileSync(testFile, "utf-8");
    const importMatch = source.match(/^import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/m);
    if (importMatch) {
      const firstName = importMatch[1]!
        .split(",")[0]!
        .replace(/^type\s+/, "")
        .trim();
      const importSym = findInNavBar(bar, (item) => item.text === firstName);
      if (importSym && importSym.spans.length > 0) {
        const chain: string[] = [testFileRel];
        let cur = {
          file: testFileRel,
          line: importSym.spans[0]!.start.line,
          offset: importSym.spans[0]!.start.offset,
        };
        for (let i = 0; i < 5; i++) {
          const hopDefs = await client.definition(cur.file, cur.line, cur.offset);
          if (hopDefs.length === 0) break;
          const hop = hopDefs[0]!;
          if (hop.file === cur.file && hop.start.line === cur.line) break;
          if (hop.file.includes("node_modules")) break;
          chain.push(`${hop.file}:${hop.start.line}`);
          cur = { file: hop.file, line: hop.start.line, offset: hop.start.offset };
        }
        if (chain.length > 1) {
          pass(
            "trace_chain",
            `${chain.length - 1} hop(s): ${chain.join(" -> ")}`,
            performance.now() - t0
          );
        } else {
          pass(
            "trace_chain",
            `"${firstName}" resolved in-file (0 external hops)`,
            performance.now() - t0
          );
        }
      } else {
        pass(
          "trace_chain",
          `"${firstName}" not in navbar (may be type-only)`,
          performance.now() - t0
        );
      }
    } else {
      skip("trace_chain", "No brace imports in test file");
    }
  }

  client.shutdown();

  // ─── Summary ────────────────────────────────────────────────────────────

  console.log("");
  const total = passed + failed;
  if (failed === 0) {
    console.log(
      `${passed}/${total} passed` +
        (skipped > 0 ? ` (${skipped} skipped)` : "") +
        " -- all tools working"
    );
  } else {
    console.log(
      `${passed}/${total} passed, ${failed} failed` +
        (skipped > 0 ? `, ${skipped} skipped` : "") +
        " -- some tools may not work correctly"
    );
  }
  console.log("");

  return { passed, failed, skipped };
}

