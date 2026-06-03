#!/usr/bin/env npx tsx
/**
 * TypeGraph MCP Server — Type-aware codebase navigation for AI coding agents.
 *
 * Bridges MCP protocol (stdin/stdout) to tsserver (child process pipes).
 * Provides 14 tools for definition, references, type info, symbol search,
 * call chain tracing, blast radius analysis, module export inspection,
 * and module graph queries (dependency trees, cycles, paths, boundaries).
 *
 * Usage:
 *   npx tsx server.ts
 *
 * Environment:
 *   TYPEGRAPH_PROJECT_ROOT  — project root (default: cwd)
 *   TYPEGRAPH_TSCONFIG      — tsconfig path (default: ./tsconfig.json)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseSync } from "oxc-parser";
import type { ResolverFactory } from "oxc-resolver";
import { z } from "zod";
import { TsServerClient, type NavBarItem } from "./tsserver-client.js";
import {
  buildGraph,
  resolveProjectImport,
  startWatcher,
  type ModuleGraph,
} from "./module-graph.js";
import {
  dependencyTree,
  dependents,
  importCycles,
  shortestPath,
  subgraph,
  moduleBoundary,
} from "./graph-queries.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveConfig } from "./config.js";

// ─── Configuration ───────────────────────────────────────────────────────────

const { projectRoot, tsconfigPath } = resolveConfig(import.meta.dirname);

const log = (...args: unknown[]) => console.error("[typegraph]", ...args);

// ─── Initialize ──────────────────────────────────────────────────────────────

const client = new TsServerClient(projectRoot, tsconfigPath);

// Module graph — initialized in main(), used by graph tools
let moduleGraph: ModuleGraph;
let moduleResolver: ResolverFactory;

const mcpServer = new McpServer({
  name: "typegraph",
  version: "1.0.0",
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Read a preview line from a file at a 1-based line number */
function readPreview(file: string, line: number): string {
  try {
    const absPath = client.resolvePath(file);
    const content = fs.readFileSync(absPath, "utf-8");
    return content.split("\n")[line - 1]?.trim() ?? "";
  } catch {
    return "";
  }
}

/** Search a navbar tree recursively for a symbol by name */
function findInNavBar(
  items: NavBarItem[],
  symbol: string
): { line: number; offset: number; kind: string } | null {
  for (const item of items) {
    if (item.text === symbol && item.spans.length > 0) {
      const span = item.spans[0]!;
      return { line: span.start.line, offset: span.start.offset, kind: item.kind };
    }
    if (item.childItems?.length > 0) {
      const found = findInNavBar(item.childItems, symbol);
      if (found) return found;
    }
  }
  return null;
}

/** Resolve symbol to coordinates: try navbar first, fall back to navto */
async function resolveSymbol(
  file: string,
  symbol: string
): Promise<{
  file: string;
  line: number;
  column: number;
  kind: string;
  preview: string;
} | null> {
  // Strategy 1: navbar (file-scoped AST search)
  const bar = await client.navbar(file);
  const found = findInNavBar(bar, symbol);
  if (found) {
    return {
      file,
      line: found.line,
      column: found.offset,
      kind: found.kind,
      preview: readPreview(file, found.line),
    };
  }

  // Strategy 2: navto (project-wide search, filtered by file)
  const items = await client.navto(symbol, 10, file);
  // Prefer exact match in the specified file
  const inFile = items.find((i) => i.name === symbol && i.file === file);
  const best = inFile ?? items.find((i) => i.name === symbol) ?? items[0];

  if (best) {
    return {
      file: best.file,
      line: best.start.line,
      column: best.start.offset,
      kind: best.kind,
      preview: readPreview(best.file, best.start.line),
    };
  }

  return null;
}

// ─── Tool Schemas ────────────────────────────────────────────────────────────

/**
 * Shared schema for tools that accept either coordinates (file+line+column)
 * or a symbol name (file+symbol). The MCP SDK requires a flat object schema.
 */
const locationOrSymbol = {
  file: z.string().describe("File path (relative to project root or absolute)"),
  line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Line number (1-based). Required if symbol is not provided."),
  column: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Column/offset (1-based). Required if symbol is not provided."),
  symbol: z.string().optional().describe("Symbol name to find. Alternative to line+column."),
};

