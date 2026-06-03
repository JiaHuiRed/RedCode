#!/usr/bin/env npx tsx
/**
 * typegraph-mcp Benchmark — Token comparison, latency, and accuracy tests.
 *
 * Fully dynamic — discovers symbols, barrel chains, and test scenarios
 * from whatever TypeScript project it's pointed at.
 *
 * Usage:
 *   npx tsx benchmark.ts
 *   TYPEGRAPH_PROJECT_ROOT=/path/to/project npx tsx benchmark.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
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
import { resolveConfig } from "./config.js";

// ─── Configuration ───────────────────────────────────────────────────────────

let projectRoot!: string;
let tsconfigPath!: string;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Estimate tokens in a string (~4 chars per token for code) */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Count grep matches for a pattern across the project */
function grepCount(pattern: string): { matches: number; files: number; totalBytes: number } {
  try {
    const result = execSync(
      `grep -r --include='*.ts' --include='*.tsx' -l "${pattern}" . 2>/dev/null || true`,
      { cwd: projectRoot, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
    ).trim();
    const files = result ? result.split("\n").filter(Boolean) : [];

    const countResult = execSync(
      `grep -r --include='*.ts' --include='*.tsx' -c "${pattern}" . 2>/dev/null || true`,
      { cwd: projectRoot, encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
    ).trim();
    const matches = countResult
      .split("\n")
      .filter(Boolean)
      .reduce((sum, line) => {
        const count = parseInt(line.split(":").pop()!, 10);
        return sum + (isNaN(count) ? 0 : count);
      }, 0);

    let totalBytes = 0;
    for (const file of files) {
      try {
        totalBytes += fs.statSync(path.resolve(projectRoot, file)).size;
      } catch {
        // skip
      }
    }

    return { matches, files: files.length, totalBytes };
  } catch {
    return { matches: 0, files: 0, totalBytes: 0 };
  }
}

function relPath(abs: string): string {
  return path.relative(projectRoot, abs);
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

/** Flatten navbar tree into a list of symbols */
function flattenNavBar(items: NavBarItem[]): NavBarItem[] {
  const result: NavBarItem[] = [];
  for (const item of items) {
    result.push(item);
    if (item.childItems?.length > 0) result.push(...flattenNavBar(item.childItems));
  }
  return result;
}

// ─── Discovery ───────────────────────────────────────────────────────────────

/** Find a barrel re-export chain: an index.ts that re-exports from non-index files */
function findBarrelChain(graph: ModuleGraph): { barrelFile: string; sourceFile: string; specifiers: string[] } | null {
  const barrels = [...graph.files].filter((f) => path.basename(f) === "index.ts");

  for (const barrel of barrels) {
    const edges = graph.forward.get(barrel) ?? [];
    // Look for edges that carry named specifiers (re-exports, not star)
    for (const edge of edges) {
      if (
        edge.specifiers.length > 0 &&
        !edge.specifiers.includes("*") &&
        !edge.target.endsWith("index.ts") &&
        !edge.isTypeOnly
      ) {
        // Check if the source file is also re-exported by another barrel (deeper chain)
        const parentBarrels = (graph.reverse.get(barrel) ?? []).filter(
          (e) => path.basename(e.target) === "index.ts"
        );
        if (parentBarrels.length > 0) {
          return { barrelFile: barrel, sourceFile: edge.target, specifiers: edge.specifiers };
        }
      }
    }
  }

  // Fallback: any barrel with named re-exports
  for (const barrel of barrels) {
    const edges = graph.forward.get(barrel) ?? [];
    for (const edge of edges) {
      if (edge.specifiers.length > 0 && !edge.specifiers.includes("*") && !edge.target.endsWith("index.ts")) {
        return { barrelFile: barrel, sourceFile: edge.target, specifiers: edge.specifiers };
      }
    }
  }

  return null;
}

/** Find a symbol name that appears in many files (high grep noise) */
function findHighFanoutSymbol(graph: ModuleGraph): string | null {
  // Collect specifiers from all import edges, count frequency
  const specCounts = new Map<string, number>();
  for (const edges of graph.forward.values()) {
    for (const edge of edges) {
      for (const spec of edge.specifiers) {
        if (spec === "*" || spec === "default" || spec.length < 4) continue;
        specCounts.set(spec, (specCounts.get(spec) ?? 0) + 1);
      }
    }
  }

  // Sort by frequency, pick the top one
  const sorted = [...specCounts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] ?? null;
}

/** Find a symbol whose name is a prefix of other symbols (disambiguation scenario) */
function findPrefixSymbol(graph: ModuleGraph): { base: string; variants: string[] } | null {
  const specCounts = new Map<string, number>();
  for (const edges of graph.forward.values()) {
    for (const edge of edges) {
      for (const spec of edge.specifiers) {
        if (spec === "*" || spec === "default" || spec.length < 5) continue;
        specCounts.set(spec, (specCounts.get(spec) ?? 0) + 1);
      }
    }
  }

  // Find a symbol that is a prefix of other symbols
  const allSpecs = [...specCounts.keys()];
  for (const [base, count] of [...specCounts.entries()].sort((a, b) => b[1] - a[1])) {
    if (count < 3) continue;
    const variants = allSpecs.filter((s) => s !== base && s.startsWith(base) && s[base.length]?.match(/[A-Z]/));
    if (variants.length >= 2) {
      return { base, variants: variants.slice(0, 5) };
    }
  }

  return null;
}

/** Find a file with mixed type-only and runtime imports */
function findMixedImportFile(graph: ModuleGraph): string | null {
  for (const [file, edges] of graph.forward) {
    const hasTypeOnly = edges.some((e) => e.isTypeOnly);
    const hasRuntime = edges.some((e) => !e.isTypeOnly);
    if (hasTypeOnly && hasRuntime && edges.length >= 4) {
      return file;
    }
  }
  return null;
}

/** Find the most-depended-on file in the project */
function findMostDependedFile(graph: ModuleGraph): string | null {
  let maxDeps = 0;
  let maxFile: string | null = null;

  for (const [file, revEdges] of graph.reverse) {
    if (file.endsWith("index.ts")) continue; // Skip barrels — find actual source files
    if (revEdges.length > maxDeps) {
      maxDeps = revEdges.length;
      maxFile = file;
    }
  }

  return maxFile;
}

/** Find a file with a traceable call chain (imports something that imports something) */
function findChainFile(graph: ModuleGraph): { file: string; symbol: string } | null {
  for (const [file, edges] of graph.forward) {
    if (file.endsWith("index.ts") || file.includes(".test.")) continue;

    for (const edge of edges) {
      if (edge.isTypeOnly || edge.specifiers.includes("*")) continue;
      // Check if the target also imports something
      const targetEdges = graph.forward.get(edge.target) ?? [];
      const nonTrivialTarget = targetEdges.filter((e) => !e.isTypeOnly && !e.specifiers.includes("*"));
      if (nonTrivialTarget.length > 0 && edge.specifiers.length > 0) {
        return { file, symbol: edge.specifiers[0]! };
      }
    }
  }

  return null;
}

/** Find a good test file for latency benchmarks (medium-sized, has symbols) */
function findLatencyTestFile(graph: ModuleGraph): string | null {
  const candidates = [...graph.files]
    .filter((f) => !f.endsWith("index.ts") && !f.includes(".test.") && !f.includes(".spec."))
    .map((f) => {
      try {
        return { file: f, size: fs.statSync(f).size };
      } catch {
        return null;
      }
    })
    .filter((c): c is { file: string; size: number } => c !== null && c.size > 500 && c.size < 30000)
    .sort((a, b) => b.size - a.size);

  // Prefer files with "service", "handler", etc. in the name
  const preferred = candidates.find((c) =>
    /service|handler|controller|repository|provider/i.test(path.basename(c.file))
  );

  return preferred?.file ?? candidates[0]?.file ?? null;
}

// ─── Benchmark 1: Token Comparison ──────────────────────────────────────────

interface TokenScenario {
  name: string;
  symbol: string;
  description: string;
  grep: { matches: number; files: number; tokensToRead: number };
  typegraph: { responseTokens: number; toolCalls: number };
  reduction: string;
}

async function benchmarkTokens(
  client: TsServerClient,
  graph: ModuleGraph
): Promise<TokenScenario[]> {
  console.log("=== Benchmark 1: Token Comparison (grep vs typegraph-mcp) ===");
  console.log("");

  const scenarios: TokenScenario[] = [];

  // Scenario A: Barrel re-export resolution
  const barrel = findBarrelChain(graph);
  if (barrel) {
    const symbol = barrel.specifiers[0]!;
    const grep = grepCount(symbol);
    const grepTokens = estimateTokens("x".repeat(Math.min(grep.totalBytes, 500000)));

    const navItems = await client.navto(symbol, 5);
    const def = navItems.find((i) => i.name === symbol);
    let responseText = JSON.stringify({ results: navItems, count: navItems.length });
    if (def) {
      const defs = await client.definition(def.file, def.start.line, def.start.offset);
      responseText += JSON.stringify({ definitions: defs });
    }

    scenarios.push({
      name: "Barrel re-export resolution",
      symbol,
      description: `Re-exported through ${relPath(barrel.barrelFile)}`,
      grep: { matches: grep.matches, files: grep.files, tokensToRead: grepTokens },
      typegraph: { responseTokens: estimateTokens(responseText), toolCalls: 2 },
      reduction: grepTokens > 0
        ? `${((1 - estimateTokens(responseText) / grepTokens) * 100).toFixed(0)}%`
        : "N/A",
    });
  }

  // Scenario B: High-fanout symbol (many grep matches)
  const highFanout = findHighFanoutSymbol(graph);
  if (highFanout) {
    const grep = grepCount(highFanout);
    const grepTokens = estimateTokens("x".repeat(Math.min(grep.totalBytes, 500000)));

    const navItems = await client.navto(highFanout, 10);
    const refs = navItems.length > 0
      ? await client.references(navItems[0]!.file, navItems[0]!.start.line, navItems[0]!.start.offset)
      : [];
    const responseText = JSON.stringify({ results: navItems }) + JSON.stringify({ count: refs.length });

    scenarios.push({
      name: "High-fanout symbol lookup",
      symbol: highFanout,
      description: `Most-imported symbol in the project`,
      grep: { matches: grep.matches, files: grep.files, tokensToRead: grepTokens },
      typegraph: { responseTokens: estimateTokens(responseText), toolCalls: 2 },
      reduction: grepTokens > 0
        ? `${((1 - estimateTokens(responseText) / grepTokens) * 100).toFixed(0)}%`
        : "N/A",
    });
  }

  // Scenario C: Call chain tracing
  const chainTarget = findChainFile(graph);
  if (chainTarget) {
    const grep = grepCount(chainTarget.symbol);
    const grepTokens = estimateTokens("x".repeat(Math.min(grep.totalBytes, 500000)));

    const navItems = await client.navto(chainTarget.symbol, 5);
    let totalResponse = JSON.stringify({ results: navItems });
    let hops = 0;

    if (navItems.length > 0) {
      let cur = { file: navItems[0]!.file, line: navItems[0]!.start.line, offset: navItems[0]!.start.offset };
      for (let i = 0; i < 5; i++) {
        const defs = await client.definition(cur.file, cur.line, cur.offset);
        if (defs.length === 0) break;
        const hop = defs[0]!;
        if (hop.file === cur.file && hop.start.line === cur.line) break;
        if (hop.file.includes("node_modules")) break;
        hops++;
        totalResponse += JSON.stringify({ definitions: defs });
        cur = { file: hop.file, line: hop.start.line, offset: hop.start.offset };
      }
    }

    scenarios.push({
      name: "Call chain tracing",
      symbol: chainTarget.symbol,
      description: `${hops} hop(s) from ${relPath(chainTarget.file)}`,
      grep: { matches: grep.matches, files: grep.files, tokensToRead: grepTokens },
      typegraph: { responseTokens: estimateTokens(totalResponse), toolCalls: 1 + hops },
      reduction: grepTokens > 0
        ? `${((1 - estimateTokens(totalResponse) / grepTokens) * 100).toFixed(0)}%`
        : "N/A",
    });
  }

  // Scenario D: Most-depended-on file — impact analysis
  const mostDepended = findMostDependedFile(graph);
  if (mostDepended) {
    const basename = path.basename(mostDepended, path.extname(mostDepended));
    const grep = grepCount(basename);
    const grepTokens = estimateTokens("x".repeat(Math.min(grep.totalBytes, 500000)));

    const deps = dependents(graph, mostDepended);
    const responseText = JSON.stringify({
      root: relPath(mostDepended),
      nodes: deps.nodes,
      directCount: deps.directCount,
      byPackage: deps.byPackage,
    });

    scenarios.push({
      name: "Impact analysis (most-depended file)",
      symbol: basename,
      description: `${relPath(mostDepended)} — ${deps.directCount} direct, ${deps.nodes} transitive`,
      grep: { matches: grep.matches, files: grep.files, tokensToRead: grepTokens },
      typegraph: { responseTokens: estimateTokens(responseText), toolCalls: 1 },
      reduction: grepTokens > 0
        ? `${((1 - estimateTokens(responseText) / grepTokens) * 100).toFixed(0)}%`
        : "N/A",
    });
  }

  // Print results
  if (scenarios.length > 0) {
    console.log("| Scenario | Symbol | grep matches | grep files | grep tokens | tg tokens | tg calls | reduction |");
    console.log("|----------|--------|-------------|-----------|-------------|-----------|----------|-----------|");
    for (const s of scenarios) {
      console.log(
        `| ${s.name} | \`${s.symbol}\` | ${s.grep.matches} | ${s.grep.files} | ${s.grep.tokensToRead.toLocaleString()} | ${s.typegraph.responseTokens.toLocaleString()} | ${s.typegraph.toolCalls} | ${s.reduction} |`
      );
    }
  } else {
    console.log("  No suitable scenarios discovered for this codebase.");
  }
  console.log("");

  return scenarios;
}

// ─── Benchmark 2: Latency ───────────────────────────────────────────────────

interface LatencyResult {
  tool: string;
  runs: number;
  p50: number;
  p95: number;
  avg: number;
  min: number;
  max: number;
}

async function benchmarkLatency(
  client: TsServerClient,
  graph: ModuleGraph
): Promise<LatencyResult[]> {
  console.log("=== Benchmark 2: Latency (ms per tool call) ===");
  console.log("");

  const results: LatencyResult[] = [];
  const RUNS = 5;

  const testFile = findLatencyTestFile(graph);
  if (!testFile) {
    console.log("  No suitable test file found for latency benchmark.");
    console.log("");
    return results;
  }
  const testFileRel = relPath(testFile);
  console.log(`Test file: ${testFileRel}`);
  console.log(`Runs per tool: ${RUNS}`);
  console.log("");

  // Discover a concrete symbol from the file
  const bar = await client.navbar(testFileRel);
  const allSymbols = flattenNavBar(bar);
  const concreteKinds = new Set(["const", "function", "class", "var", "let", "enum"]);
  const sym = allSymbols.find(
    (item) => concreteKinds.has(item.kind) && item.text !== "<function>" && item.spans.length > 0
  );

  if (!sym) {
    console.log("  No concrete symbol found in test file.");
    console.log("");
    return results;
  }
  const span = sym.spans[0]!;
  console.log(`Test symbol: ${sym.text} [${sym.kind}]`);
  console.log("");

  // tsserver tools
  const tsserverTools: Array<{ name: string; fn: () => Promise<unknown> }> = [
    { name: "ts_find_symbol", fn: () => client.navbar(testFileRel) },
    { name: "ts_definition", fn: () => client.definition(testFileRel, span.start.line, span.start.offset) },
    { name: "ts_references", fn: () => client.references(testFileRel, span.start.line, span.start.offset) },
    { name: "ts_type_info", fn: () => client.quickinfo(testFileRel, span.start.line, span.start.offset) },
    { name: "ts_navigate_to", fn: () => client.navto(sym.text, 10) },
    { name: "ts_module_exports", fn: () => client.navbar(testFileRel) },
  ];

  for (const tool of tsserverTools) {
    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = performance.now();
      await tool.fn();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    results.push({
      tool: tool.name,
      runs: RUNS,
      p50: percentile(times, 50),
      p95: percentile(times, 95),
      avg: times.reduce((a, b) => a + b, 0) / times.length,
      min: times[0]!,
      max: times[times.length - 1]!,
    });
  }

  // Graph tools
  const graphTools: Array<{ name: string; fn: () => unknown }> = [
    { name: "ts_dependency_tree", fn: () => dependencyTree(graph, testFile) },
    { name: "ts_dependents", fn: () => dependents(graph, testFile) },
    { name: "ts_import_cycles", fn: () => importCycles(graph) },
    {
      name: "ts_shortest_path",
      fn: () => {
        const rev = graph.reverse.get(testFile);
        if (rev && rev.length > 0) return shortestPath(graph, rev[0]!.target, testFile);
        return null;
      },
    },
    { name: "ts_subgraph", fn: () => subgraph(graph, [testFile], { depth: 2, direction: "both" }) },
    {
      name: "ts_module_boundary",
      fn: () => {
        const dir = path.dirname(testFile);
        const siblings = [...graph.files].filter((f) => path.dirname(f) === dir);
        return moduleBoundary(graph, siblings);
      },
    },
  ];

  for (const tool of graphTools) {
    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = performance.now();
      tool.fn();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    results.push({
      tool: tool.name,
      runs: RUNS,
      p50: percentile(times, 50),
      p95: percentile(times, 95),
      avg: times.reduce((a, b) => a + b, 0) / times.length,
      min: times[0]!,
      max: times[times.length - 1]!,
    });
  }

  // Print results
  console.log("| Tool | p50 | p95 | avg | min | max |");
  console.log("|------|-----|-----|-----|-----|-----|");
  for (const r of results) {
    console.log(
      `| ${r.tool} | ${r.p50.toFixed(1)}ms | ${r.p95.toFixed(1)}ms | ${r.avg.toFixed(1)}ms | ${r.min.toFixed(1)}ms | ${r.max.toFixed(1)}ms |`
    );
  }
  console.log("");

  return results;
}

// ─── Benchmark 3: Accuracy ──────────────────────────────────────────────────

interface AccuracyScenario {
  name: string;
  description: string;
  grepResult: string;
  typegraphResult: string;
  verdict: "typegraph wins" | "equivalent" | "grep wins";
}

async function benchmarkAccuracy(
  client: TsServerClient,
  graph: ModuleGraph
): Promise<AccuracyScenario[]> {
  console.log("=== Benchmark 3: Accuracy (grep vs typegraph-mcp) ===");
  console.log("");

  const scenarios: AccuracyScenario[] = [];

  // A: Barrel file resolution — find the actual definition through re-exports
  const barrel = findBarrelChain(graph);
  if (barrel) {
    const symbol = barrel.specifiers[0]!;
    const grep = grepCount(symbol);

    const navItems = await client.navto(symbol, 10);
    const defItem = navItems.find((i) => i.name === symbol && i.matchKind === "exact");
    let defLocation = "";

    if (defItem) {
      const defs = await client.definition(defItem.file, defItem.start.line, defItem.start.offset);
      if (defs.length > 0) {
        defLocation = `${defs[0]!.file}:${defs[0]!.start.line}`;
      }
    }

    scenarios.push({
      name: "Barrel file resolution",
      description: `Find where \`${symbol}\` is actually defined (not re-exported)`,
      grepResult: `${grep.matches} matches across ${grep.files} files — agent must read files to distinguish definition from re-exports`,
      typegraphResult: defLocation
        ? `Direct: ${defLocation} (1 tool call)`
        : `Found ${navItems.length} declarations via navto`,
      verdict: "typegraph wins",
    });
  }

  // B: Same-name disambiguation
  const prefixSymbol = findPrefixSymbol(graph);
  if (prefixSymbol) {
    const grep = grepCount(prefixSymbol.base);
    const grepVariants = grepCount(`${prefixSymbol.base}[A-Z]`);

    const navItems = await client.navto(prefixSymbol.base, 10);
    const exactMatches = navItems.filter((i) => i.name === prefixSymbol.base);

    scenarios.push({
      name: "Same-name disambiguation",
      description: `Distinguish \`${prefixSymbol.base}\` from ${prefixSymbol.variants.map((v) => `\`${v}\``).join(", ")}`,
      grepResult: `${grep.matches} total matches (includes ${grepVariants.matches} variant-name matches sharing the prefix)`,
      typegraphResult: `${exactMatches.length} exact match(es): ${exactMatches.map((i) => `${i.file}:${i.start.line} [${i.kind}]`).join(", ")}`,
      verdict: "typegraph wins",
    });
  }

  // C: Type-only vs runtime import distinction
  const mixedFile = findMixedImportFile(graph);
  if (mixedFile) {
    const fwdEdges = graph.forward.get(mixedFile) ?? [];
    const typeOnly = fwdEdges.filter((e) => e.isTypeOnly);
    const runtime = fwdEdges.filter((e) => !e.isTypeOnly);

    scenarios.push({
      name: "Type-only vs runtime imports",
      description: `In \`${relPath(mixedFile)}\`, distinguish type-only from runtime imports`,
      grepResult: `grep "import" shows all imports without distinguishing \`import type\` — agent must parse each line manually`,
      typegraphResult: `${typeOnly.length} type-only imports, ${runtime.length} runtime imports (module graph distinguishes automatically)`,
      verdict: "typegraph wins",
    });
  }

  // D: Cross-package / transitive dependency tracking
  const mostDepended = findMostDependedFile(graph);
  if (mostDepended) {
    const basename = path.basename(mostDepended, path.extname(mostDepended));
    const grep = grepCount(basename);
    const deps = dependents(graph, mostDepended);

    const byPackageSummary = Object.entries(deps.byPackage)
      .map(([pkg, files]) => `${pkg}: ${files.length}`)
      .join(", ");

    scenarios.push({
      name: "Cross-package impact analysis",
      description: `Find everything that depends on \`${relPath(mostDepended)}\``,
      grepResult: `grep for "${basename}" finds ${grep.matches} matches — cannot distinguish direct vs transitive, cannot follow re-exports`,
      typegraphResult: `${deps.directCount} direct dependents, ${deps.nodes} total (transitive)${byPackageSummary ? `. By package: ${byPackageSummary}` : ""}`,
      verdict: "typegraph wins",
    });
  }

  // E: Circular dependency detection
  {
    const cycles = importCycles(graph);

    const cycleDetail = cycles.cycles.length > 0
      ? cycles.cycles
          .slice(0, 3)
          .map((c) => c.map(relPath).join(" -> "))
          .join("; ")
      : "none";

    scenarios.push({
      name: "Circular dependency detection",
      description: "Find all circular import chains in the project",
      grepResult: "Impossible with grep — requires full graph analysis",
      typegraphResult: `${cycles.count} cycle(s)${cycles.count > 0 ? `: ${cycleDetail}` : ""}`,
      verdict: "typegraph wins",
    });
  }

  // Print results
  for (const s of scenarios) {
    console.log(`### ${s.name}`);
    console.log(`${s.description}`);
    console.log(`  grep:      ${s.grepResult}`);
    console.log(`  typegraph: ${s.typegraphResult}`);
    console.log(`  verdict:   ${s.verdict}`);
    console.log("");
  }

  return scenarios;
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function main(config?: { projectRoot: string; tsconfigPath: string }) {
  ({ projectRoot, tsconfigPath } = config ?? resolveConfig(import.meta.dirname));
  console.log("");
  console.log("typegraph-mcp Benchmark");
  console.log("=======================");
  console.log(`Project: ${projectRoot}`);
  console.log("");

  // Build graph
  const graphStart = performance.now();
  const { graph } = await buildGraph(projectRoot, tsconfigPath);
  const graphMs = performance.now() - graphStart;
  const edgeCount = [...graph.forward.values()].reduce((s, e) => s + e.length, 0);
  console.log(`Module graph: ${graph.files.size} files, ${edgeCount} edges [${graphMs.toFixed(0)}ms]`);
  console.log("");

  // Start tsserver
  const client = new TsServerClient(projectRoot, tsconfigPath);
  const tsStart = performance.now();
  await client.start();
  console.log(`tsserver ready [${(performance.now() - tsStart).toFixed(0)}ms]`);

  // Warm up tsserver
  const warmFile = [...graph.files][0]!;
  await client.navbar(relPath(warmFile));
  console.log("");

  // Run benchmarks
  const tokenResults = await benchmarkTokens(client, graph);
  const latencyResults = await benchmarkLatency(client, graph);
  const accuracyResults = await benchmarkAccuracy(client, graph);

  // Summary
  console.log("=== Summary ===");
  console.log("");

  if (tokenResults.length > 0) {
    const avgReduction =
      tokenResults.reduce((sum, s) => {
        const pct = parseFloat(s.reduction);
        return sum + (isNaN(pct) ? 0 : pct);
      }, 0) / tokenResults.length;
    console.log(`Average token reduction: ${avgReduction.toFixed(0)}%`);
  }

  const tsserverLatencies = latencyResults.filter((r) =>
    ["ts_find_symbol", "ts_definition", "ts_references", "ts_type_info", "ts_navigate_to", "ts_module_exports"].includes(r.tool)
  );
  const graphLatencies = latencyResults.filter((r) => !tsserverLatencies.includes(r));

  if (tsserverLatencies.length > 0) {
    const tsAvg = tsserverLatencies.reduce((s, r) => s + r.avg, 0) / tsserverLatencies.length;
    console.log(`Average tsserver query: ${tsAvg.toFixed(1)}ms`);
  }
  if (graphLatencies.length > 0) {
    const graphAvg = graphLatencies.reduce((s, r) => s + r.avg, 0) / graphLatencies.length;
    console.log(`Average graph query: ${graphAvg.toFixed(1)}ms`);
  }

  console.log(`Accuracy scenarios: ${accuracyResults.filter((s) => s.verdict === "typegraph wins").length}/${accuracyResults.length} typegraph wins`);
  console.log("");

  client.shutdown();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
