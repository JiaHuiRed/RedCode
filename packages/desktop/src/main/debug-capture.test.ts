import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  captureResourceSnapshot,
  collectEvent2004,
  collectSource,
  CRASH_LOG_SCOPES,
  EVENT_LOG_MAX_BYTES,
  EVENT_LOG_MAX_EVENTS,
  EVENT_LOG_TIMEOUT_MS,
  MAX_EXPORT_FILE_SIZE,
  MAX_EXPORT_FILES,
  MAX_EXPORT_SCAN_ENTRIES,
  MAX_EXPORT_TOTAL_BYTES,
  readEntrySafely,
  reserveBudget,
  serverLogRoots,
  uniqueArchiveName,
} from "./debug-capture"

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "redcode-debug-capture-"))
  dirs.push(dir)
  return dir
}

test("server log roots prefer core Global.Path.log while retaining legacy roots", () => {
  expect(serverLogRoots("C:/home/.redcode/data/log", "C:/app-data", "C:/legacy")).toEqual([
    "C:/home/.redcode/data/log",
    join("C:/app-data", "redcode", "log"),
    "C:/legacy",
  ])
})

test("crash report scopes include the window log", () => {
  expect(CRASH_LOG_SCOPES).toContain("window")
})

test("source collection reports missing, old, large, excluded and unsafe names", () => {
  const root = tempDir()
  const budget = { files: 0, bytes: 0, visited: 0 }
  const oldFile = join(root, "old.log")
  writeFileSync(oldFile, "old")
  utimesSync(oldFile, 1, 1)
  mkdirSync(join(root, "nested"))
  writeFileSync(join(root, "nested", "secret.heapsnapshot"), "not exported")
  writeFileSync(join(root, "nested", "window log.log"), "included")
  const largeFile = join(root, "large.log")
  writeFileSync(largeFile, "")
  truncateSync(largeFile, MAX_EXPORT_FILE_SIZE + 1)

  const result = collectSource(root, "server:1", budget, Date.now())
  expect(result.entries.map((entry) => entry.name)).toEqual(["server_1/nested/window_log.log"])
  expect(result.status.skipped).toEqual({
    "outside-time-window": 1,
    "over-size-limit": 1,
    "sensitive-heapsnapshot-excluded": 1,
  })
  expect(collectSource(join(root, "missing"), "missing", { files: 0, bytes: 0, visited: 0 }).status.error).toBe("missing")
})

test("archive names are unique case-insensitively after sanitizing collisions", () => {
  const used = new Set<string>()
  expect(uniqueArchiveName("logs/a_b.log", used)).toBe("logs/a_b.log")
  expect(uniqueArchiveName("logs/A_B.log", used)).toBe("logs/A_B-2.log")
})

test("source collection does not follow directory symlinks or scan past its hard bound", () => {
  const root = tempDir()
  const external = tempDir()
  writeFileSync(join(external, "outside.log"), "must not enter archive")
  symlinkSync(external, join(root, "external"), "junction")
  const linked = collectSource(root, "desktop", { files: 0, bytes: 0, visited: 0 })
  expect(linked.entries).toHaveLength(0)
  expect(linked.status.skipped).toEqual({ "symbolic-link-excluded": 1 })

  const root2 = tempDir()
  writeFileSync(join(root2, "bounded.log"), "not scanned")
  const bounded = collectSource(root2, "desktop", { files: 0, bytes: 0, visited: MAX_EXPORT_SCAN_ENTRIES })
  expect(bounded.entries).toHaveLength(0)
  expect(bounded.status.skipped).toEqual({ "export-budget-exceeded": 1 })
})

test("export budget enforces hard file and aggregate byte limits", () => {
  expect(reserveBudget({ files: MAX_EXPORT_FILES - 1, bytes: 0, visited: 0 }, 1)).toBe(true)
  expect(reserveBudget({ files: MAX_EXPORT_FILES, bytes: 0, visited: 0 }, 1)).toBe(false)
  expect(reserveBudget({ files: 0, bytes: MAX_EXPORT_TOTAL_BYTES, visited: 0 }, 1)).toBe(false)
})

