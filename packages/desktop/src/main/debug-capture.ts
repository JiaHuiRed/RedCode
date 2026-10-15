// 261015 Red GUI 崩溃取证补齐（后端日志根/window scope/资源快照/Event 2004/manifest 记账）。
// 决策、备选与实测边界见 docs/notes/implemented/bug-fix/2026-10-15-desktop-debug-capture.md
import { execFile } from "node:child_process"
import { createReadStream, lstatSync, opendirSync } from "node:fs"
import { join, relative } from "node:path"
import { freemem, totalmem } from "node:os"

export const EVENT_LOG_TIMEOUT_MS = 4_000
export const EVENT_LOG_MAX_BYTES = 32 * 1024
export const EVENT_LOG_MAX_EVENTS = 20
export const CRASH_LOG_SCOPES = ["main", "renderer", "server", "utility", "window"] as const
export const MAX_EXPORT_FILES = 1_000
export const MAX_EXPORT_TOTAL_BYTES = 100 * 1024 * 1024
export const MAX_EXPORT_SCAN_ENTRIES = 4_000
export const MAX_EXPORT_FILE_SIZE = 50 * 1024 * 1024
const EXPORT_WINDOW_MS = 24 * 60 * 60 * 1000
const MAX_DIRECTORY_DEPTH = 64

export type CapturedEntry = { name: string; path?: string; data?: Buffer }
export type SourceStatus = {
  path: string
  included: number
  skipped: Record<string, number>
  error?: string
  event2004?: Awaited<ReturnType<typeof collectEvent2004>>
}
export type CollectedSource = { entries: CapturedEntry[]; status: SourceStatus }
export type ExportBudget = { files: number; bytes: number; visited: number }
type EventLogResult =
  | { status: "included"; data: string; events: number }
  | { status: "failed" | "skipped"; reason: string }

export function serverLogRoots(globalLogPath: string, userDataPath: string, legacyRoot: string) {
  return [...new Set([globalLogPath, join(userDataPath, "redcode", "log"), legacyRoot])]
}

export function collectSource(dir: string, prefix: string, budget: ExportBudget, now = Date.now()): CollectedSource {
  const entries: CapturedEntry[] = []
  const status: SourceStatus = { path: dir, included: 0, skipped: {} }
  const cutoff = now - EXPORT_WINDOW_MS
  const skip = (reason: string) => (status.skipped[reason] = (status.skipped[reason] ?? 0) + 1)
  const names = new Set<string>()
  let scanLimitReported = false
  const walk = (current: string, depth = 0) => {
    if (depth >= MAX_DIRECTORY_DEPTH) {
      skip("directory-depth-limit")
      return
    }
    let directory: ReturnType<typeof opendirSync>
    try {
      directory = opendirSync(current)
    } catch (error) {
      status.error = `unreadable: ${errorCode(error)}`
      return
    }
    try {
      while (true) {
        const child = directory.readSync()
        if (!child) break
        if (budget.visited >= MAX_EXPORT_SCAN_ENTRIES) {
          if (!scanLimitReported) {
            skip("export-budget-exceeded")
            scanLimitReported = true
          }
          break
        }
        budget.visited++
        const file = join(current, child.name)
        let info
        try {
          info = lstatSync(file)
        } catch (error) {
          skip(`unreadable: ${errorCode(error)}`)
          continue
        }
        if (info.isSymbolicLink()) {
          skip("symbolic-link-excluded")
          continue
        }
        if (info.isDirectory()) {
          walk(file, depth + 1)
          if (budget.visited >= MAX_EXPORT_SCAN_ENTRIES) break
          continue
        }
        if (info.mtimeMs < cutoff) {
          skip("outside-time-window")
          continue
        }
        if (info.size > MAX_EXPORT_FILE_SIZE) {
          skip("over-size-limit")
          continue
        }
        if (file.endsWith(".heapsnapshot")) {
          skip("sensitive-heapsnapshot-excluded")
          continue
        }
        if (!reserveBudget(budget, info.size)) {
          skip("export-budget-exceeded")
          continue
        }
        entries.push({
          name: uniqueArchiveName(safeArchiveName(join(prefix, relative(dir, file))), names),
          path: file,
        })
        status.included++
      }
    } finally {
      directory.closeSync()
    }
  }
  try {
    const info = lstatSync(dir)
    if (info.isSymbolicLink()) {
      skip("symbolic-link-excluded")
      return { entries, status }
    }
  } catch (error) {
    status.error = errorCode(error) === "ENOENT" ? "missing" : `unreadable: ${errorCode(error)}`
    return { entries, status }
  }
  walk(dir)
  return { entries, status }
}

export function reserveBudget(budget: ExportBudget, bytes: number) {
  if (budget.files >= MAX_EXPORT_FILES || budget.bytes + bytes > MAX_EXPORT_TOTAL_BYTES) return false
  budget.files++
  budget.bytes += bytes
  return true
}

