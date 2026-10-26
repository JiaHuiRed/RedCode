#!/usr/bin/env bun

import { existsSync, readFileSync, realpathSync, readdirSync } from "node:fs"
import path from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { createScanner, SyntaxKind } from "typescript/unstable/ast"

type WorkspacePackage = {
  name: string
}
const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
  js: new Bun.Transpiler({ loader: "js" }),
  jsx: new Bun.Transpiler({ loader: "jsx" }),
}

function transpilerFor(filePath: string) {
  const extension = path.extname(filePath).toLowerCase()
  return extension === ".tsx"
    ? transpilers.tsx
    : extension === ".jsx"
      ? transpilers.jsx
      : [".js", ".mjs", ".cjs"].includes(extension)
        ? transpilers.js
        : transpilers.ts
}

type EntryBudget = {
  name: string
  entry: string
  maxFiles: number
  forbid: string[]
  allowedExternal: string[]
  startupGuard?: "windows-job-runner"
}

type StartupDefaults = {
  warmup: number
  runs: number
  timeoutMs: number
  probeTimeoutMs: number
  pollIntervalMs: number
  cliEntry: string
  cliArgs: string[]
  serverEntry: string
  serverArgs: string[]
  healthPath: string
}

type BudgetConfig = {
  version: 1
  entries: EntryBudget[]
  startup: StartupDefaults
}

export type EntryGraph = {
  entry: string
  files: string[]
  dynamicImports: string[]
  externalImports: string[]
}

type GraphOptions = {
  rootDir: string
  workspacePackages: WorkspacePackage[]
}

export function normalizePath(value: string, platform = process.platform) {
  const normalized = platform === "win32" ? path.win32.normalize(value) : path.posix.normalize(value.replaceAll("\\", "/"))
  const forward = normalized.replaceAll("\\", "/")
  return platform === "win32" ? forward.toLowerCase() : forward
}

function sourceFile(file: string) {
  return /\.(?:[cm]?[jt]sx?)$/i.test(file) && !/\.d\.[cm]?ts$/i.test(file)
}

function isWithin(root: string, file: string) {
  const relative = path.relative(root, file)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function repoPath(root: string, file: string) {
  return path.relative(root, file).replaceAll("\\", "/")
}

function isPathAlias(specifier: string, aliases: string[]) {
  return aliases.some((pattern) => {
    const wildcard = pattern.indexOf("*")
    if (wildcard < 0) return specifier === pattern
    const prefix = pattern.slice(0, wildcard)
    const suffix = pattern.slice(wildcard + 1)
    return specifier.startsWith(prefix) && specifier.endsWith(suffix)
  })
}

function aliasesFor(file: string, root: string, cache: Map<string, string[]>) {
  for (let directory = path.dirname(file); isWithin(root, directory); directory = path.dirname(directory)) {
    const configPath = path.join(directory, "tsconfig.json")
    if (existsSync(configPath)) {
      const cached = cache.get(configPath)
      if (cached) return cached
      const config = object(parseJsonc(readFileSync(configPath, "utf8")), `tsconfig ${configPath}`)
      const compiler = config.compilerOptions === undefined ? {} : object(config.compilerOptions, "compilerOptions")
      const paths = compiler.paths === undefined ? {} : object(compiler.paths, "compilerOptions.paths")
      const aliases = Object.keys(paths)
      cache.set(configPath, aliases)
      return aliases
    }
    if (directory === root) break
  }
  return []
}

function isLocalSpecifier(
  specifier: string,
  containingFile: string,
  root: string,
  options: GraphOptions,
  aliasCache: Map<string, string[]>,
) {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    path.win32.isAbsolute(specifier) ||
    isPathAlias(specifier, aliasesFor(containingFile, root, aliasCache))
  )
    return true
  return options.workspacePackages.some((workspace) => specifier === workspace.name || specifier.startsWith(`${workspace.name}/`))
}

function isWorkspaceSource(file: string, root: string) {
  if (!sourceFile(file) || !isWithin(root, file)) return false
  return !file.split(path.sep).some((part) => part.toLowerCase() === "node_modules")
}

function realPath(file: string) {
  try {
    return realpathSync.native(file)
  } catch {
    // 261026 Red Keep a missing path intact so the graph boundary reports the unresolved source.
    return path.resolve(file)
  }
}

function scannerTokens(sourceText: string) {
  const scanner = createScanner(true, undefined, transpilers.ts.transformSync(sourceText))
  const tokens: string[] = []
  let kind = scanner.scan()
  while (kind !== SyntaxKind.EndOfFile) {
    tokens.push(kind === SyntaxKind.StringLiteral ? scanner.getTokenValue() : scanner.getTokenText())
    kind = scanner.scan()
  }
  return tokens
}