/** Resolve params to coordinates: use line+column if provided, else find symbol */
async function resolveParams(params: {
  file: string;
  line?: number;
  column?: number;
  symbol?: string;
}): Promise<{ file: string; line: number; column: number } | { error: string }> {
  if (params.line !== undefined && params.column !== undefined) {
    return { file: params.file, line: params.line, column: params.column };
  }
  if (params.symbol) {
    const resolved = await resolveSymbol(params.file, params.symbol);
    if (!resolved) {
      return { error: `Symbol "${params.symbol}" not found in ${params.file}` };
    }
    return { file: resolved.file, line: resolved.line, column: resolved.column };
  }
  return { error: "Either line+column or symbol must be provided" };
}

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

type StaticExportEntry = ReturnType<typeof parseSync>["module"]["staticExports"][number]["entries"][number];

const exportKinds = new Set([
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

function exportPriority(source: ModuleExportRecord["source"]): number {
  switch (source) {
    case "local":
      return 3;
    case "re-export":
      return 2;
    case "star-re-export":
      return 1;
  }
}

function exportKey(item: Pick<ModuleExportRecord, "symbol" | "exportKind">): string {
  return `${item.symbol}:${item.exportKind}`;
}

function sameExportOrigin(a: ModuleExportRecord, b: ModuleExportRecord): boolean {
  return (
    a.symbol === b.symbol &&
    a.exportKind === b.exportKind &&
    a.from === b.from &&
    a.definedIn === b.definedIn &&
    a.definedLine === b.definedLine
  );
}

function kindImpliesTypeOnly(kind: string): boolean {
  return kind === "type" || kind === "interface";
}

function normalizeExportKindLabel(
  kind: string,
  exportKind: ModuleExportRecord["exportKind"]
): string {
  if (exportKind === "type" && !kindImpliesTypeOnly(kind)) {
    return "type";
  }
  return kind;
}

function upsertExport(
  map: Map<string, ModuleExportRecord>,
  conflicts: Set<string>,
  nextExport: ModuleExportRecord
): void {
  const key = exportKey(nextExport);
  if (conflicts.has(key)) {
    if (nextExport.source === "star-re-export") return;
    conflicts.delete(key);
    map.set(key, nextExport);
    return;
  }

  const existing = map.get(key);
  if (
    existing &&
    existing.source === "star-re-export" &&
    nextExport.source === "star-re-export" &&
    !sameExportOrigin(existing, nextExport)
  ) {
    map.delete(key);
    conflicts.add(key);
    return;
  }

  if (!existing || exportPriority(nextExport.source) > exportPriority(existing.source)) {
    map.set(key, nextExport);
  }
}

function offsetToLineColumn(source: string, offset: number | null | undefined): {
  line: number;
  column: number;
} {
  const safeOffset = Math.max(0, Math.min(offset ?? 0, source.length));
  const prefix = source.slice(0, safeOffset);
  const lines = prefix.split("\n");
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
}

function normalizeExistingPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

const normalizedProjectRoot = normalizeExistingPath(projectRoot);

function projectPath(file: string): string {
  return path.isAbsolute(file) ? relPath(file) : file;
}

function exportSymbol(entry: StaticExportEntry): string | null {
  if (entry.exportName.kind === "Default") return "default";
  return entry.exportName.name ?? entry.localName.name ?? entry.importName.name;
}

function exportLookupOffset(entry: StaticExportEntry): number | null | undefined {
  if ((entry as { moduleRequest?: { value: string } }).moduleRequest) {
    return entry.importName.start ?? entry.exportName.start ?? entry.start;
  }
  if (entry.exportName.kind === "Default") {
    return entry.localName.start ?? entry.exportName.start ?? entry.start;
  }
  return entry.exportName.start ?? entry.localName.start ?? entry.start;
}

async function resolveExportMetadata(
  file: string,
  line: number,
  column: number,
  fallbackKind: string
): Promise<{
  kind: string;
  type: string | null;
  definedIn: string;
  definedLine: number | null;
}> {
  const defs = await client.definition(file, line, column);
  const def = defs[0] ?? null;

  let info = await client.quickinfo(file, line, column);
  if ((!info || info.kind === "alias") && def) {
    info = (await client.quickinfo(def.file, def.start.line, def.start.offset)) ?? info;
  }

  return {
    kind: info?.kind ?? fallbackKind,
    type: info?.displayString ?? null,
    definedIn: projectPath(def?.file ?? file),
    definedLine: def?.start.line ?? null,
  };
}

async function getModuleExports(
  file: string,
  visited = new Set<string>()
): Promise<ModuleExportRecord[]> {
  const relFile = path.isAbsolute(file) ? relPath(file) : file;
  const absFile = normalizeExistingPath(client.resolvePath(relFile));
  if (visited.has(absFile)) return [];

  const nextVisited = new Set(visited);
  nextVisited.add(absFile);

  const exportMap = new Map<string, ModuleExportRecord>();
  const conflictingStarExports = new Set<string>();

  let source: string;
  try {
    source = fs.readFileSync(absFile, "utf-8");
  } catch {
    return [...exportMap.values()];
  }

  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(absFile, source);
  } catch {
    return [...exportMap.values()];
  }

  for (const exp of parsed.module.staticExports) {
    for (const entry of exp.entries) {
      const moduleRequest = (entry as { moduleRequest?: { value: string } }).moduleRequest;
      if (!moduleRequest) continue;

      const targetFile = resolveProjectImport(
        moduleResolver,
        path.dirname(absFile),
        moduleRequest.value,
        projectRoot
      );

      const exportLoc = offsetToLineColumn(
        source,
        entry.exportName.start ?? entry.localName.start ?? entry.importName.start ?? entry.start
      );
      const importKind = entry.importName.kind as string;
      const exportKind = entry.exportName.kind as string;

      if (importKind === "AllButDefault" && exportKind === "None") {
        if (!targetFile) continue;
        const nestedExports = await getModuleExports(targetFile, nextVisited);
        for (const nested of nestedExports) {
          if (nested.symbol === "default") continue;
          const starExportKind: ModuleExportRecord["exportKind"] = entry.isType
            ? "type"
            : nested.exportKind;
          upsertExport(exportMap, conflictingStarExports, {
            ...nested,
            line: exportLoc.line,
            exportKind: starExportKind,
            isTypeOnly: starExportKind === "type",
            source: "star-re-export",
            from: relPath(targetFile),
          });
        }
        continue;
      }

      const symbol = exportSymbol(entry);
      if (!symbol) continue;

      const importedSymbol =
        importKind === "Default"
          ? "default"
          : importKind === "Name"
            ? entry.importName.name
            : null;
      const nestedMatch =
        targetFile && importedSymbol
          ? (await getModuleExports(targetFile, nextVisited)).find(
              (item) => item.symbol === importedSymbol
            ) ?? null
          : null;

      const lookupLoc = offsetToLineColumn(
        source,
        exportLookupOffset(entry)
      );
      const metadata = await resolveExportMetadata(
        relFile,
        lookupLoc.line,
        lookupLoc.column,
        importKind === "All" ? "namespace" : "alias"
      );
      const resolvedExportKind: ModuleExportRecord["exportKind"] =
        entry.isType ||
        nestedMatch?.exportKind === "type" ||
        kindImpliesTypeOnly(nestedMatch?.kind ?? metadata.kind)
          ? "type"
          : "value";
      const resolvedKind = normalizeExportKindLabel(
        nestedMatch?.kind ?? metadata.kind,
        resolvedExportKind
      );

      upsertExport(exportMap, conflictingStarExports, {
        symbol,
        kind: resolvedKind,
        line: exportLoc.line,
        type: nestedMatch?.type ?? metadata.type,
        exportKind: resolvedExportKind,
        isTypeOnly: resolvedExportKind === "type",
        isNamespace: importKind === "All",
        source: "re-export",
        from: targetFile ? relPath(targetFile) : moduleRequest.value,
        definedIn: nestedMatch?.definedIn ?? metadata.definedIn,
        definedLine: nestedMatch?.definedLine ?? metadata.definedLine,
      });
      continue;
    }

    for (const entry of exp.entries) {
      const moduleRequest = (entry as { moduleRequest?: { value: string } }).moduleRequest;
      if (moduleRequest) continue;

      const symbol = exportSymbol(entry);
      if (!symbol) continue;

      const exportLoc = offsetToLineColumn(
        source,
        entry.exportName.start ?? entry.localName.start ?? entry.start
      );
      const lookupLoc = offsetToLineColumn(source, exportLookupOffset(entry));
      const metadata = await resolveExportMetadata(
        relFile,
        lookupLoc.line,
        lookupLoc.column,
        entry.isType ? "type" : "value"
      );
      const resolvedExportKind: ModuleExportRecord["exportKind"] =
        entry.isType || kindImpliesTypeOnly(metadata.kind) ? "type" : "value";
      const resolvedKind = normalizeExportKindLabel(metadata.kind, resolvedExportKind);

      // Skip navbar/import alias noise — only keep actual exported declaration kinds.
      if (
        resolvedExportKind === "value" &&
        symbol !== "default" &&
        !exportKinds.has(resolvedKind) &&
        resolvedKind !== "namespace" &&
        resolvedKind !== "class"
      ) {
        continue;
      }

      upsertExport(exportMap, conflictingStarExports, {
        symbol,
        kind: resolvedKind,
        line: exportLoc.line,
        type: metadata.type,
        exportKind: resolvedExportKind,
        isTypeOnly: resolvedExportKind === "type",
        isNamespace: false,
        source: "local",
        from: null,
        definedIn: relFile,
        definedLine: resolvedExportKind === "type" ? exportLoc.line : metadata.definedLine,
      });
    }
  }

  return [...exportMap.values()].sort(
    (a, b) => a.line - b.line || a.symbol.localeCompare(b.symbol)
  );
}

// ─── Tool 1: ts_find_symbol ─────────────────────────────────────────────────

mcpServer.tool(
  "ts_find_symbol",
  "Find a symbol's location in a file by name. Entry point for navigating without exact coordinates.",
  {
    file: z.string().describe("File to search in (relative or absolute path)"),
    symbol: z.string().describe("Symbol name to find"),
  },
  async ({ file, symbol }) => {
    const result = await resolveSymbol(file, symbol);
    if (!result) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: `Symbol "${symbol}" not found in ${file}` }),
          },
        ],
      };
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result) }],
    };
  }
);

