---
description: Run typegraph-mcp health checks to verify setup
argument-hint: [--verbose]
---

# TypeGraph Health Check

Run health checks to verify typegraph-mcp is correctly set up for this project.

## Instructions

1. Run the health check command:

   ```bash
   "__TYPEGRAPH_NODE__" "${CLAUDE_PLUGIN_ROOT}/node_modules/tsx/dist/cli.mjs" "${CLAUDE_PLUGIN_ROOT}/cli.ts" check
   ```

2. Parse the output and report results:
   - Count of passed/failed/warned checks
   - For any failures, highlight the issue and the suggested fix
   - If all checks pass, confirm typegraph-mcp is ready

3. The check verifies: Node.js version, tsx availability, TypeScript installation, tsconfig.json, MCP registration, dependencies, oxc-parser, oxc-resolver, tsserver, module graph, ESLint ignores, and .gitignore configuration.
