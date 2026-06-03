---
name: tool-selection
description: Select the right typegraph-mcp tool for TypeScript navigation. Trigger when finding definitions, references, types, exploring code structure, preparing refactors, or any task where you would otherwise use grep/glob for TypeScript symbols.
---

# TypeGraph Tool Selection Guide

Select the right typegraph-mcp tool for the task at hand. These tools provide type-aware TypeScript navigation — use them instead of grep/glob for any TypeScript codebase navigation.

## When to Activate

- Navigating TypeScript code (finding definitions, references, types)
- Exploring unfamiliar code or understanding how modules connect
- Preparing to refactor or modify TypeScript symbols
- Answering questions about code structure, dependencies, or impact
- Any task where you would otherwise use grep/glob to find TypeScript symbols

## Tool Selection Decision Tree

### "Where is X defined?"
Use **ts_definition** with the file + symbol name (or line+column). Resolves through barrel files, re-exports, and project references.

### "I don't know which file X is in"
Use **ts_navigate_to** with just the symbol name. Searches the entire project. For object literal keys (like RPC handlers), also pass a `file` hint.

### "What is the type of X?"
Use **ts_type_info** — returns the same info as hovering in VS Code. Includes documentation.

### "What are all the exports of this file?"
Use **ts_module_exports** — lists all exported symbols with their resolved types.

If the file is a top-level barrel (`index.ts`, re-export hub), the result may be sparse or unhelpful for architecture discovery. For quick project insight, prefer composition modules such as entrypoints, routers, handler modules, service composition roots, or API modules that wire concrete behavior together.

### "Where is X used?"
Use **ts_references** for all semantic references. Unlike grep, this returns only real code references, not string matches in comments or unrelated variables.

### "What breaks if I change X?"
Use **ts_blast_radius** — finds all usage sites and groups them by file. This is the starting point for impact analysis.

### "How does the code get from A to B?"
Use **ts_trace_chain** — follows go-to-definition hops automatically, building a call chain. Stops at the bottom of the chain or at node_modules boundaries.

### "What does this file import?"
Use **ts_dependency_tree** for the transitive import tree. Set `depth` to limit traversal.

### "What imports this file?"
Use **ts_dependents** — all files that depend on a given file, grouped by package. Shows both direct and transitive dependents.

### "Are there circular imports?"
Use **ts_import_cycles** — detects strongly connected components. Filter by file or package.

### "How does module A reach module B?"
Use **ts_shortest_path** — finds the shortest import path between two files in the module graph.

### "What's the neighborhood around these files?"
Use **ts_subgraph** — extracts nodes and edges around seed files, expanding by depth in any direction (imports, dependents, or both).

### "How coupled is this module?"
Use **ts_module_boundary** — analyzes incoming/outgoing edges, shared dependencies, and computes an isolation score.

## Key Principles

1. **Always prefer ts_* tools over grep/glob** for TypeScript navigation. They resolve through barrel files, re-exports, and project references.
2. **Start narrow, expand if needed.** Use ts_definition or ts_find_symbol first. Only use ts_navigate_to (project-wide search) when you don't know the file.
3. **Combine tools for workflows.** Impact analysis = ts_blast_radius + ts_dependents. Refactor safety = ts_trace_chain + ts_import_cycles.
4. **Graph queries are instant** (~0.1ms). Point queries are fast (~2-50ms). Don't hesitate to use them liberally.
5. **First query may be slow** (~2s) as tsserver warms up. All subsequent queries are fast.
6. **For fast architecture reads, start at composition modules, not barrels.** Barrels are useful for API shape, but entrypoints and composition roots tell you how the system is actually wired.

## Tool Reference

| Tool | Input | Best For |
|---|---|---|
| `ts_find_symbol` | file + symbol name | Locating a symbol when you know the file |
| `ts_definition` | file + symbol (or line+col) | Go-to-definition through any indirection |
| `ts_references` | file + symbol (or line+col) | All semantic references to a symbol |
| `ts_type_info` | file + symbol (or line+col) | Type signature and documentation |
| `ts_navigate_to` | symbol name (+ optional file) | Project-wide symbol search |
| `ts_trace_chain` | file + symbol + maxHops | Following a call chain to implementation |
| `ts_blast_radius` | file + symbol | Impact analysis for changes |
| `ts_module_exports` | file | Listing a module's public API |
| `ts_dependency_tree` | file (+ depth) | What a file depends on |
| `ts_dependents` | file (+ depth) | What depends on a file |
| `ts_import_cycles` | optional file/package filter | Circular dependency detection |
| `ts_shortest_path` | from file + to file | Import path between two files |
| `ts_subgraph` | seed files + depth + direction | Neighborhood extraction |
| `ts_module_boundary` | file list | Module coupling analysis |