function localResolution(
  specifier: string,
  containingFile: string,
  root: string,
  options: GraphOptions,
  aliasCache: Map<string, string[]>,
) {
  const isLocal = isLocalSpecifier(specifier, containingFile, root, options, aliasCache)
  let resolved: string
  try {
    resolved = Bun.resolveSync(specifier, path.dirname(containingFile))
  } catch (error) {
    if (isLocal)
      throw new Error(`unresolved local import "${specifier}" from ${repoPath(root, containingFile)}`, { cause: error })
    return undefined
  }
  if ((!path.isAbsolute(resolved) && !path.win32.isAbsolute(resolved)) && isLocal)
    throw new Error(`unresolved local import "${specifier}" from ${repoPath(root, containingFile)}`)
  return resolved
}

export function assertWindowsRunnerBootstrapOrder(sourceText: string) {
  const actual = scannerTokens(sourceText)
  // 261026 Red ESM 静态值 import 在模块体执行前求值，摆在 guard 之前等于让 guard 失效
  // （2026-09-11 那次每进程 219MB 的事故形态）。type-only import 已被 transformSync 擦除，
  // 这里剩下的 import 一定是值 import，`import.meta` 用 "." 区分。不许静默跳过。
  if (actual[0] === "import" && actual[1] !== "(" && actual[1] !== ".")
    throw new Error("index entry must not statically import before the windows runner guard")
  const expected = scannerTokens(
    'if (process.env.REDCODE_WINDOWS_JOB_RUNNER === "1") { await import("./util/windows-job-runner"); process.exit(); }',
  )
  if (actual.slice(0, expected.length).join("\0") !== expected.join("\0"))
    throw new Error("index entry must begin runtime evaluation with the windows runner guard")
}

export function buildStaticGraph(entryPath: string, options: GraphOptions): EntryGraph {
  const root = realPath(path.resolve(options.rootDir))
  const entry = realPath(path.resolve(entryPath))
  if (!isWithin(root, entry) || !isWorkspaceSource(entry, root))
    throw new Error(`entry is not a workspace source file: ${entryPath}`)

  const visited = new Set<string>()
  const files = new Map<string, string>()
  const dynamicImports = new Set<string>()
  const externalImports = new Set<string>()
  const aliasCache = new Map<string, string[]>()
  const visit = (file: string) => {
    const canonical = realPath(file)
    const key = normalizePath(canonical)
    if (visited.has(key)) return
    visited.add(key)
    if (!isWorkspaceSource(canonical, root)) return
    files.set(key, canonical)

    const source = readFileSync(canonical, "utf8")
    for (const item of transpilerFor(canonical).scanImports(source)) {
      const isDynamic = item.kind === "dynamic-import"
      const resolved = localResolution(item.path, canonical, root, options, aliasCache)
      if (!resolved) {
        if (!isDynamic) externalImports.add(item.path)
        continue
      }
      if (!path.isAbsolute(resolved) && !path.win32.isAbsolute(resolved)) {
        if (!isDynamic) externalImports.add(item.path)
        continue
      }
      const target = realPath(resolved)
      if (!isWorkspaceSource(target, root)) {
        if (!isDynamic) externalImports.add(item.path)
        continue
      }
      if (isDynamic) {
        dynamicImports.add(repoPath(root, target))
        continue
      }
      visit(target)
    }
  }

  visit(entry)
  return {
    entry: repoPath(root, entry),
    files: [...files.values()].map((file) => repoPath(root, file)).sort(),
    dynamicImports: [...dynamicImports].sort(),
    externalImports: [...externalImports].sort(),
  }
}

export function evaluateGraphBudget(graph: EntryGraph, budget: EntryBudget) {
  const violations: string[] = []
  if (graph.files.length > budget.maxFiles)
    violations.push(`${budget.name} static files ${graph.files.length} > maxFiles ${budget.maxFiles}`)
  for (const forbidden of budget.forbid) {
    const prefix = forbidden.replaceAll("\\", "/").replace(/\/+$/, "")
    const match = graph.files.find((file) => file === prefix || file.startsWith(`${prefix}/`))
    if (match) violations.push(`${budget.name} includes forbidden source ${match} (forbid ${prefix})`)
  }
  for (const external of graph.externalImports) {
    if (!budget.allowedExternal.includes(external))
      violations.push(`${budget.name} includes disallowed external import ${external}`)
  }
  return { passed: violations.length === 0, violations }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

function nonNegativeInteger(value: unknown, label: string, minimum: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
    throw new Error(`${label} must be an integer >= ${minimum}`)
  return value
}

function repoRelative(value: unknown, label: string) {
  const result = string(value, label).replaceAll("\\", "/")
  if (result.startsWith("/") || /^[a-z]:/i.test(result) || result.split("/").includes(".."))
    throw new Error(`${label} must stay inside the repository`)
  return result
}

function stringArray(value: unknown, label: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0))
    throw new Error(`${label} must be an array of non-empty strings`)
  return value as string[]
}

