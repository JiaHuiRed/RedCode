---
description: Run a comprehensive 7-phase codebase analysis producing a detailed report
argument-hint: [--skip-phases 4,6]
---

# TypeGraph Deep Survey

Run a comprehensive 7-phase codebase exploration using all typegraph-mcp tools. Produces a detailed architectural report at `typegraph-exploration-report.md` in the project root.

## Execution Instructions

Follow the phases below in order. Each phase produces findings.

**Report output:** Write a markdown report to `<project_root>/typegraph-exploration-report.md` as you go. After each phase checkpoint, append that phase's findings to the report. Structure the report with the same phase headings used below. Include raw data (file counts, edge counts, cycle lists, blast radius numbers) alongside your interpretive analysis.

**Tool usage:** Call typegraph-mcp tools via the MCP tool interface (e.g., `ts_dependency_tree`, `ts_import_cycles`, etc.). Use `Glob` and `Grep` for file discovery steps. Use `Read` sparingly — only when a phase explicitly requires reading source to verify a hypothesis. The point is to learn as much as possible *from the graph* before reading code.

**Parallelism:** Within each phase, make independent tool calls in parallel. Between phases, respect the sequencing — later phases depend on earlier findings.

**Adaptiveness:** The procedure below uses placeholders like `<entry_point>` and `<service_file>`. Substitute actual files discovered during execution. If a phase yields surprising results, investigate before moving on — add a "Notable Finding" subsection to the report.

## Prerequisites

Run the health check first:
```bash
"__TYPEGRAPH_NODE__" "${CLAUDE_PLUGIN_ROOT}/node_modules/tsx/dist/cli.mjs" "${CLAUDE_PLUGIN_ROOT}/cli.ts" check
```

Record three numbers from the output:
- **File count** — calibrates expectations (200 files = afternoon, 2000 = days)
- **Edge count** — total import relationships
- **Edge density** (edges / files) — coupling indicator (<2 = loosely coupled, 2-3 = moderate, >4 = tightly coupled)

---

## Phase 1: Structural Skeleton

**Goal:** Map the architecture before reading any source code.

### 1a. Find the entry points

Use `Glob` to find likely entry points:
```
Glob: **/index.ts, **/main.ts, **/entry*.ts, **/worker*.ts, **/server.ts, **/app.ts
```

Exclude `node_modules/` hits. The results are your starting nodes.

### 1b. Dependency tree from every entry point (depth 2)

For each entry point, run:
```
ts_dependency_tree(file: "<entry_point>", depth: 2)
```

Compare the results:
- **File counts** reveal which entry points are heavy orchestrators vs lean workers
- **Overlap** between trees reveals shared infrastructure (files that appear in multiple trees)
- **Disjoint trees** reveal isolated subsystems that don't talk to each other

Record: Which entry point is the "main" one (highest file count)? Which are satellites?

### 1c. Import cycles — find the tangles

```
ts_import_cycles()
```

This is the single most important diagnostic call. Record:
- **Cycle count** — 0 is pristine, 1-3 is normal, 10+ indicates structural problems
- **Cycle locations** — which directories/modules participate in cycles?
- **Cycle sizes** — 2-file cycles are usually intentional; 5+ file cycles are usually accidental

Cycles are places where you cannot reason about files independently. They're the first thing to understand and the last thing to refactor.

### 1d. Cross-boundary isolation — do the intended boundaries hold?

For each pair of entry points/apps that seem like they *should* be independent, run:
```
ts_shortest_path(from: "<app_a_entry>", to: "<app_b_entry>")
```

A `null` result proves compile-time isolation. A non-null result reveals the chain of imports that violates the intended boundary. This is architectural assertion testing.

**Checkpoint:** You now know the shape of the architecture — how many subsystems, how coupled they are, where the tangles are, and whether boundaries hold. You haven't read a single line of source code.

---

## Phase 2: Module Anatomy

**Goal:** Understand what each major module provides and how it connects to others.

### 2a. Identify high-fanout infrastructure files

From Phase 1, note files that appeared in multiple dependency trees. These are shared infrastructure. Common examples: schema files, type definitions, barrel exports, utility modules.

For each, run:
```
ts_dependents(file: "<shared_file>", depth: 1)
```

Files with 20+ direct dependents are **foundational types** — changing them affects everything. Files with 2-3 dependents are **focused utilities**. This ranking tells you which files to understand first and which to treat with extreme care.