// ─── Tool 2: ts_definition ──────────────────────────────────────────────────

mcpServer.tool(
  "ts_definition",
  "Go to definition. Resolves through imports, re-exports, barrel files, interfaces, generics. Provide either line+column coordinates or a symbol name.",
  locationOrSymbol,
  async (params) => {
    const loc = await resolveParams(params);
    if ("error" in loc) {
      return { content: [{ type: "text" as const, text: JSON.stringify(loc) }] };
    }

    const defs = await client.definition(loc.file, loc.line, loc.column);
    if (defs.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ definitions: [], source: readPreview(loc.file, loc.line) }),
          },
        ],
      };
    }

    const results = defs.map((d) => ({
      file: d.file,
      line: d.start.line,
      column: d.start.offset,
      preview: readPreview(d.file, d.start.line),
    }));

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ definitions: results }) }],
    };
  }
);

// ─── Tool 3: ts_references ──────────────────────────────────────────────────

mcpServer.tool(
  "ts_references",
  "Find all references to a symbol. Returns semantic code references only (not string matches). Provide either line+column or symbol name.",
  locationOrSymbol,
  async (params) => {
    const loc = await resolveParams(params);
    if ("error" in loc) {
      return { content: [{ type: "text" as const, text: JSON.stringify(loc) }] };
    }

    const refs = await client.references(loc.file, loc.line, loc.column);
    const results = refs.map((r) => ({
      file: r.file,
      line: r.start.line,
      column: r.start.offset,
      preview: r.lineText.trim(),
      isDefinition: r.isDefinition,
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ references: results, count: results.length }),
        },
      ],
    };
  }
);

