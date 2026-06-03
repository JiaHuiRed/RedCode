/**
 * Module Graph — Import/export dependency graph using oxc-parser + oxc-resolver.
 *
 * Builds a bidirectional graph of import edges across all TypeScript source files
 * in the project. Supports incremental updates via fs.watch.
 *
 * Graph stores absolute paths internally. Consumers convert to relative paths.
 */

import { parseSync } from "oxc-parser";
import { ResolverFactory } from "oxc-resolver";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ImportEdge {
  target: string; // absolute resolved file path
  specifiers: string[]; // ["UserService", "createUser"] or ["*"] for star re-exports
  isTypeOnly: boolean; // import type { ... } — only reliable for imports, not re-exports
  isDynamic: boolean; // import("./lazy")
}

export interface ModuleGraph {
  forward: Map<string, ImportEdge[]>; // file → its imports
  reverse: Map<string, ImportEdge[]>; // file → files that import it
  files: Set<string>; // all known source files
}

export interface BuildGraphResult {
  graph: ModuleGraph;
  resolver: ResolverFactory;
}

// ─── Logging ─────────────────────────────────────────────────────────────────

const log = (...args: unknown[]) => console.error("[typegraph/graph]", ...args);

// ─── Constants ───────────────────────────────────────────────────────────────

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".wrangler",
  ".mf",
  ".git",
  ".next",
  ".turbo",
  "coverage",
]);
const SKIP_FILES = new Set(["routeTree.gen.ts"]);

// ─── File Discovery ──────────────────────────────────────────────────────────

export function discoverFiles(rootDir: string): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        // Skip hidden directories (except the root)
        if (entry.name.startsWith(".") && dir !== rootDir) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const name = entry.name;
        if (SKIP_FILES.has(name)) continue;
        if (name.endsWith(".d.ts") || name.endsWith(".d.mts") || name.endsWith(".d.cts")) continue;
        const ext = path.extname(name);
        if (TS_EXTENSIONS.has(ext)) {
          files.push(path.join(dir, name));
        }
      }
    }
  }

  walk(rootDir);
  return files;
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

interface RawImport {
  specifier: string; // module specifier (e.g. "./utils", "effect")
  names: string[]; // imported names, or ["*"] for star
  isTypeOnly: boolean;
  isDynamic: boolean;
}

function parseFileImports(filePath: string, source: string): RawImport[] {
  const result = parseSync(filePath, source);
  const imports: RawImport[] = [];

  // Static imports: import { X, Y } from "./foo"
  for (const imp of result.module.staticImports) {
    const specifier = imp.moduleRequest.value;
    const names: string[] = [];
    let allTypeOnly = true;

    for (const entry of imp.entries) {
      const kind = entry.importName.kind as string;
      const name =
        kind === "Default"
          ? "default"
          : kind === "All" || kind === "AllButDefault" || kind === "NamespaceObject"
            ? "*"
            : (entry.importName.name ?? entry.localName.value);
      names.push(name);
      if (!entry.isType) allTypeOnly = false;
    }

    // If no entries (e.g. `import "./side-effect"`), it's a side-effect import
    if (names.length === 0) {
      imports.push({ specifier, names: ["*"], isTypeOnly: false, isDynamic: false });
    } else {
      imports.push({ specifier, names, isTypeOnly: allTypeOnly, isDynamic: false });
    }
  }

  // Static re-exports: export { X } from "./foo", export * from "./foo"
  for (const exp of result.module.staticExports) {
    for (const entry of exp.entries) {
      // Only re-exports have moduleRequest on the entry
      const moduleRequest = (entry as { moduleRequest?: { value: string } }).moduleRequest;
      if (!moduleRequest) continue;

      const specifier = moduleRequest.value;
      const entryKind = entry.importName.kind as string;
      const name =
        entryKind === "AllButDefault" || entryKind === "All" || entryKind === "NamespaceObject"
          ? "*"
          : (entry.importName.name ?? "*");

      // Group by specifier — multiple entries from same module
      const existing = imports.find((i) => i.specifier === specifier && !i.isDynamic);
      if (existing) {
        if (!existing.names.includes(name)) existing.names.push(name);
      } else {
        // oxc-parser doesn't expose isType on export entries, default false
        imports.push({ specifier, names: [name], isTypeOnly: false, isDynamic: false });
      }
    }
  }

  // Dynamic imports: import("./lazy")
  for (const di of result.module.dynamicImports) {
    if (di.moduleRequest) {
      const sliced = source.slice(di.moduleRequest.start, di.moduleRequest.end);
      // Only include string literals (starts with ' or ")
      if (sliced.startsWith("'") || sliced.startsWith('"')) {
        const specifier = sliced.slice(1, -1); // strip quotes
        imports.push({ specifier, names: ["*"], isTypeOnly: false, isDynamic: true });
      }
    }
  }

  return imports;
}

// ─── Resolution ──────────────────────────────────────────────────────────────

const SOURCE_EXTS = [".ts", ".tsx", ".mts", ".cts"];