### 2b. Module exports — what does each key file provide?

For every file identified as important (entry points, high-fanout files, files in cycle groups), run:
```
ts_module_exports(file: "<important_file>")
```

Record for each:
- **Export count** — files with 15+ exports may be doing too much
- **Export types** — classes, interfaces, types, constants, functions. A file that exports 8 interfaces is a contract definition. A file that exports 8 constants is a configuration. A file that exports a mix of class + error + test layer is a service module.
- **Naming patterns** — do exports follow consistent naming (`*Service`, `*Error`, `*Test`, `*Live`)? Consistency across files is evidence of intentional patterns.

### 2c. Module boundaries — how coupled are directories?

Identify 3-5 directories that look like they should be self-contained modules (e.g., `services/billing/`, `providers/email/`, `middleware/`).

For each, list the files in the directory and run:
```
ts_module_boundary(files: ["<dir>/file1.ts", "<dir>/file2.ts", ...])
```

Record:
- **Isolation score** — 0.0 = zero isolation (everything flows through), 1.0 = perfectly encapsulated
- **Incoming edges** — who depends on this module? (consumers)
- **Outgoing edges** — what does this module depend on? (dependencies)
- **Shared dependencies** — what do files in this module have in common?

A module with many incoming edges and few outgoing edges is a **provider** (depended upon, depends on little).
A module with few incoming edges and many outgoing edges is a **consumer/orchestrator** (depends on everything, nothing depends on it).
A module with many in both directions is a **coupling hotspot**.

**Checkpoint:** You now know what each module provides, how they connect, and which are providers vs consumers vs hotspots.

---

## Phase 3: Pattern Discovery

**Goal:** Determine which patterns are intentional conventions vs one-off occurrences.

### 3a. Consistency analysis across files in the same role

Pick a "role" — e.g., all files named `*Service.ts`, or all files in a `services/` directory. Run `ts_module_exports` on 4-5 of them.

Compare the export shapes:
- Do they all export `[Name]`, `[Name]Error`, `[Name]Test`? → Intentional service pattern
- Do they all export a `Layer.Layer<...>` factory? → Intentional DI pattern
- Does one file export 5 symbols while others export 15? → The outlier is either newer, older, or doing something different

### 3b. Pattern prevalence via navigate_to

For suspected patterns, use `ts_navigate_to` to measure prevalence:
```
ts_navigate_to(symbol: "Layer")         // How pervasive is DI?
ts_navigate_to(symbol: "Error")         // How many typed errors exist?
ts_navigate_to(symbol: "Test")          // How many test doubles exist?
ts_navigate_to(symbol: "Live")          // How many live implementations?
ts_navigate_to(symbol: "Repository")    // Is there a repository pattern?
```

High counts (20+) across many files = intentional, project-wide convention.
Low counts (2-3) in one directory = localized experiment or one-off.

### 3c. Test layer coverage — which services are testable?

If the project uses a DI pattern (Effect Layers, classes with interfaces, etc.), check whether test implementations exist alongside production ones.

For each service file found in 3a:
```
ts_module_exports(file: "<service_file>")
```

Look for paired exports: `ServiceLive` + `ServiceTest`, or `Service` + `Service.Test`. Services with test layers are intentionally designed for testability. Services without them may be legacy, trivial, or undertested.

**Checkpoint:** You can now distinguish intentional patterns from accidental ones, and you know which conventions are project-wide vs localized.

---

## Phase 4: Dead Code Detection

**Goal:** Identify exports that nothing uses and files that nothing imports.

### 4a. Orphan file detection

For every file in directories that seem to have accumulated code over time, run:
```
ts_dependents(file: "<suspect_file>", depth: 0)
```

Files with 0 dependents that are NOT entry points are **orphan files** — nothing imports them. They're either:
- Dead code (most likely)
- Dynamically imported (check for `import()` expressions)
- Entry points not recognized by the build system
- Test files (which typically have 0 dependents by nature — filter these out)

### 4b. Dead export detection

For files with 0 dependents, you're done — the whole file is dead. For files that ARE imported, check for partially dead exports.

Take high-export files from Phase 2b (those with 10+ exports) and run:
```
ts_references(file: "<file>", symbol: "<exported_symbol>")
```

