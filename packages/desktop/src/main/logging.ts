import { MainLogger } from "electron-log"
import log from "electron-log/main.js"
import { app, crashReporter, netLog, shell } from "electron"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { ZipWriter, BlobWriter, BlobReader } from "@zip.js/zip.js"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import {
  captureResourceSnapshot,
  collectEvent2004,
  collectSource,
  CRASH_LOG_SCOPES,
  MAX_EXPORT_FILE_SIZE,
  MAX_EXPORT_FILES,
  MAX_EXPORT_SCAN_ENTRIES,
  MAX_EXPORT_TOTAL_BYTES,
  readEntrySafely,
  reserveBudget,
  serverLogRoots,
  uniqueArchiveName,
} from "./debug-capture"

const MAX_LOG_AGE_DAYS = 7
const TAIL_LINES = 1000
const NET_LOG_SIZE = 20 * 1024 * 1024

let root = ""
let run = ""
let runStartedAt = new Date()
let netLogPath: string | undefined

let logger: MainLogger
export const getLogger = () => logger

export function initLogging() {
  initRunDirectory()
  log.transports.file.maxSize = 5 * 1024 * 1024
  log.transports.file.resolvePathFn = (_vars, message) =>
    join(
      run,
      `${safeLogName(message?.scope ?? (message?.variables?.processType === "renderer" ? "renderer" : "main"))}.log`,
    )
  log.initialize({ preload: false, spyRendererConsole: true })
  initConsoleTransport()
  cleanup()
  return (logger = log)
}

export function initCrashReporter() {
  const dir = join(app.getPath("userData"), "Crashpad")
  mkdirSync(dir, { recursive: true })
  app.setPath("crashDumps", dir)
  crashReporter.start({ uploadToServer: false, compress: true })
  write("crash", "crash reporter started", { path: dir })
}

// 260901 cc 改成 REDCODE_NETLOG=1 才开。
//
// captureMode "default" 的语义是「记录全部事件」——每个 socket 事件、每次请求头、每个响应
// chunk 的读取边界都要生成一条事件并序列化写盘。而这个应用的网络画像恰好是最坏情况：
// 一条常驻 SSE 流，模型输出时每个 token 一条 SSE 消息。实测 4 分钟写掉 10.55MB。
// 常驻开着不关的用法下这是一条永不停歇的后台写盘 + 网络栈插桩开销。
//
// 关掉不影响导出调试日志：exportDebugLogs 是靠 `netLog.currentlyLogging` 判断要不要重启的，
// 没开就跳过；manifest 里的 netLog 字段是 undefined 会被 JSON.stringify 省掉；
// network.netlog 本来就落在 run 目录里，由 collect(root) 顺带收，没有就没有。

// 260929 Red fatal 弹窗前落 crash report（学 deepseek-harness 的 crash report before fatal
// recovery dialog）：把错误详情与本次运行各日志的 tail 汇成一个带时间戳的 markdown，返回路径
// 给弹窗展示——排查时不用再猜该看哪个文件（#184 Network Service 白屏那次靠进程创建时间
// 倒推才发现该看 utility.log）。各段有 32KB 截断，报告整体有界。
const CRASH_TAIL_CHARS = 32 * 1024
export function writeCrashReport(headline: string, detail: Record<string, unknown>): string | undefined {
  if (!root) return undefined
  try {
    const dir = join(root, "crashes")
    mkdirSync(dir, { recursive: true })
    const content = [
      `# ${headline}`,
      "",
      `- time: ${new Date().toISOString()}`,
      `- version: ${app.getVersion()}`,
      `- run: ${run}`,
      "",
      "## detail",
      "",
      "```",
      JSON.stringify(detail, null, 2),
      "```",
      "",
      ...CRASH_LOG_SCOPES.map(
        (scope) => `## ${scope}.log\n\n\`\`\`\n${tailFile(join(run, `${scope}.log`))}\n\`\`\``,
      ),
    ].join("\n")
    const path = join(dir, `crash-${stamp()}.md`)
    writeFileSync(path, content)
    return path
  } catch (error) {
    write("crash", "failed to write crash report", { error: String(error) }, "warn")
    return undefined
  }
}

