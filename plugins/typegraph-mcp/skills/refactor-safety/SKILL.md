---
name: refactor-safety
description: Verify a refactor is safe before making changes. Trigger when renaming, moving, or restructuring TypeScript modules, extracting code into new modules, or changing interfaces and service definitions.
---

# Refactor Safety Check Workflow

Verify a refactor is safe before making changes by checking call chains, circular dependencies, and module boundaries.

## When to Activate

- User is about to rename, move, or restructure TypeScript modules
- User asks "is it safe to refactor X?"
- Before extracting code into a new module or package
- Before changing an interface or service definition

## Workflow

### Step 1: Trace the Chain
Call `ts_trace_chain` on the symbol being refactored to understand its full definition chain. This reveals all the layers of indirection the refactor needs to preserve.

### Step 2: Check for Cycles
Call `ts_import_cycles` filtered to the file being refactored. If the file participates in a cycle, the refactor must not break or worsen it.

### Step 3: Assess Boundaries
Call `ts_module_boundary` with the files involved in the refactor (source + destination). Check:
- **Incoming edges**: Other code that imports from these files (must be preserved)
- **Outgoing edges**: Dependencies these files need (must be available at new location)
- **Isolation score**: How self-contained the module is

### Step 4: Verify References
Call `ts_references` on the key symbol to get the complete list of call sites that need updating.

### Step 5: Report
Present a safety assessment:
1. **Definition chain** (what indirection exists)
2. **Cycle involvement** (any circular dependencies to be aware of)
3. **Boundary analysis** (incoming/outgoing edges, isolation)
4. **Call sites to update** (complete list from references)
5. **GO / CAUTION / STOP** recommendation

## Example

```
User: "I want to move AuthService from packages/core to apps/gateway"

1. ts_trace_chain -> AuthService defined in core, consumed via Layer in gateway
2. ts_import_cycles -> No cycles involving AuthService.ts
3. ts_module_boundary -> 12 incoming edges (other core modules import it), 3 outgoing
4. ts_references -> 23 references across 15 files

CAUTION: AuthService has 12 incoming edges within packages/core.
         Moving it to apps/gateway would break the core -> gateway dependency direction.
         Consider: keep the interface in core, move only the Live implementation.
```
