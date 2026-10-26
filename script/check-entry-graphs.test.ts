import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  assertWindowsRunnerBootstrapOrder,
  buildStaticGraph,
  evaluateGraphBudget,
  normalizePath,
} from "./check-entry-graphs"

let root: string

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "redcode-entry-graph-test-"))
  await mkdir(path.join(root, "src"), { recursive: true })
  await mkdir(path.join(root, "src", "util"), { recursive: true })
  await writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
  )
  await writeFile(
    path.join(root, "src", "main.ts"),
    [
      'import type { Shape } from "./types"',
      'import type { Ignored } from "external-type-only"',
      'import defaultValue, { type Shape as ReusedShape } from "./default"',
      'import { account } from "./account.sql"',
      'import { first } from "@/first"',
      'export { second } from "./second"',
      'export type { Shape as TypeOnlyExport } from "./type-only-export"',
      'const required = require("./required")',
      'const external = require("node:assert")',
      'import("./deferred")',
      "void (account + (defaultValue as Shape | ReusedShape | Ignored | TypeOnlyExport | null))",
      "void required",
      "void external",
    ].join("\n"),
  )
  await writeFile(path.join(root, "src", "first.ts"), 'import "./second"\nexport const first = 1\n')
  await writeFile(path.join(root, "src", "second.ts"), 'export { first } from "./first"\nexport const second = 2\n')
  await writeFile(path.join(root, "src", "types.ts"), "export type Shape = { value: string }\n")
  await writeFile(path.join(root, "src", "default.ts"), "export default 1\n")
  await writeFile(path.join(root, "src", "account.sql.ts"), "export const account = 1\n")
  await writeFile(path.join(root, "src", "type-only-export.ts"), "export type Shape = { value: string }\n")
  await writeFile(path.join(root, "src", "required.ts"), "export const required = true\n")
  await writeFile(path.join(root, "src", "deferred.ts"), "export const later = true\n")
  await writeFile(path.join(root, "src", "isolated-entry.ts"), 'import { only } from "@/alias-only"\nvoid only\n')
  await writeFile(path.join(root, "src", "alias-only.ts"), "export const only = 1\n")
  await writeFile(
    path.join(root, "src", "guarded-static.ts"),
    [
      'if (process.env.REDCODE_WINDOWS_JOB_RUNNER === "1") {',
      '  await import("./util/windows-job-runner")',
      "  process.exit()",
      "}",
      'import "heavy-after-guard"',
    ].join("\n"),
  )
  await writeFile(path.join(root, "src", "util", "windows-job-runner.ts"), "export const runner = true\n")
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

function graphOptions() {
  return {
    rootDir: root,
    workspacePackages: [],
  }
}

test("counts value imports and re-exports, excludes type-only and deduplicates cycles", () => {
  const graph = buildStaticGraph(path.join(root, "src", "main.ts"), graphOptions())

  expect(graph.files.map((file) => path.basename(file)).sort()).toEqual([
    "account.sql.ts",
    "default.ts",
    "first.ts",
    "main.ts",
    "required.ts",
    "second.ts",
  ])
  expect(graph.dynamicImports).toHaveLength(1)
  expect(graph.dynamicImports[0]).toContain("deferred.ts")
  expect(graph.externalImports).toEqual(["node:assert"])
})

test("runner guard is the first runtime statement but allows later dynamic imports", () => {
  const guard = `if (process.env.REDCODE_WINDOWS_JOB_RUNNER === "1") {
  await import("./util/windows-job-runner")
  process.exit()
}`

  expect(() => assertWindowsRunnerBootstrapOrder(`await import("./early")\n${guard}`)).toThrow(/runtime evaluation/)
  expect(() =>
    assertWindowsRunnerBootstrapOrder(`import type { X } from "./types"\n${guard}\nawait import("./later")`),
  ).not.toThrow()
  // 261026 Red 静态值 import 会被 ESM 提升到 guard 之前，必须当场拒绝，不能跳过放行。
  expect(() => assertWindowsRunnerBootstrapOrder(`import "heavy"\n${guard}`)).toThrow(/statically import/)
  expect(() => assertWindowsRunnerBootstrapOrder(guard.replace('"1"', '"0"'))).toThrow(/runtime evaluation/)
})

test("rejects over-budget graphs and forbidden modules", () => {
  const graph = buildStaticGraph(path.join(root, "src", "main.ts"), graphOptions())
  const result = evaluateGraphBudget(graph, {
    name: "fixture",
    entry: "src/main.ts",
    maxFiles: 2,
    forbid: ["src/second.ts"],
    allowedExternal: ["node:assert"],
  })

  expect(result.passed).toBe(false)
  expect(result.violations).toHaveLength(2)
})

test("resolves a source reachable only through a configured path alias", () => {
  const graph = buildStaticGraph(path.join(root, "src", "isolated-entry.ts"), graphOptions())
  expect(graph.files.map((file) => path.basename(file)).sort()).toEqual(["alias-only.ts", "isolated-entry.ts"])
})

test("budgets static external imports after the startup guard", () => {
  const entry = path.join(root, "src", "guarded-static.ts")
  assertWindowsRunnerBootstrapOrder(readFileSync(entry, "utf8"))
  const graph = buildStaticGraph(entry, graphOptions())
  const result = evaluateGraphBudget(graph, {
    name: "fixture",
    entry: "src/guarded-static.ts",
    maxFiles: 1,
    forbid: [],
    allowedExternal: [],
  })

  expect(graph.externalImports).toEqual(["heavy-after-guard"])
  expect(result.passed).toBe(false)
  expect(result.violations).toContain("fixture includes disallowed external import heavy-after-guard")
})

test("rejects external imports outside the configured allowlist", () => {
  const graph = buildStaticGraph(path.join(root, "src", "main.ts"), graphOptions())
  expect(
    evaluateGraphBudget(graph, {
      name: "fixture",
      entry: "src/main.ts",
      maxFiles: 6,
      forbid: [],
      allowedExternal: [],
    }).violations,
  ).toContain("fixture includes disallowed external import node:assert")
})

test("fails on unresolved local imports instead of dropping the edge", async () => {
  const entry = path.join(root, "src", "broken.ts")
  await writeFile(entry, 'import "./missing"\n')

  expect(() => buildStaticGraph(entry, graphOptions())).toThrow(/unresolved local import/)

  const brokenAlias = path.join(root, "src", "broken-alias.ts")
  await writeFile(brokenAlias, 'import "@/missing"\n')
  expect(() => buildStaticGraph(brokenAlias, graphOptions())).toThrow(/unresolved local import/)
})

test("normalizes Windows separators and case for graph identity", () => {
  expect(normalizePath("C:\\Repo\\packages\\opencode\\src\\index.ts", "win32")).toBe(
    "c:/repo/packages/opencode/src/index.ts",
  )
})