test("resource snapshot records byte-converted app metrics and physical-memory caveat", () => {
  const snapshot = captureResourceSnapshot(
    [{ pid: 123, type: "GPU", memory: { workingSetSize: 12, privateBytes: 3456 } }],
    { freePhysicalMemory: 100, totalPhysicalMemory: 200 },
  )
  expect(snapshot.processes).toEqual([
    { pid: 123, type: "GPU", workingSetSizeBytes: 12 * 1024, privateMemoryBytes: 3456 * 1024 },
  ])
  expect(snapshot.system).toEqual({
    freePhysicalMemoryBytes: 100,
    totalPhysicalMemoryBytes: 200,
    note: "Physical memory values are not system commit charge.",
  })
})

test("collected entry disappearance is reflected as an unreadable source item", async () => {
  const status = { included: 1, skipped: {} as Record<string, number> }
  await expect(readEntrySafely({ name: "gone.log", path: join(tempDir(), "gone.log") }, status)).resolves.toBeUndefined()
  expect(status).toEqual({ included: 0, skipped: { "unreadable: ENOENT": 1 } })
})

test("Event 2004 uses bounded async spawn options, UTF-8, and run-to-export time range", async () => {
  const start = new Date("2026-10-15T12:00:00Z")
  let query = ""
  let options: Record<string, unknown> | undefined
  const result = await collectEvent2004(start, new Date("2026-10-15T13:00:00Z"), "win32", async (script, opts) => {
    query = script
    options = opts
    return JSON.stringify([{ Id: 2004, Message: "内存不足" }])
  })
  expect(query).toContain("-MaxEvents 20")
  expect(query).toContain("2026-10-14T12:00:00.000Z")
  expect(query).toContain("2026-10-15T13:00:00.000Z")
  expect(query).toContain("System.Text.UTF8Encoding")
  expect(query).not.toContain("2026-10-16T13:00:00.000Z")
  expect(options).toEqual({
    timeout: EVENT_LOG_TIMEOUT_MS,
    maxBuffer: EVENT_LOG_MAX_BYTES,
    encoding: "utf8",
    windowsHide: true,
  })
  expect(result).toMatchObject({ status: "included", events: 1 })
  if (result.status === "included") expect(result.data).toContain("内存不足")
  expect(EVENT_LOG_MAX_EVENTS).toBe(20)
})

test("no events returns included empty array", async () => {
  await expect(collectEvent2004(new Date(), new Date(), "win32", async () => "[]")).resolves.toEqual({
    status: "included",
    data: "[]",
    events: 0,
  })
})

test("event count is capped; malformed JSON, oversized output and timeout fail closed", async () => {
  const tooMany = JSON.stringify(Array.from({ length: EVENT_LOG_MAX_EVENTS + 2 }, (_, Id) => ({ Id })))
  const capped = await collectEvent2004(new Date(), new Date(), "win32", async () => tooMany)
  expect(capped).toMatchObject({ status: "included", events: EVENT_LOG_MAX_EVENTS })
  if (capped.status === "included") expect(JSON.parse(capped.data)).toHaveLength(EVENT_LOG_MAX_EVENTS)

  expect(await collectEvent2004(new Date(), new Date(), "win32", async () => "{broken")).toMatchObject({
    status: "failed",
    reason: "query-failed: SyntaxError",
  })
  expect(await collectEvent2004(new Date(), new Date(), "win32", async () => "x".repeat(EVENT_LOG_MAX_BYTES + 1))).toEqual({
    status: "failed",
    reason: "output-limit",
  })
  expect(
    await collectEvent2004(new Date(), new Date(), "win32", async () => {
      throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })
    }),
  ).toEqual({ status: "failed", reason: "query-failed: ETIMEDOUT" })
  expect(await collectEvent2004(new Date(), new Date(), "linux", async () => "[]")).toEqual({
    status: "skipped",
    reason: "not-windows",
  })
})