// ─── Tool 4: ts_type_info ───────────────────────────────────────────────────

mcpServer.tool(
  "ts_type_info",
  "Get the TypeScript type and documentation for a symbol. Returns the same info you see when hovering in VS Code. Provide either line+column or symbol name.",
  locationOrSymbol,
  async (params) => {
    const loc = await resolveParams(params);
    if ("error" in loc) {
      return { content: [{ type: "text" as const, text: JSON.stringify(loc) }] };
    }

    const info = await client.quickinfo(loc.file, loc.line, loc.column);
    if (!info) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              type: null,
              documentation: null,
              source: readPreview(loc.file, loc.line),
            }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            type: info.displayString,
            documentation: info.documentation || null,
            kind: info.kind,
          }),
        },
      ],
    };
  }
);

// ─── Tool 5: ts_navigate_to ─────────────────────────────────────────────────

mcpServer.tool(
  "ts_navigate_to",
  "Search for a symbol across the entire project without knowing which file it's in. Returns matching declarations. Optionally provide a file hint to also search that file's navbar (useful for object literal keys like RPC handlers that navto doesn't index).",
  {
    symbol: z.string().describe("Symbol name to search for"),
    file: z
      .string()
      .optional()
      .describe(
        "Optional file to also search via navbar (covers object literal keys not indexed by navto)"
      ),
    maxResults: z
      .number()
      .int()
      .positive()
      .optional()
      .default(10)
      .describe("Maximum results (default 10)"),
  },
  async ({ symbol, file, maxResults }) => {
    const items = await client.navto(symbol, maxResults);
    const results = items.map((item) => ({
      file: item.file,
      line: item.start.line,
      column: item.start.offset,
      kind: item.kind,
      containerName: item.containerName,
      matchKind: item.matchKind,
    }));

    // Supplement with navbar search when a file hint is provided.
    // This covers object literal property keys (e.g. RPC handlers)
    // that tsserver's navto command doesn't index.
    if (file) {
      const navbarHit = await resolveSymbol(file, symbol);
      if (navbarHit) {
        const alreadyFound = results.some(
          (r) => r.file === navbarHit.file && r.line === navbarHit.line
        );
        if (!alreadyFound) {
          results.unshift({
            file: navbarHit.file,
            line: navbarHit.line,
            column: navbarHit.column,
            kind: navbarHit.kind,
            containerName: "",
            matchKind: "navbar",
          });
        }
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ results, count: results.length }),
        },
      ],
    };
  }
);