export function writeResourceSnapshot(reason: "renderer-unresponsive" | "renderer-process-gone", window: string) {
  const snapshot = captureResourceSnapshot(app.getAppMetrics())
  write("window", "renderer resource snapshot", { reason, window, ...snapshot }, "error")
}

function tailFile(path: string): string {
  try {
    if (!existsSync(path)) return "(not written this run)"
    const contents = readFileSync(path, "utf8")
    if (contents.length <= CRASH_TAIL_CHARS) return contents
    return `…(truncated)\n${contents.slice(-CRASH_TAIL_CHARS)}`
  } catch {
    return "(unreadable)"
  }
}
const NET_LOG_ENABLED = process.env.REDCODE_NETLOG === "1"

export async function startNetLog() {
  if (!NET_LOG_ENABLED) return
  if (netLog.currentlyLogging) return
  netLogPath = join(run, "network.netlog")
  await netLog.startLogging(netLogPath, { captureMode: "default", maxFileSize: NET_LOG_SIZE })
  write("network", "net log started", { path: netLogPath })
}

export async function exportDebugLogs() {
  const restartNetLog = netLog.currentlyLogging
  if (restartNetLog) {
    await netLog.stopLogging().catch((error) => write("network", "failed to stop net log", { error }))
  }

  const output = join(app.getPath("downloads"), `redcode-debug-${stamp()}.zip`)
  try {
    write("main", "exporting debug logs", { output })
    const budget = { files: 0, bytes: 0, visited: 0 }
    const sources = [
      collectSource(root, "desktop", budget),
      ...getServerLogRoots().map((dir, i) => collectSource(dir, `server-${i + 1}`, budget)),
      collectSource(app.getPath("crashDumps"), "crashpad", budget),
    ]
    const event2004 = await collectEvent2004(runStartedAt, new Date())
    const eventSource = {
      entries: [] as { name: string; data?: Buffer }[],
      status: { path: "Windows System event log", included: 0, skipped: {} as Record<string, number>, event2004 },
    }
    if (event2004.status === "included") {
      if (reserveBudget(budget, Buffer.byteLength(event2004.data))) {
        eventSource.entries.push({
          name: "windows-resource-exhaustion-events.json",
          data: Buffer.from(event2004.data),
        })
        eventSource.status.included++
      } else {
        eventSource.status.skipped["export-budget-exceeded"] = 1
      }
    }
    sources.push(eventSource)
    await writeZip(output, sources, () =>
      Buffer.from(
        JSON.stringify(
          {
            ...manifest(),
            collectionStatus: sources.map((source) => source.status),
            exportBudget: {
              maxFiles: MAX_EXPORT_FILES,
              maxScannedEntries: MAX_EXPORT_SCAN_ENTRIES,
              maxTotalBytes: MAX_EXPORT_TOTAL_BYTES,
              maxFileBytes: MAX_EXPORT_FILE_SIZE,
              selectedFiles: budget.files,
              selectedBytes: budget.bytes,
            },
          },
          null,
          2,
        ),
      ),
    )
    shell.showItemInFolder(output)
    return output
  } finally {
    if (restartNetLog) {
      await startNetLog().catch((error) => write("network", "failed to restart net log", { error }))
    }
  }
}

// 261011 Red B0（GUI 稳定性审计 §11）：GUI 侧诊断导出载荷写入当前 run 目录——
// exportDebugLogs() 收集该目录进 ZIP，无需新增导出通道。载荷由渲染端生成（已脱敏、有界）。
export function writeGuiDiagnostics(payload: string): string | undefined {
  if (!run) return undefined
  const path = join(run, "gui-diagnostics.json")
  try {
    writeFileSync(path, payload)
    write("diagnostics", "gui diagnostics exported", { bytes: payload.length })
    return path
  } catch (error) {
    write("diagnostics", "failed to write gui diagnostics", { error: String(error) }, "warn")
    return undefined
  }
}

