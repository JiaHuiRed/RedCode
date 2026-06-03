---
name: dependency-audit
description: Audit module dependencies to find circular imports, analyze coupling, and understand dependency structure. Trigger when asking about circular deps, module structure, package coupling, or evaluating module boundaries.
---

# Dependency Audit Workflow

Audit module dependencies to find circular imports, analyze coupling, and understand the dependency structure.

## When to Activate

- User asks about circular dependencies or import cycles
- User wants to understand the module structure or dependency graph
- User asks about coupling between packages or modules
- Debugging import-related issues (circular deps, missing exports)
- Evaluating module boundaries for extraction or reorganization

## Workflow

### Step 1: Detect Cycles
Call `ts_import_cycles` (no filter for project-wide, or with a file/package filter for targeted analysis).

### Step 2: Analyze Hotspots
For each cycle found, call `ts_dependency_tree` on the files in the cycle to understand why the cycle exists (what each file needs from the other).

### Step 3: Measure Coupling
Call `ts_module_boundary` on the package or directory you want to analyze. The isolation score quantifies how self-contained it is:
- **> 0.7**: Well isolated
- **0.3 - 0.7**: Moderate coupling
- **< 0.3**: Tightly coupled (candidate for restructuring)

### Step 4: Map Cross-Package Dependencies
Call `ts_dependents` on key files to see the cross-package dependency picture. The `byPackage` grouping shows which packages depend on what.

### Step 5: Report
Present findings as:
1. **Cycles found** (count + file lists)
2. **Coupling scores** (per module/directory)
3. **Cross-package dependencies** (dependency direction violations, if any)
4. **Recommendations** (break cycles, reduce coupling, extract modules)

## Example

```
User: "Are there any circular dependencies in the project?"

1. ts_import_cycles() -> 1 cycle: TodoService.ts <-> TodoHistoryService.ts
2. ts_dependency_tree({ file: "TodoService.ts" }) -> imports TodoHistoryService for history recording
   ts_dependency_tree({ file: "TodoHistoryService.ts" }) -> imports TodoService for status lookup
3. ts_module_boundary({ files: [services directory files] }) -> isolation: 0.42 (moderate)

Report: 1 circular dependency found between TodoService and TodoHistoryService.
        Root cause: mutual dependency for history recording + status lookup.
        Recommendation: Extract shared types into a separate file to break the cycle.
```