// ─── Tool 6: ts_trace_chain ─────────────────────────────────────────────────

mcpServer.tool(
  "ts_trace_chain",
  "Automatically follow go-to-definition hops from a symbol, building a call chain from entry point to implementation. Stops when it reaches the bottom or a cycle.",
  {
    file: z.string().describe("Starting file"),
    symbol: z.string().describe("Starting symbol name"),
    maxHops: z
      .number()
      .int()
      .positive()
      .optional()
      .default(5)
      .describe("Maximum hops to follow (default 5)"),
  },
  async ({ file, symbol, maxHops }) => {
    const start = await resolveSymbol(file, symbol);
    if (!start) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: `Symbol "${symbol}" not found in ${file}` }),
          },
        ],
      };
    }

    const chain: Array<{
      file: string;
      line: number;
      column: number;
      preview: string;
    }> = [
      {
        file: start.file,
        line: start.line,
        column: start.column,
        preview: start.preview,
      },
    ];

    let current = { file: start.file, line: start.line, offset: start.column };

    for (let i = 0; i < maxHops; i++) {
      const defs = await client.definition(current.file, current.line, current.offset);
      if (defs.length === 0) break;

      const def = defs[0]!;
      // Stop if we've reached the same location (self-reference)
      if (def.file === current.file && def.start.line === current.line) break;
      // Stop if we've entered node_modules (external dependency)
      if (def.file.includes("node_modules")) break;

      const preview = readPreview(def.file, def.start.line);
      chain.push({
        file: def.file,
        line: def.start.line,
        column: def.start.offset,
        preview,
      });

      current = { file: def.file, line: def.start.line, offset: def.start.offset };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ chain, hops: chain.length - 1 }),
        },
      ],
    };
  }
);

// ─── Tool 7: ts_blast_radius ────────────────────────────────────────────────

