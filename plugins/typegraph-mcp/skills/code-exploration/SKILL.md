---
name: code-exploration
description: Efficiently explore unfamiliar TypeScript code using navigation tools instead of reading entire files. Trigger when asking how something works, exploring a new module, understanding architecture, or tracing request flows.
---

# Code Exploration Workflow

Efficiently explore unfamiliar TypeScript code using navigation tools instead of reading entire files.

## When to Activate

- User asks "how does X work?" or "walk me through the code for X"
- Exploring a new codebase or unfamiliar module
- Understanding the architecture or data flow of a feature
- Tracing a request from API handler to database

## Workflow

### Step 1: Find the Entry Point
If you know the symbol name but not the file:
- Call `ts_navigate_to` with the symbol name

If you know the file:
- Call `ts_module_exports` to see what the file provides
- Call `ts_find_symbol` to locate a specific symbol within it

If `ts_module_exports` on a top-level `index.ts` is empty or mostly re-exports:
- Treat it as a barrel, not a dead end
- Pivot to a composition module such as an app entrypoint, router, handler, API module, or service composition root
- Use `ts_dependency_tree` on that composition module to get quick architectural context

### Step 2: Understand the Type
Call `ts_type_info` on the entry point symbol. This gives you the full type signature and documentation without reading the entire file.

### Step 3: Trace the Implementation
Call `ts_trace_chain` to follow the definition chain from the entry point to the implementation. Each hop shows the file, line, and a code preview.

### Step 4: Explore the Neighborhood
Call `ts_subgraph` with the key files discovered in step 3 to see the surrounding module structure. Use `direction: "both"` and `depth: 1` for immediate context.

For a fast system-level read, `ts_dependency_tree` on the composition module often gives a better first picture than reading a barrel file's exports.

### Step 5: Deep Dive Where Needed
Only now, read specific files at the lines identified by the tools. You have precise coordinates — no need to read entire files.

## Key Principle

**Never start by reading entire files.** Use navigation tools to find the exact lines that matter, then read only those lines. This saves context tokens and produces more accurate understanding.

## Example

```
User: "How does the magic link authentication flow work?"

1. ts_navigate_to({ symbol: "MagicLinkHandler" })
   -> Found in apps/core-api/src/entrypoints/magic-link.ts

2. ts_type_info -> Shows handler signature with ClaimToken input, AuthResult output

3. ts_trace_chain -> 4 hops:
   magic-link.ts -> ClaimService.ts -> TokenRepository.ts -> tenant-context.ts

4. ts_subgraph({ files: [those 4 files], depth: 1 })
   -> Shows AuthService and NotificationService also connect to ClaimService

5. Read the specific lines at each hop to explain the flow
```
