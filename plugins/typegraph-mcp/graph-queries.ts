/**
 * Graph Queries — Pure traversal functions for the module import graph.
 *
 * All functions take ModuleGraph as first parameter and are side-effect free.
 * Paths in results are absolute; callers convert to relative for tool output.
 */

import type { ModuleGraph, ImportEdge } from "./module-graph.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function shouldIncludeEdge(edge: ImportEdge, includeTypeOnly: boolean): boolean {
  if (!includeTypeOnly && edge.isTypeOnly) return false;
  return true;
}

// ─── 1. dependencyTree ──────────────────────────────────────────────────────

export interface DepTreeOpts {
  depth?: number; // default: unlimited
  includeTypeOnly?: boolean; // default: false
}

export interface DepTreeResult {
  root: string;
  nodes: number;
  files: string[];
}

/**
 * BFS forward traversal from `file`. Returns transitive dependencies
 * in breadth-first order (direct deps first, then their deps, etc.).
 */
export function dependencyTree(
  graph: ModuleGraph,
  file: string,
  opts: DepTreeOpts = {}
): DepTreeResult {
  const { depth = Infinity, includeTypeOnly = false } = opts;
  const visited = new Set<string>();
  const result: string[] = [];

  // BFS
  let frontier = [file];
  visited.add(file);
  let currentDepth = 0;

  while (frontier.length > 0 && currentDepth < depth) {
    const nextFrontier: string[] = [];
    for (const f of frontier) {
      const edges = graph.forward.get(f) ?? [];
      for (const edge of edges) {
        if (!shouldIncludeEdge(edge, includeTypeOnly)) continue;
        if (visited.has(edge.target)) continue;
        visited.add(edge.target);
        result.push(edge.target);
        nextFrontier.push(edge.target);
      }
    }
    frontier = nextFrontier;
    currentDepth++;
  }

  return { root: file, nodes: result.length, files: result };
}

// ─── 2. dependents ──────────────────────────────────────────────────────────

export interface DependentsOpts {
  depth?: number; // default: unlimited
  includeTypeOnly?: boolean; // default: false
}

export interface DependentsResult {
  root: string;
  nodes: number;
  directCount: number;
  files: string[];
  byPackage: Record<string, string[]>;
}

/** Cache for package.json lookups — maps directory to package name */
const packageNameCache = new Map<string, string>();