mcpServer.tool(
  "ts_blast_radius",
  "Analyze the impact of changing a symbol. Finds all references, filters to usage sites, and reports affected files.",
  {
    file: z.string().describe("File containing the symbol"),
    symbol: z.string().describe("Symbol to analyze"),
  },
  async ({ file, symbol }) => {
    const start = await resolveSymbol(file, symbol);
    if (!start) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: `Symbol "${symbol}" not found in ${file}` }),
          },
        ],
      };
    }

    const refs = await client.references(start.file, start.line, start.column);
    const callers = refs.filter((r) => !r.isDefinition);
    const filesAffected = [...new Set(callers.map((r) => r.file))];

    const callerList = callers.map((r) => ({
      file: r.file,
      line: r.start.line,
      preview: r.lineText.trim(),
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            directCallers: callers.length,
            filesAffected,
            callers: callerList,
          }),
        },
      ],
    };
  }
);

// ─── Tool 8: ts_module_exports ──────────────────────────────────────────────

mcpServer.tool(
  "ts_module_exports",
  "List all exported symbols from a module with their resolved types, including re-exports when possible. Gives an at-a-glance understanding of what a file provides.",
  {
    file: z.string().describe("File to inspect"),
  },
  async ({ file }) => {
    const exports = await getModuleExports(file);
    const localCount = exports.filter((item) => item.source === "local").length;
    const reExportCount = exports.length - localCount;
    const typeOnlyCount = exports.filter((item) => item.isTypeOnly).length;
    const valueCount = exports.length - typeOnlyCount;
    const namespaceExportCount = exports.filter((item) => item.isNamespace).length;
    const hasLocalRuntimeExports = exports.some(
      (item) => item.source === "local" && !item.isTypeOnly
    );
    const isPrimarilyBarrel = exports.length > 0 && localCount < reExportCount;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            file,
            exports,
            count: exports.length,
            localCount,
            reExportCount,
            typeOnlyCount,
            valueCount,
            namespaceExportCount,
            hasLocalRuntimeExports,
            isPrimarilyBarrel,
          }),
        },
      ],
    };
  }
);

// ─── Graph Tool Helpers ─────────────────────────────────────────────────────

/** Convert an absolute path to project-relative */
function relPath(absPath: string): string {
  return path.relative(normalizedProjectRoot, normalizeExistingPath(absPath));
}

/** Convert a relative or absolute path to absolute */
function absPath(file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(projectRoot, file);
}

// ─── Tool 9: ts_dependency_tree ─────────────────────────────────────────────

mcpServer.tool(
  "ts_dependency_tree",
  "Get the transitive dependency tree (imports) of a file. Shows what a file depends on, directly and transitively.",
  {
    file: z.string().describe("File to analyze (relative or absolute path)"),
    depth: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Max traversal depth (default: unlimited)"),
    includeTypeOnly: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include type-only imports (default: false)"),
  },
  async ({ file, depth, includeTypeOnly }) => {
    const result = dependencyTree(moduleGraph, absPath(file), { depth, includeTypeOnly });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            root: relPath(result.root),
            nodes: result.nodes,
            files: result.files.map(relPath),
          }),
        },
      ],
    };
  }
);

// ─── Tool 10: ts_dependents ─────────────────────────────────────────────────

mcpServer.tool(
  "ts_dependents",
  "Find all files that depend on (import) a given file, directly and transitively. Groups results by package.",
  {
    file: z.string().describe("File to analyze (relative or absolute path)"),
    depth: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Max traversal depth (default: unlimited)"),
    includeTypeOnly: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include type-only imports (default: false)"),
  },
  async ({ file, depth, includeTypeOnly }) => {
    const result = dependents(moduleGraph, absPath(file), { depth, includeTypeOnly });
    const byPackageRel: Record<string, string[]> = {};
    for (const [pkg, files] of Object.entries(result.byPackage)) {
      byPackageRel[pkg] = files.map(relPath);
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            root: relPath(result.root),
            nodes: result.nodes,
            directCount: result.directCount,
            files: result.files.map(relPath),
            byPackage: byPackageRel,
          }),
        },
      ],
    };
  }
);

// ─── Tool 11: ts_import_cycles ──────────────────────────────────────────────

mcpServer.tool(
  "ts_import_cycles",
  "Detect circular import dependencies in the project. Returns strongly connected components (cycles) in the import graph.",
  {
    file: z.string().optional().describe("Filter to cycles containing this file"),
    package: z.string().optional().describe("Filter to cycles within this directory"),
  },
  async ({ file, package: pkg }) => {
    const result = importCycles(moduleGraph, {
      file: file ? absPath(file) : undefined,
      package: pkg ? absPath(pkg) : undefined,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            count: result.count,
            cycles: result.cycles.map((cycle) => cycle.map(relPath)),
          }),
        },
      ],
    };
  }
);