...for each export. Exports with 0-1 references (only the export itself) are dead exports. This is tedious for large files, so prioritize:
- Files that feel overstuffed (15+ exports)
- Barrel/index files (which may re-export symbols nothing actually uses)
- Files in directories flagged as potentially stale

### 4c. Barrel file audit

Barrel files (`index.ts` that re-export from submodules) often accumulate dead re-exports. Run `ts_module_exports` on each barrel, then spot-check with `ts_references` on exports that seem obscure or oddly named.

**Checkpoint:** You have a list of confirmed dead files and dead exports that can be safely removed.

---

## Phase 5: Domain Topology

**Goal:** Understand the business domain from the code structure.

### 5a. Entity identification from schema/type files

Find schema or type definition files:
```
Glob: **/schemas/*.ts, **/types/*.ts, **/models/*.ts, **/domain/*.ts
```

Run `ts_module_exports` on each. The exported type/interface names *are* the domain vocabulary: `User`, `Tenant`, `Todo`, `Invoice`, `Subscription`, etc.

### 5b. Entity relationship mapping via dependency_tree

For each domain entity's primary service file, run:
```
ts_dependency_tree(file: "<entity_service>", depth: 1)
```

The direct dependencies reveal domain relationships:
- `TodoShareService` depends on `AddressService` and `ClaimTokenService` → sharing requires addresses and tokens
- `BillingService` depends on `CoreApiClient` and `StripeCheckoutClient` → billing bridges internal data with an external API
- `NotificationService` depends on `EmailProvider` and `SmsProvider` → notifications are multi-channel

Draw a mental graph: entities are nodes, service-to-service imports are edges. This is the domain topology.

### 5c. Domain boundary verification

For domain areas that seem like they should be independent (e.g., billing vs notifications, auth vs todo), run:
```
ts_shortest_path(from: "<domain_a_service>", to: "<domain_b_service>")
```

Null = truly independent domains. A path = one domain depends on the other (and the path shows exactly how).

### 5d. Entity access patterns via blast_radius

For the central domain entity (usually a `User`, `Account`, or core API client), run:
```
ts_blast_radius(file: "<entity_file>", symbol: "<EntityName>")
```

The caller list, grouped by file, shows which parts of the system access the entity and how. Middleware files accessing it = access control. Handler files = API surface. Service files = business logic. This reveals the entity's role in the system better than reading its definition.

**Checkpoint:** You understand the domain model, entity relationships, and which domains are coupled vs independent — derived entirely from code structure.

---

## Phase 6: Runtime Behavior Approximation

**Goal:** Trace likely execution paths from external inputs to internal effects.

### 6a. Request flow tracing

For each RPC/HTTP handler or API route, run:
```
ts_trace_chain(file: "<handler_file>", symbol: "<HandlerOrRouteGroup>")
```

This follows go-to-definition hops from the handler to its dependencies, building an approximation of the call chain. Each hop = one layer of indirection.

Shallow chains (1-2 hops) = thin handlers that delegate directly to services.
Deep chains (4-5 hops) = layered architecture with middleware, decorators, or adapters.

### 6b. Layer composition analysis

For the main entry point / composition root (typically the file with the most Phase 1 dependencies), run:
```
ts_module_exports(file: "<composition_root>")
```

Then for each exported Layer or provider, use `ts_trace_chain` to see what it wires together. In DI-heavy codebases, the Layer/provider composition *is* the runtime wiring — following the chain tells you exactly what services are live.

### 6c. Service implementation mapping

For every service *interface* file, use `ts_navigate_to` to find its implementations:
```
ts_navigate_to(symbol: "<ServiceName>Live")
ts_navigate_to(symbol: "<ServiceName>Test")
```

This reveals:
- How many implementations exist per interface (1 = standard, 2+ = strategy pattern or platform-specific)
- Which services have test doubles (intentionally testable) vs which don't (may rely on integration tests)
- Where implementations live relative to interfaces (same package = co-located, different app = platform-specific)

### 6d. Queue/event handler discovery

For async or event-driven systems, find queue consumers, event handlers, or scheduled jobs:
```
Glob: **/jobs/*.ts, **/handlers/*.ts, **/consumers/*.ts, **/workers/*.ts
```

Run `ts_dependency_tree(depth: 1)` on each. Their dependencies reveal what domain logic is triggered asynchronously vs synchronously. Services that appear in both HTTP handler trees AND job handler trees participate in both synchronous and async paths.

### 6e. Feature flag / conditional path detection

