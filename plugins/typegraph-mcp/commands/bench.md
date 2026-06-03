---
description: Run typegraph-mcp benchmarks (token, latency, accuracy)
argument-hint: []
---

# TypeGraph Benchmark

Run benchmarks to measure typegraph-mcp performance on this project.

## Instructions

1. Run the benchmark command:

   ```bash
   "__TYPEGRAPH_NODE__" "${CLAUDE_PLUGIN_ROOT}/node_modules/tsx/dist/cli.mjs" "${CLAUDE_PLUGIN_ROOT}/cli.ts" bench
   ```

2. Parse the output and report results:
   - **Token comparison**: grep tokens vs typegraph tokens per scenario, with reduction percentage
   - **Latency**: p50, p95, and average per tool
   - **Accuracy**: grep vs typegraph for each scenario, with verdict
   - **Summary**: average token reduction, average query latency, accuracy score

3. The benchmark dynamically discovers symbols and scenarios from the project's module graph. Scenarios that don't apply to this codebase are skipped.