// ─── Tool 12: ts_shortest_path ──────────────────────────────────────────────

mcpServer.tool(
  "ts_shortest_path",
  "Find the shortest import path between two files. Shows how one module reaches another through the import graph.",
  {
    from: z.string().describe("Source file (relative or absolute path)"),
    to: z.string().describe("Target file (relative or absolute path)"),
    includeTypeOnly: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include type-only imports (default: false)"),
  },
  async ({ from, to, includeTypeOnly }) => {
    const result = shortestPath(moduleGraph, absPath(from), absPath(to), { includeTypeOnly });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            path: result.path?.map(relPath) ?? null,
            hops: result.hops,
            chain: result.chain.map((c) => ({
              file: relPath(c.file),
              imports: c.imports,
            })),
          }),
        },
      ],
    };
  }
);

// ─── Tool 13: ts_subgraph ───────────────────────────────────────────────────

mcpServer.tool(
  "ts_subgraph",
  "Extract a subgraph around seed files. Expands by depth hops in the specified direction (imports, dependents, or both).",
  {
    files: z.array(z.string()).describe("Seed files to expand from (relative or absolute paths)"),
    depth: z
      .number()
      .int()
      .positive()
      .optional()
      .default(1)
      .describe("Hops to expand (default: 1)"),
    direction: z
      .enum(["imports", "dependents", "both"])
      .optional()
      .default("both")
      .describe("Direction to expand (default: both)"),
  },
  async ({ files, depth, direction }) => {
    const result = subgraph(moduleGraph, files.map(absPath), { depth, direction });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            nodes: result.nodes.map(relPath),
            edges: result.edges.map((e) => ({
              from: relPath(e.from),
              to: relPath(e.to),
              specifiers: e.specifiers,
              isTypeOnly: e.isTypeOnly,
            })),
            stats: result.stats,
          }),
        },
      ],
    };
  }
);

// ─── Tool 14: ts_module_boundary ────────────────────────────────────────────

mcpServer.tool(
  "ts_module_boundary",
  "Analyze the boundary of a set of files: incoming/outgoing edges, shared dependencies, and an isolation score. Useful for understanding module coupling.",
  {
    files: z
      .array(z.string())
      .describe("Files defining the module boundary (relative or absolute paths)"),
  },
  async ({ files }) => {
    const result = moduleBoundary(moduleGraph, files.map(absPath));
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            internalEdges: result.internalEdges,
            incomingEdges: result.incomingEdges.map((e) => ({
              from: relPath(e.from),
              to: relPath(e.to),
              specifiers: e.specifiers,
            })),
            outgoingEdges: result.outgoingEdges.map((e) => ({
              from: relPath(e.from),
              to: relPath(e.to),
              specifiers: e.specifiers,
            })),
            sharedDependencies: result.sharedDependencies.map(relPath),
            isolationScore: Math.round(result.isolationScore * 1000) / 1000,
          }),
        },
      ],
    };
  }
);

// ─── Start ───────────────────────────────────────────────────────────────────

async function main() {
  log("Starting TypeGraph MCP server...");
  log(`Project root: ${projectRoot}`);
  log(`tsconfig: ${tsconfigPath}`);

  // Start tsserver and build module graph concurrently
  const [, graphResult] = await Promise.all([
    client.start(),
    buildGraph(projectRoot, tsconfigPath),
  ]);

  moduleGraph = graphResult.graph;
  moduleResolver = graphResult.resolver;
  startWatcher(projectRoot, moduleGraph, graphResult.resolver, {
    onFileUpdated: (filePath) =>
      client.reloadOpenFile(filePath).catch((err) => {
        log(`Failed to reload open file ${relPath(filePath)}:`, err);
      }),
    onFileDeleted: (filePath) => {
      client.closeFile(filePath);
    },
  });

  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);

  log("MCP server connected and ready");
}

// Graceful shutdown
process.on("SIGINT", () => {
  log("Shutting down...");
  client.shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  client.shutdown();
  process.exit(0);
});

main().catch((err) => {
  log("Fatal error:", err);
  process.exit(1);
});