export function captureResourceSnapshot(
  metrics: { pid: number; type: string; memory: { workingSetSize: number; privateBytes?: number } }[],
  system = { freePhysicalMemory: freemem(), totalPhysicalMemory: totalmem() },
) {
  return {
    capturedAt: new Date().toISOString(),
    processes: metrics.map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      workingSetSizeBytes: metric.memory.workingSetSize * 1024,
      privateMemoryBytes:
        metric.memory.privateBytes === undefined ? undefined : metric.memory.privateBytes * 1024,
    })),
    system: {
      freePhysicalMemoryBytes: system.freePhysicalMemory,
      totalPhysicalMemoryBytes: system.totalPhysicalMemory,
      note: "Physical memory values are not system commit charge.",
    },
  }
}

export async function collectEvent2004(
  runStartedAt: Date,
  runEndedAt = new Date(),
  platform = process.platform,
  execute: (script: string, options: EventLogExecOptions) => Promise<string> = runPowerShell,
): Promise<EventLogResult> {
  if (platform !== "win32") return { status: "skipped", reason: "not-windows" as const }
  const from = new Date(runStartedAt.getTime() - EXPORT_WINDOW_MS).toISOString()
  const to = runEndedAt.toISOString()
  const script =
    "$OutputEncoding = New-Object System.Text.UTF8Encoding; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; " +
    `try { $events = @(Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Resource-Exhaustion-Detector'; Id=2004; StartTime=[datetime]'${from}'; EndTime=[datetime]'${to}'} -MaxEvents ${EVENT_LOG_MAX_EVENTS} -ErrorAction Stop); ` +
    `if ($events.Count -eq 0) { '[]' } else { $events | Select-Object TimeCreated,Id,ProviderName,Message | ConvertTo-Json -Depth 3 -Compress } ` +
    `} catch { if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { '[]' } else { [Console]::Error.WriteLine($_.ToString()); exit 1 } }`
  try {
    const output = await execute(script, {
      timeout: EVENT_LOG_TIMEOUT_MS,
      maxBuffer: EVENT_LOG_MAX_BYTES,
      encoding: "utf8",
      windowsHide: true,
    })
    if (Buffer.byteLength(output) > EVENT_LOG_MAX_BYTES) return { status: "failed", reason: "output-limit" as const }
    const parsed: unknown = JSON.parse(output || "[]")
    const events = Array.isArray(parsed) ? parsed.slice(0, EVENT_LOG_MAX_EVENTS) : parsed ? [parsed] : []
    const data = JSON.stringify(events)
    if (Buffer.byteLength(data) > EVENT_LOG_MAX_BYTES) return { status: "failed", reason: "output-limit" as const }
    return { status: "included", data, events: events.length }
  } catch (error) {
    return { status: "failed", reason: `query-failed: ${errorCode(error)}` }
  }
}

type EventLogExecOptions = {
  timeout: number
  maxBuffer: number
  encoding: "utf8"
  windowsHide: boolean
}

function runPowerShell(script: string, options: EventLogExecOptions) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      options,
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout)
      },
    )
  })
}

function safeArchiveName(name: string) {
  return name
    .split(/[\\/]/)
    .map((part) => part.replace(/[^a-z0-9_.-]/gi, "_").replace(/^\.+$/, "_"))
    .join("/")
}

export function uniqueArchiveName(name: string, used: Set<string>) {
  const normalized = name.toLowerCase()
  if (!used.has(normalized)) {
    used.add(normalized)
    return name
  }
  const dot = name.lastIndexOf(".")
  const base = dot <= name.lastIndexOf("/") ? name : name.slice(0, dot)
  const extension = dot <= name.lastIndexOf("/") ? "" : name.slice(dot)
  let suffix = 2
  while (used.has(`${base}-${suffix}${extension}`.toLowerCase())) suffix++
  const unique = `${base}-${suffix}${extension}`
  used.add(unique.toLowerCase())
  return unique
}

export async function readEntry(entry: CapturedEntry) {
  if (entry.data) return entry.data
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of createReadStream(entry.path!)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > MAX_EXPORT_FILE_SIZE) throw Object.assign(new Error("file exceeds export limit"), { code: "EFBIG" })
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, bytes)
}

export async function readEntrySafely(
  entry: CapturedEntry,
  status: Pick<SourceStatus, "included" | "skipped">,
): Promise<Buffer | undefined> {
  try {
    return await readEntry(entry)
  } catch (error) {
    status.included--
    const reason = `unreadable: ${errorCode(error)}`
    status.skipped[reason] = (status.skipped[reason] ?? 0) + 1
    return undefined
  }
}

function errorCode(error: unknown) {
  if (typeof error !== "object" || error === null) return "unknown"
  if ("code" in error && typeof error.code === "string") return error.code
  return error instanceof Error ? error.name : "unknown"
}
