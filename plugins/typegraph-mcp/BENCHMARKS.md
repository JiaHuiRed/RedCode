# Benchmarks

Measured on a 440-file TypeScript monorepo (4 apps, 4 packages, 972 import edges). All scenarios were discovered dynamically from the module graph — no hardcoded symbols.

## Token comparison

How many context tokens the agent consumes to answer a query. grep requires reading entire matching files; typegraph returns structured JSON.

| Scenario | Symbol | grep tokens | typegraph tokens | Calls | Reduction |
|---|---|---|---|---|---|
| Barrel re-export resolution | `AwsSesConfig` | 9,880 | 6 | 2 | 99.9% |
| High-fanout symbol lookup | `TenantId` | 125,000 | 7 | 2 | 99.9% |
| Call chain tracing | `AccessMaterializationService` | 53,355 | 4 | 1 | 99.9% |
| Impact analysis | `ids` | 125,000 | 3,373 | 1 | 97.3% |

**Average: 99% token reduction.**

## Latency

Per-tool timing across 5 runs. Test file: `AddressServiceLive.ts` (auto-discovered).

| Tool | p50 | p95 | avg |
|---|---|---|---|
| `ts_find_symbol` | 1.8ms | 3.0ms | 2.0ms |
| `ts_definition` | 0.3ms | 4.5ms | 1.1ms |
| `ts_references` | 13.3ms | 227.3ms | 56.4ms |
| `ts_type_info` | 1.0ms | 4.2ms | 1.7ms |
| `ts_navigate_to` | 32.4ms | 61.9ms | 38.3ms |
| `ts_module_exports` | 1.6ms | 2.2ms | 1.7ms |
| `ts_dependency_tree` | 0.0ms | 0.2ms | 0.1ms |
| `ts_dependents` | 0.0ms | 0.0ms | 0.0ms |
| `ts_import_cycles` | 0.3ms | 0.6ms | 0.3ms |
| `ts_shortest_path` | 0.0ms | 0.1ms | 0.0ms |
| `ts_subgraph` | 0.1ms | 0.3ms | 0.2ms |
| `ts_module_boundary` | 0.2ms | 0.3ms | 0.2ms |

**tsserver queries: 16.9ms avg. Graph queries: 0.1ms avg.**

## Accuracy

| Scenario | grep | typegraph |
|---|---|---|
| **Barrel resolution** — find where `AwsSesConfig` is defined, not re-exported | 13 matches across 6 files. Agent must read each to distinguish definition from re-exports. | Resolves directly to source definition in 1 tool call. |
| **Same-name disambiguation** — distinguish `CoreApiClient` from `CoreApiClientRpcLive`, `CoreApiClientTest`, etc. | 278 matches, 90 of which are variant names sharing the prefix. | 2 exact matches: `CoreApiClient.ts:103` [class], `index.ts:82` [alias]. |
| **Type-only vs runtime imports** — classify imports in a file with both kinds | `grep "import"` shows all imports. Agent must parse each line to check for `import type`. | 1 type-only, 13 runtime — classified automatically by the module graph. |
| **Cross-package impact** — find everything that depends on `ids.ts` | 1,038 matches for "ids". Cannot distinguish direct vs transitive or follow re-exports. | 31 direct, 158 transitive. Broken down by package. |
| **Circular dependency detection** | Impossible with grep. | 1 cycle: `TodoService.ts` <-> `TodoHistoryService.ts`. |

**5/5 typegraph wins.**

## Run your own benchmark

The benchmark is fully dynamic — it discovers scenarios from the module graph, so it works on any TypeScript project:

```bash
npx typegraph-mcp bench
```

In Claude Code: `/typegraph:bench`

Scenarios that can't be found in the target codebase (e.g. no barrel files) are gracefully skipped.