function findPackageName(filePath: string): string {
  let dir = path.dirname(filePath);
  while (dir !== path.dirname(dir)) {
    if (packageNameCache.has(dir)) return packageNameCache.get(dir)!;
    const pkgJsonPath = path.join(dir, "package.json");
    try {
      if (fs.existsSync(pkgJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
        const name = pkg.name ?? path.basename(dir);
        packageNameCache.set(dir, name);
        return name;
      }
    } catch {
      // Skip unreadable package.json
    }
    dir = path.dirname(dir);
  }
  return "<root>";
}

/**
 * BFS reverse traversal from `file`. Returns files that (transitively) depend on this file.
 * Groups results by nearest package.json ancestor.
 */
export function dependents(
  graph: ModuleGraph,
  file: string,
  opts: DependentsOpts = {}
): DependentsResult {
  const { depth = Infinity, includeTypeOnly = false } = opts;
  const visited = new Set<string>();
  const result: string[] = [];
  let directCount = 0;

  let frontier = [file];
  visited.add(file);
  let currentDepth = 0;

  while (frontier.length > 0 && currentDepth < depth) {
    const nextFrontier: string[] = [];
    for (const f of frontier) {
      const edges = graph.reverse.get(f) ?? [];
      for (const edge of edges) {
        if (!shouldIncludeEdge(edge, includeTypeOnly)) continue;
        if (visited.has(edge.target)) continue;
        visited.add(edge.target);
        result.push(edge.target);
        if (currentDepth === 0) directCount++;
        nextFrontier.push(edge.target);
      }
    }
    frontier = nextFrontier;
    currentDepth++;
  }

  // Group by package
  const byPackage: Record<string, string[]> = {};
  for (const f of result) {
    const pkgName = findPackageName(f);
    if (!byPackage[pkgName]) byPackage[pkgName] = [];
    byPackage[pkgName]!.push(f);
  }

  return { root: file, nodes: result.length, directCount, files: result, byPackage };
}

// ─── 3. importCycles ────────────────────────────────────────────────────────

export interface CycleOpts {
  file?: string; // filter to cycles containing this file
  package?: string; // filter to cycles within this directory
}

export interface CycleResult {
  count: number;
  cycles: string[][];
}

/**
 * Find import cycles using Tarjan's SCC algorithm.
 * Returns strongly connected components with more than 1 node.
 */
export function importCycles(
  graph: ModuleGraph,
  opts: CycleOpts = {}
): CycleResult {
  const { file, package: pkgDir } = opts;

  // Tarjan's SCC
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const sccs: string[][] = [];

  function strongconnect(v: string): void {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    const edges = graph.forward.get(v) ?? [];
    for (const edge of edges) {
      const w = edge.target;
      if (!graph.files.has(w)) continue; // skip external
      if (!indices.has(w)) {
        strongconnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }

    // Root of SCC?
    if (lowlinks.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) {
        sccs.push(scc);
      }
    }
  }

  for (const f of graph.files) {
    if (!indices.has(f)) {
      strongconnect(f);
    }
  }

  // Apply filters
  let cycles = sccs;
  if (file) {
    cycles = cycles.filter((scc) => scc.includes(file));
  }
  if (pkgDir) {
    const absPkgDir = path.resolve(pkgDir);
    cycles = cycles.filter((scc) =>
      scc.every((f) => f.startsWith(absPkgDir))
    );
  }

  return { count: cycles.length, cycles };
}

// ─── 4. shortestPath ────────────────────────────────────────────────────────

export interface PathOpts {
  includeTypeOnly?: boolean; // default: false
}

export interface PathResult {
  path: string[] | null;
  hops: number;
  chain: Array<{ file: string; imports: string[] }>;
}

/**
 * BFS on forward graph from `from` to `to`.
 * Returns the shortest import path with specifier names at each hop.
 */
export function shortestPath(
  graph: ModuleGraph,
  from: string,
  to: string,
  opts: PathOpts = {}
): PathResult {
  const { includeTypeOnly = false } = opts;

  if (from === to) {
    return { path: [from], hops: 0, chain: [{ file: from, imports: [] }] };
  }

  // BFS with parent tracking
  const visited = new Set<string>();
  const parent = new Map<string, { from: string; specifiers: string[] }>();
  visited.add(from);
  let frontier = [from];

  while (frontier.length > 0) {
    const nextFrontier: string[] = [];
    for (const f of frontier) {
      const edges = graph.forward.get(f) ?? [];
      for (const edge of edges) {
        if (!shouldIncludeEdge(edge, includeTypeOnly)) continue;
        if (visited.has(edge.target)) continue;
        visited.add(edge.target);
        parent.set(edge.target, { from: f, specifiers: edge.specifiers });

        if (edge.target === to) {
          // Reconstruct path
          const filePath: string[] = [to];
          let current = to;
          while (parent.has(current)) {
            current = parent.get(current)!.from;
            filePath.unshift(current);
          }

          const chain: Array<{ file: string; imports: string[] }> = [];
          for (let i = 0; i < filePath.length; i++) {
            const p = parent.get(filePath[i]!);
            chain.push({
              file: filePath[i]!,
              imports: p?.specifiers ?? [],
            });
          }

          return { path: filePath, hops: filePath.length - 1, chain };
        }

        nextFrontier.push(edge.target);
      }
    }
    frontier = nextFrontier;
  }

  return { path: null, hops: -1, chain: [] };
}

// ─── 5. subgraph ────────────────────────────────────────────────────────────

export interface SubgraphOpts {
  depth?: number; // default: 1
  direction?: "imports" | "dependents" | "both"; // default: "both"
}

export interface SubgraphResult {
  nodes: string[];
  edges: Array<{
    from: string;
    to: string;
    specifiers: string[];
    isTypeOnly: boolean;
  }>;
  stats: { nodeCount: number; edgeCount: number };
}

/**
 * Expand from seed files by `depth` hops in the specified direction.
 * Returns the induced subgraph (all edges between discovered nodes).
 */
export function subgraph(
  graph: ModuleGraph,
  files: string[],
  opts: SubgraphOpts = {}
): SubgraphResult {
  const { depth = 1, direction = "both" } = opts;
  const visited = new Set<string>(files);

  let frontier = [...files];
  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const nextFrontier: string[] = [];
    for (const f of frontier) {
      if (direction === "imports" || direction === "both") {
        for (const edge of graph.forward.get(f) ?? []) {
          if (!visited.has(edge.target)) {
            visited.add(edge.target);
            nextFrontier.push(edge.target);
          }
        }
      }
      if (direction === "dependents" || direction === "both") {
        for (const edge of graph.reverse.get(f) ?? []) {
          if (!visited.has(edge.target)) {
            visited.add(edge.target);
            nextFrontier.push(edge.target);
          }
        }
      }
    }
    frontier = nextFrontier;
  }

  // Collect all edges between discovered nodes
  const nodes = [...visited];
  const edges: SubgraphResult["edges"] = [];
  for (const f of nodes) {
    for (const edge of graph.forward.get(f) ?? []) {
      if (visited.has(edge.target)) {
        edges.push({
          from: f,
          to: edge.target,
          specifiers: edge.specifiers,
          isTypeOnly: edge.isTypeOnly,
        });
      }
    }
  }

  return { nodes, edges, stats: { nodeCount: nodes.length, edgeCount: edges.length } };
}