/**
 * Map a dist/ path back to its source .ts file.
 *
 * Monorepo pattern:
 *   packages: rootDir="src", outDir="dist" → dist/X.js → src/X.ts
 *   apps:     rootDir=".", outDir="dist"   → dist/X.js → X.ts
 */
function distToSource(resolvedPath: string, projectRoot: string): string {
  // Only remap paths within the project that contain /dist/
  if (!resolvedPath.startsWith(projectRoot)) return resolvedPath;
  const rel = path.relative(projectRoot, resolvedPath);
  const distIdx = rel.indexOf("dist" + path.sep);
  if (distIdx === -1) return resolvedPath;

  const prefix = rel.slice(0, distIdx); // e.g. "packages/core/" or "apps/gateway/"
  const afterDist = rel.slice(distIdx + 5); // e.g. "index.js" or "schemas/index.js"

  // Strip .js/.mjs/.cjs extension
  const withoutExt = afterDist.replace(/\.(m?j|c)s$/, "");

  // Strategy 1: packages pattern — dist/X → src/X
  for (const ext of SOURCE_EXTS) {
    const candidate = path.resolve(projectRoot, prefix, "src", withoutExt + ext);
    if (fs.existsSync(candidate)) return candidate;
  }

  // Strategy 2: apps pattern — dist/X → X (rootDir is ".")
  for (const ext of SOURCE_EXTS) {
    const candidate = path.resolve(projectRoot, prefix, withoutExt + ext);
    if (fs.existsSync(candidate)) return candidate;
  }

  // Strategy 3: index file — dist/schemas/index.js → src/schemas/index.ts
  // Already covered by strategy 1, but try without /index
  if (withoutExt.endsWith("/index")) {
    const dirPath = withoutExt.slice(0, -6);
    for (const ext of SOURCE_EXTS) {
      const candidate = path.resolve(projectRoot, prefix, "src", dirPath + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return resolvedPath;
}

export function resolveProjectImport(
  resolver: ResolverFactory,
  fromDir: string,
  specifier: string,
  projectRoot: string
): string | null {
  try {
    const result = resolver.sync(fromDir, specifier);
    if (result.path && !result.path.includes("node_modules")) {
      const mapped = distToSource(result.path, projectRoot);
      // Only include TypeScript source files
      const ext = path.extname(mapped);
      if (!TS_EXTENSIONS.has(ext)) return null;
      // Exclude skipped files
      if (SKIP_FILES.has(path.basename(mapped))) return null;
      return mapped;
    }
  } catch {
    // Resolution failure — external dep, Node builtin, etc.
  }
  return null;
}

export function createResolver(projectRoot: string, tsconfigPath: string): ResolverFactory {
  return new ResolverFactory({
    tsconfig: {
      configFile: path.resolve(projectRoot, tsconfigPath),
      references: "auto",
    },
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    extensionAlias: {
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    },
    conditionNames: ["import", "require"],
    mainFields: ["module", "main"],
  });
}

// ─── Graph Construction ──────────────────────────────────────────────────────

function buildForwardEdges(
  files: string[],
  resolver: ResolverFactory,
  projectRoot: string
): { forward: Map<string, ImportEdge[]>; parseFailures: string[] } {
  const forward = new Map<string, ImportEdge[]>();
  const parseFailures: string[] = [];

  for (const filePath of files) {
    let source: string;
    try {
      source = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    let rawImports: RawImport[];
    try {
      rawImports = parseFileImports(filePath, source);
    } catch (err) {
      parseFailures.push(filePath);
      continue;
    }

    const edges: ImportEdge[] = [];
    const fromDir = path.dirname(filePath);

    for (const raw of rawImports) {
      const target = resolveProjectImport(resolver, fromDir, raw.specifier, projectRoot);
      if (target) {
        edges.push({
          target,
          specifiers: raw.names,
          isTypeOnly: raw.isTypeOnly,
          isDynamic: raw.isDynamic,
        });
      }
    }

    forward.set(filePath, edges);
  }

  return { forward, parseFailures };
}

function buildReverseMap(forward: Map<string, ImportEdge[]>): Map<string, ImportEdge[]> {
  const reverse = new Map<string, ImportEdge[]>();

  for (const [source, edges] of forward) {
    for (const edge of edges) {
      let revEdges = reverse.get(edge.target);
      if (!revEdges) {
        revEdges = [];
        reverse.set(edge.target, revEdges);
      }
      revEdges.push({
        target: source, // reverse: the "target" is the file that imports
        specifiers: edge.specifiers,
        isTypeOnly: edge.isTypeOnly,
        isDynamic: edge.isDynamic,
      });
    }
  }

  return reverse;
}

export async function buildGraph(
  projectRoot: string,
  tsconfigPath: string
): Promise<BuildGraphResult> {
  const startTime = performance.now();

  const resolver = createResolver(projectRoot, tsconfigPath);
  const fileList = discoverFiles(projectRoot);

  log(`Discovered ${fileList.length} source files`);

  const { forward, parseFailures } = buildForwardEdges(fileList, resolver, projectRoot);
  const reverse = buildReverseMap(forward);
  const files = new Set(fileList);

  const edgeCount = [...forward.values()].reduce((sum, edges) => sum + edges.length, 0);
  const elapsed = (performance.now() - startTime).toFixed(0);

  log(`Graph built: ${files.size} files, ${edgeCount} edges [${elapsed}ms]`);
  if (parseFailures.length > 0) {
    log(`Parse failures: ${parseFailures.length} files`);
  }

  return {
    graph: { forward, reverse, files },
    resolver,
  };
}

// ─── Incremental Updates ─────────────────────────────────────────────────────

export function updateFile(
  graph: ModuleGraph,
  filePath: string,
  resolver: ResolverFactory,
  projectRoot: string
): void {
  // Remove old forward edges from reverse map
  const oldEdges = graph.forward.get(filePath) ?? [];
  for (const edge of oldEdges) {
    const revEdges = graph.reverse.get(edge.target);
    if (revEdges) {
      const idx = revEdges.findIndex((r) => r.target === filePath);
      if (idx !== -1) revEdges.splice(idx, 1);
      if (revEdges.length === 0) graph.reverse.delete(edge.target);
    }
  }

  // Re-parse file
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf-8");
  } catch {
    // File unreadable — remove it
    removeFile(graph, filePath);
    return;
  }

  let rawImports: RawImport[];
  try {
    rawImports = parseFileImports(filePath, source);
  } catch {
    log(`Parse error on update: ${filePath}`);
    graph.forward.set(filePath, []);
    return;
  }

  // Build new edges
  const fromDir = path.dirname(filePath);
  const newEdges: ImportEdge[] = [];
  for (const raw of rawImports) {
    const target = resolveProjectImport(resolver, fromDir, raw.specifier, projectRoot);
    if (target) {
      newEdges.push({
        target,
        specifiers: raw.names,
        isTypeOnly: raw.isTypeOnly,
        isDynamic: raw.isDynamic,
      });
    }
  }

  // Update forward map
  graph.forward.set(filePath, newEdges);
  graph.files.add(filePath);

  // Update reverse map
  for (const edge of newEdges) {
    let revEdges = graph.reverse.get(edge.target);
    if (!revEdges) {
      revEdges = [];
      graph.reverse.set(edge.target, revEdges);
    }
    revEdges.push({
      target: filePath,
      specifiers: edge.specifiers,
      isTypeOnly: edge.isTypeOnly,
      isDynamic: edge.isDynamic,
    });
  }
}

export function removeFile(graph: ModuleGraph, filePath: string): void {
  // Remove forward edges from reverse map
  const edges = graph.forward.get(filePath) ?? [];
  for (const edge of edges) {
    const revEdges = graph.reverse.get(edge.target);
    if (revEdges) {
      const idx = revEdges.findIndex((r) => r.target === filePath);
      if (idx !== -1) revEdges.splice(idx, 1);
      if (revEdges.length === 0) graph.reverse.delete(edge.target);
    }
  }

  // Remove reverse edges that point to this file
  const revEdges = graph.reverse.get(filePath) ?? [];
  for (const revEdge of revEdges) {
    const fwdEdges = graph.forward.get(revEdge.target);
    if (fwdEdges) {
      const idx = fwdEdges.findIndex((e) => e.target === filePath);
      if (idx !== -1) fwdEdges.splice(idx, 1);
    }
  }

  graph.forward.delete(filePath);
  graph.reverse.delete(filePath);
  graph.files.delete(filePath);
}

// ─── File Watcher ────────────────────────────────────────────────────────────

export function startWatcher(
  projectRoot: string,
  graph: ModuleGraph,
  resolver: ResolverFactory,
  hooks?: {
    onFileUpdated?: (filePath: string) => void | Promise<void>;
    onFileDeleted?: (filePath: string) => void | Promise<void>;
  }
): void {
  try {
    const watcher = fs.watch(
      projectRoot,
      { recursive: true },
      (_eventType: string, filename: string | null) => {
        if (!filename) return;

        // Filter to TS files only
        const ext = path.extname(filename);
        if (!TS_EXTENSIONS.has(ext)) return;

        // Skip excluded directories and files
        const parts = filename.split(path.sep);
        if (parts.some((p: string) => SKIP_DIRS.has(p))) return;
        if (SKIP_FILES.has(path.basename(filename))) return;
        if (
          filename.endsWith(".d.ts") ||
          filename.endsWith(".d.mts") ||
          filename.endsWith(".d.cts")
        )
          return;

        const absPath = path.resolve(projectRoot, filename);

        if (fs.existsSync(absPath)) {
          // File created or modified
          updateFile(graph, absPath, resolver, projectRoot);
          void hooks?.onFileUpdated?.(absPath);
        } else {
          // File deleted
          removeFile(graph, absPath);
          void hooks?.onFileDeleted?.(absPath);
        }
      }
    );

    // Cleanup on process exit
    process.on("SIGINT", () => watcher.close());
    process.on("SIGTERM", () => watcher.close());

    log("File watcher started");
  } catch (err) {
    log("Failed to start file watcher:", err);
  }
}