export function write(
  name: string,
  message: string,
  extra?: Record<string, unknown>,
  level: "info" | "warn" | "error" = "info",
) {
  if (!run) return
  const scoped = log.scope(safeLogName(name))
  if (extra !== undefined) {
    scoped[level](message, extra)
    return
  }
  scoped[level](message)
}

export function tail(): string {
  try {
    const path = log.transports.file.getFile().path
    const contents = readFileSync(path, "utf8")
    const lines = contents.split("\n")
    return lines.slice(Math.max(0, lines.length - TAIL_LINES)).join("\n")
  } catch {
    return ""
  }
}

function initRunDirectory() {
  root = join(app.getPath("userData"), "logs")
  runStartedAt = new Date()
  run = join(root, stamp())
  mkdirSync(run, { recursive: true })
}

function stamp() {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
}

function safeLogName(name: string) {
  return name.replace(/[^a-z0-9_.-]/gi, "_") || "main"
}

function cleanup() {
  const dir = root || dirname(log.transports.file.getFile().path)
  const cutoff = Date.now() - MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000

  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry)
    try {
      const info = statSync(file)
      if (info.mtimeMs < cutoff) rmSync(file, { recursive: true, force: true })
    } catch {
      continue
    }
  }
}

function manifest() {
  return {
    generated: new Date().toISOString(),
    version: app.getVersion(),
    name: app.getName(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    versions: process.versions,
    uptime: process.uptime(),
    userData: app.getPath("userData"),
    logs: root,
    currentRun: run,
    crashDumps: app.getPath("crashDumps"),
    serverLogs: getServerLogRoots(),
    netLog: netLogPath,
  }
}

function getServerLogRoots() {
  return serverLogRoots(
    // 261015 Red 对齐 core/global.ts 的路径协议；不跨 rootDir 加载带初始化副作用的核心模块。
    join(process.env.REDCODE_TEST_HOME ?? homedir(), ".redcode", "data", "log"),
    app.getPath("userData"),
    join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "redcode", "log"),
  )
}

async function writeZip(
  output: string,
  sources: { entries: { name: string; path?: string; data?: Buffer }[]; status: { included: number; skipped: Record<string, number> } }[],
  manifestData: () => Buffer,
) {
  const writer = new ZipWriter(new BlobWriter("application/zip"))
  const used = new Set(["manifest.json"])
  let writtenFiles = 0
  let writtenBytes = 0
  for (const source of sources) {
    for (const entry of source.entries) {
     // 261015 Red readEntrySafely 自己记账（included-- + skipped 原因），外层不再兜一层
     // catch——重复递减会让 manifest 的计数比真实条目少。
     const data = await readEntrySafely(entry, source.status)
     if (!data) continue
      if (
        data.byteLength > MAX_EXPORT_FILE_SIZE ||
        writtenFiles >= MAX_EXPORT_FILES ||
        writtenBytes + data.byteLength > MAX_EXPORT_TOTAL_BYTES
      ) {
        source.status.included--
        source.status.skipped["export-budget-exceeded"] = (source.status.skipped["export-budget-exceeded"] ?? 0) + 1
        continue
      }
      try {
        await writer.add(uniqueArchiveName(entry.name, used), new BlobReader(new Blob([new Uint8Array(data)])))
        writtenFiles++
        writtenBytes += data.byteLength
      } catch (error) {
        source.status.included--
        const reason = `archive-add-failed: ${errorCode(error)}`
        source.status.skipped[reason] = (source.status.skipped[reason] ?? 0) + 1
      }
    }
  }
  await writer.add("manifest.json", new BlobReader(new Blob([new Uint8Array(manifestData())])))
  const zip = await writer.close()
  writeFileSync(output, Buffer.from(await zip.arrayBuffer()))
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "unknown"
}

function initConsoleTransport() {
  const write = log.transports.console.writeFn.bind(log.transports.console)
  log.transports.console.writeFn = (options) => {
    try {
      write(options)
    } catch (err) {
      if (!isBrokenPipe(err)) throw err
      log.transports.console.level = false
    }
  }
}

function isBrokenPipe(err: unknown) {
  return typeof err === "object" && err !== null && "code" in err && err.code === "EPIPE"
}