// ─── 6. moduleBoundary ──────────────────────────────────────────────────────

export interface BoundaryResult {
  internalEdges: number;
  incomingEdges: Array<{ from: string; to: string; specifiers: string[] }>;
  outgoingEdges: Array<{ from: string; to: string; specifiers: string[] }>;
  sharedDependencies: string[];
  isolationScore: number; // 0–1
}

/**
 * Cut-line analysis for a set of files.
 * Identifies incoming/outgoing edges and computes an isolation score.
 */
export function moduleBoundary(
  graph: ModuleGraph,
  files: string[]
): BoundaryResult {
  const fileSet = new Set(files);

  let internalEdges = 0;
  const incomingEdges: BoundaryResult["incomingEdges"] = [];
  const outgoingEdges: BoundaryResult["outgoingEdges"] = [];
  const outgoingTargets = new Set<string>();

  // Count internal edges and outgoing edges
  for (const f of files) {
    for (const edge of graph.forward.get(f) ?? []) {
      if (fileSet.has(edge.target)) {
        internalEdges++;
      } else {
        outgoingEdges.push({
          from: f,
          to: edge.target,
          specifiers: edge.specifiers,
        });
        outgoingTargets.add(edge.target);
      }
    }
  }

  // Find incoming edges (files outside the set that import files in the set)
  for (const f of files) {
    for (const edge of graph.reverse.get(f) ?? []) {
      if (!fileSet.has(edge.target)) {
        incomingEdges.push({
          from: edge.target,
          to: f,
          specifiers: edge.specifiers,
        });
      }
    }
  }

  // Shared dependencies: outgoing targets that are imported by multiple files in the set
  const depCounts = new Map<string, number>();
  for (const f of files) {
    for (const edge of graph.forward.get(f) ?? []) {
      if (!fileSet.has(edge.target)) {
        depCounts.set(edge.target, (depCounts.get(edge.target) ?? 0) + 1);
      }
    }
  }
  const sharedDependencies = [...depCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([dep]) => dep);

  const total = internalEdges + incomingEdges.length + outgoingEdges.length;
  const isolationScore = total === 0 ? 1 : internalEdges / total;

  return {
    internalEdges,
    incomingEdges,
    outgoingEdges,
    sharedDependencies,
    isolationScore,
  };
}
