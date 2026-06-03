---
description: Run smoke tests to verify all 14 typegraph-mcp tools work
argument-hint: [--verbose]
---

# TypeGraph Smoke Test

Run smoke tests that exercise all 14 tools against the current project.

## Instructions

1. Run the smoke test command:

   ```bash
   "__TYPEGRAPH_NODE__" "${CLAUDE_PLUGIN_ROOT}/node_modules/tsx/dist/cli.mjs" "${CLAUDE_PLUGIN_ROOT}/cli.ts" test
   ```

2. Parse the output and report results:
   - Total passed/failed/skipped
   - For any failures, report the tool name and what went wrong
   - If all pass, confirm all 14 tools are working

3. Tests dynamically discover a suitable file in the project and exercise: module graph build, dependency_tree, dependents, import_cycles, shortest_path, subgraph, module_boundary, navbar, find_symbol, definition, references, type_info, navigate_to, blast_radius, module_exports, and trace_chain.
