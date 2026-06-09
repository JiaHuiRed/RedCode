#!/usr/bin/env npx tsx
/**
 * TypeGraph MCP Server — Type-aware codebase navigation for AI coding agents.
 *
 * Bridges MCP protocol (stdin/stdout) to tsserver (child process pipes).
 * 260609 CC 精简版：只保留 3 个 tsserver 类型工具
 *   - ts_definition     跳转定义（穿透 import/re-export/barrel/泛型）
 *   - ts_type_info      获取类型与文档（等同 VS Code hover）
 *   - ts_module_exports 列出模块导出及解析类型
 * 其余 11 个工具 + oxc 图子系统已被 jcodemunch 覆盖，整体移除。
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
// 260609 CC 精简版只保留 createResolver（路径解析，不构建整图）+ resolveProjectImport，
// 不再引入 buildGraph/startWatcher/graph-queries（图工具已被 jcodemunch 覆盖）。
import { createResolver, resolveProjectImport } from "./module-graph.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveConfig } from "./config.js";

// ─── Configuration ───────────────────────────────────────────────────────────

const { projectRoot, tsconfigPath } = resolveConfig(import.meta.dirname);

const log = (...args: unknown[]) => console.error("[typegraph]", ...args);

// ─── Initialize ──────────────────────────────────────────────────────────────

const client = new TsServerClient(projectRoot, tsconfigPath);

// 260609 CC 仅保留 resolver（ts_module_exports 解析 re-export 用），不再持有整图
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

// ─── Tool: ts_definition ────────────────────────────────────────────────────

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

// ─── Tool: ts_type_info ─────────────────────────────────────────────────────

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

// ─── Tool: ts_module_exports ────────────────────────────────────────────────

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

// ─── Path Helper ────────────────────────────────────────────────────────────

/** Convert an absolute path to project-relative (used by ts_module_exports) */
function relPath(absPath: string): string {
  return path.relative(normalizedProjectRoot, normalizeExistingPath(absPath));
}

// ─── Start ───────────────────────────────────────────────────────────────────

// 260609 CC 精简版只需文件级 resolver（解析 re-export 目标），无需构建整图
const TS_WATCH_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const TS_WATCH_SKIP_DIRS = new Set([
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

/**
 * Minimal recursive watcher: keeps tsserver fresh by reloading/closing changed
 * .ts files. reloadOpenFile no-ops for files tsserver hasn't opened, so this is
 * safe and cheap — no in-memory graph to maintain.
 */
function startReloadWatcher(): void {
  try {
    fs.watch(projectRoot, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = filename.toString();
      const parts = rel.split(/[\\/]/);
      if (parts.some((p) => TS_WATCH_SKIP_DIRS.has(p))) return;
      if (!TS_WATCH_EXTENSIONS.has(path.extname(rel))) return;

      const absFile = path.resolve(projectRoot, rel);
      if (fs.existsSync(absFile)) {
        client.reloadOpenFile(absFile).catch(() => {});
      } else {
        client.closeFile(absFile);
      }
    });
  } catch (err) {
    log("File watcher unavailable, tsserver freshness relies on reopen:", err);
  }
}

async function main() {
  log("Starting TypeGraph MCP server (slim: 3 tsserver tools)...");
  log(`Project root: ${projectRoot}`);
  log(`tsconfig: ${tsconfigPath}`);

  await client.start();
  moduleResolver = createResolver(projectRoot, tsconfigPath);
  startReloadWatcher();

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
