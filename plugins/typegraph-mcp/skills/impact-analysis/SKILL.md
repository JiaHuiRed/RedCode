---
name: impact-analysis
description: Analyze the impact of changing a TypeScript symbol by combining blast radius, dependents, and module boundary analysis. Trigger when asking what will break, assessing change risk, or before modifying widely-used symbols.
---

# Impact Analysis Workflow

Analyze the impact of changing a TypeScript symbol by combining blast radius, dependents, and module boundary analysis.

## When to Activate

- User asks "what will break if I change X?"
- User asks about the impact or blast radius of a change
- Before modifying a widely-used symbol, type, or interface
- Assessing risk of a refactor

## Workflow

### Step 1: Blast Radius
Call `ts_blast_radius` with the file and symbol to get direct callers and affected files.

### Step 2: Assess Scope
- If **< 5 callers**: Low impact. Report the callers and you're done.
- If **5-20 callers**: Medium impact. Proceed to step 3 for package breakdown.
- If **> 20 callers**: High impact. Proceed to steps 3 and 4.

### Step 3: Package Breakdown
Call `ts_dependents` on the file to see the transitive impact grouped by package. This shows whether the change is contained to one package or crosses boundaries.

### Step 4: Module Boundary (for high-impact changes)
Call `ts_module_boundary` with the affected files to understand the coupling. A low isolation score means the change is tightly coupled to external code.

### Step 5: Report
Present findings as:
1. **Direct callers** (count + file list)
2. **Packages affected** (from dependents breakdown)
3. **Risk assessment** (low/medium/high based on caller count and cross-package spread)
4. **Suggested approach** (safe migration steps if high impact)

## Example

```
User: "What happens if I change the TenantId schema?"

1. ts_blast_radius({ file: "packages/core/src/schemas/ids.ts", symbol: "TenantId" })
   -> 45 direct callers across 28 files

2. ts_dependents({ file: "packages/core/src/schemas/ids.ts" })
   -> 158 transitive dependents across 4 packages

3. ts_module_boundary({ files: ["packages/core/src/schemas/ids.ts"] })
   -> isolation score: 0.058 (highly coupled)

Report: HIGH IMPACT. 45 direct usages across 28 files in 4 packages.
        The schemas module has very low isolation (0.058).
        Recommend: add new schema alongside old, migrate callers incrementally, then remove old.
```