This is the hardest to detect statically. Use `Grep` for common patterns:
```
Grep: "feature", "flag", "toggle", "experiment", "enabled", "FF_", "FEATURE_"
```

Then for any files found, use `ts_dependents` to see how far the conditional reaches. A feature flag in a leaf file affects one path. A feature flag in a service depended on by 15 files affects many paths.

**Checkpoint:** You have traced the likely runtime paths from external inputs through handlers to services to data, identified async vs sync processing, and flagged feature-gated code.

---

## Phase 7: Risk Assessment

**Goal:** Before making any changes, know where the risk concentrates.

### 7a. Blast radius ranking

For the top 5-10 most-referenced symbols discovered in earlier phases, run:
```
ts_blast_radius(file: "<file>", symbol: "<symbol>")
```

Sort by `filesAffected`. The top 5 are your highest-risk changes. Plan these carefully, test extensively, and consider backwards-compatible migration strategies.

### 7b. Dependency inversion check

For high-risk symbols, check if the coupling goes through an abstraction:
```
ts_dependents(file: "<interface_file>", depth: 1)
ts_dependents(file: "<implementation_file>", depth: 1)
```

If dependents point to the *interface* file (not the implementation), the system is properly inverted — you can change implementations without affecting consumers. If dependents point to the *implementation* directly, changing it will break callers.

### 7c. Change propagation preview

For a planned change, combine tools:
1. `ts_blast_radius` — who references this symbol?
2. `ts_dependents` on the file — who imports this file?
3. `ts_module_boundary` on the affected directory — how does this change propagate to the module boundary?

This three-tool sequence gives you a complete picture: direct references (blast_radius), file-level impact (dependents), and module-level impact (boundary).

---

## Report Format

Write the report to `<project_root>/typegraph-exploration-report.md` using this structure:

```markdown
# Codebase Exploration Report
> Generated: <date>
> Project: <project_root>
> Files: <count> | Edges: <count> | Density: <ratio>

## Executive Summary
<!-- 3-5 bullet points: the most important findings across all phases -->

## Phase 1: Structural Skeleton
### Entry Points
### Import Cycles
### Boundary Verification
### Checkpoint

## Phase 2: Module Anatomy
### High-Fanout Files
### Module Export Profiles
### Module Boundaries
### Checkpoint

## Phase 3: Pattern Discovery
### Consistency Analysis
### Pattern Prevalence
### Test Layer Coverage
### Checkpoint

## Phase 4: Dead Code Detection
### Orphan Files
### Dead Exports
### Barrel File Audit
### Checkpoint

## Phase 5: Domain Topology
### Domain Vocabulary
### Entity Relationships
### Domain Independence
### Entity Access Patterns
### Checkpoint

## Phase 6: Runtime Behavior Approximation
### Request Flow Traces
### Layer Composition
### Implementation Map
### Async Paths
### Feature Flags
### Checkpoint

## Phase 7: Risk Assessment
### Blast Radius Ranking
### Dependency Inversion Health
### Change Propagation Hotspots
### Checkpoint

## Appendix: Raw Data
<!-- Full tool outputs under <details> tags -->
```

Guidelines:
- Include actual numbers, file paths, and tool outputs — not vague summaries
- Use tables for structured data (blast radius rankings, module boundaries, etc.)
- Add a "Notable Findings" subsection after any checkpoint where something unexpected appeared
- Put verbose raw tool outputs in the Appendix under `<details>` tags to keep the main report scannable
- Write the Executive Summary last, after all phases complete

## Quick Reference

| Phase | Tools | Answers |
|-------|-------|---------|
| 1. Skeleton | `dependency_tree`, `import_cycles`, `shortest_path` | Architecture shape, boundaries, tangles |
| 2. Anatomy | `dependents`, `module_exports`, `module_boundary` | What modules provide, how they connect |
| 3. Patterns | `module_exports` (comparative), `navigate_to` | Intentional vs accidental conventions |
| 4. Dead Code | `dependents` (0 check), `references` (per export) | Orphan files, dead exports |
| 5. Domain | `dependency_tree`, `shortest_path`, `blast_radius` | Entity relationships, domain topology |
| 6. Runtime | `trace_chain`, `navigate_to`, `dependency_tree` | Execution paths, wiring, async flows |
| 7. Risk | `blast_radius`, `dependents`, `module_boundary` | Change impact, coupling direction |