export function parseBudgetConfig(input: unknown): BudgetConfig {
  const root = object(input, "budget config")
  if (root.version !== 1) throw new Error("budget config version must be 1")
  if (!Array.isArray(root.entries) || root.entries.length === 0) throw new Error("entries must be a non-empty array")
  const names = new Set<string>()
  const entries = root.entries.map((item, index) => {
    const value = object(item, `entries[${index}]`)
    const name = string(value.name, `entries[${index}].name`)
    if (names.has(name)) throw new Error(`duplicate entry name: ${name}`)
    names.add(name)
    const forbid = stringArray(value.forbid, `entries[${index}].forbid`).map((item) =>
      repoRelative(item, `entries[${index}].forbid`),
    )
    const allowedExternal = stringArray(value.allowedExternal, `entries[${index}].allowedExternal`)
    const startupGuard: EntryBudget["startupGuard"] =
      value.startupGuard === "windows-job-runner" ? value.startupGuard : undefined
    if (value.startupGuard !== undefined && startupGuard === undefined)
      throw new Error(`entries[${index}].startupGuard must be windows-job-runner`)
    return {
      name,
      entry: repoRelative(value.entry, `entries[${index}].entry`),
      maxFiles: nonNegativeInteger(value.maxFiles, `entries[${index}].maxFiles`, 1),
      forbid,
      allowedExternal,
      ...(startupGuard === undefined ? {} : { startupGuard }),
    }
  })
  const startup = object(root.startup, "startup")
  const healthPath = string(startup.healthPath, "startup.healthPath")
  if (!healthPath.startsWith("/") || healthPath.startsWith("//") || healthPath.includes("?") || healthPath.includes("#"))
    throw new Error("startup.healthPath must be an absolute path without query or fragment")
  return {
    version: 1,
    entries,
    startup: {
      warmup: nonNegativeInteger(startup.warmup, "startup.warmup", 0),
      runs: nonNegativeInteger(startup.runs, "startup.runs", 1),
      timeoutMs: nonNegativeInteger(startup.timeoutMs, "startup.timeoutMs", 1),
      probeTimeoutMs: nonNegativeInteger(startup.probeTimeoutMs, "startup.probeTimeoutMs", 1),
      pollIntervalMs: nonNegativeInteger(startup.pollIntervalMs, "startup.pollIntervalMs", 1),
      cliEntry: repoRelative(startup.cliEntry, "startup.cliEntry"),
      cliArgs: stringArray(startup.cliArgs, "startup.cliArgs"),
      serverEntry: repoRelative(startup.serverEntry, "startup.serverEntry"),
      serverArgs: stringArray(startup.serverArgs, "startup.serverArgs"),
      healthPath,
    },
  }
}

function workspacePackages(root: string): WorkspacePackage[] {
  const packagesDir = path.join(root, "packages")
  const packageFiles = readdirSync(packagesDir, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => path.join(packagesDir, item.name, "package.json"))
  packageFiles.push(path.join(packagesDir, "sdk", "js", "package.json"))
  const packages: WorkspacePackage[] = []
  for (const file of packageFiles) {
    if (!existsSync(file)) continue
    const packageJson = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
    if (typeof packageJson.name !== "string") continue
    packages.push({ name: packageJson.name })
  }
  return packages
}

function main() {
  const root = path.resolve(import.meta.dir, "..")
  const configPath = path.join(import.meta.dir, "entry-graph-budgets.json")
  const config = parseBudgetConfig(JSON.parse(readFileSync(configPath, "utf8")) as unknown)
  const workspacePackagesForGraph = workspacePackages(root)
  const results: string[] = []
  let failed = false
  for (const budget of config.entries) {
    const entryPath = path.join(root, budget.entry)
    if (budget.startupGuard === "windows-job-runner")
      assertWindowsRunnerBootstrapOrder(readFileSync(entryPath, "utf8"))
    const graph = buildStaticGraph(entryPath, {
      rootDir: root,
      workspacePackages: workspacePackagesForGraph,
    })
    const evaluation = evaluateGraphBudget(graph, budget)
    failed ||= !evaluation.passed
    results.push(
      `${budget.name} entry=${budget.entry} staticFiles=${graph.files.length}/${budget.maxFiles} ` +
        `dynamicTargets=${graph.dynamicImports.length} external=${graph.externalImports.join(",") || "(none)"}`,
    )
    for (const violation of evaluation.violations) results.push(`  BUDGET VIOLATION ${violation}`)
  }
  console.log(results.join("\n"))
  if (failed) process.exitCode = 1
}

if (import.meta.main) main()
