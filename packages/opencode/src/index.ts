// 260911 Red runner 短路必须早于一切重模块的加载。ESM 的静态 import 在模块体执行前
// 全部求值 —— 旧写法把短路放在第 46 行、四十多个重 import 留在顶部，等于没短路：
// 每个 MCP 宿主进程（--windows-job-runner）白背整套 TUI/server/session/DB 模块图。
// 实测 219MB/进程，9 个 MCP 约 2GB；16GB 机器上叠加第二个 TUI 即触发 opentui 原生
// 内存分配失败（Failed to create TextBuffer）致命崩溃。
// 全部改动态 import 后，runner 路径只加载 windows-job-runner（bun:ffi + node:fs）。
// 决策记录：docs/notes/implemented/bug-fix/2026-09-11-windows-job-runner-boot.md
if (process.env.REDCODE_WINDOWS_JOB_RUNNER === "1") {
  await import("./util/windows-job-runner")
  process.exit()
}

// node 内置模块零成本，保留静态导入；其余按原顺序延迟到 runner 短路之后。
import { EOL } from "os"
import path from "path"

// Log.Level 只在类型位置出现；type import 编译期擦除，不会把模块拉进 runner 进程。
import type { Level as LogLevel } from "@redcode-ai/core/util/log"

const yargs = (await import("yargs")).default
const { hideBin } = await import("yargs/helpers")
const { RunCommand } = await import("./cli/cmd/run")
const { GenerateCommand } = await import("./cli/cmd/generate")
const Log = await import("@redcode-ai/core/util/log")
const { ConsoleCommand } = await import("./cli/cmd/account")
const { ProvidersCommand } = await import("./cli/cmd/providers")
const { AgentCommand } = await import("./cli/cmd/agent")
const { UpgradeCommand } = await import("./cli/cmd/upgrade")
const { UninstallCommand } = await import("./cli/cmd/uninstall")
const { ModelsCommand } = await import("./cli/cmd/models")
const { UI } = await import("./cli/ui")
const { Installation } = await import("./installation")
const { InstallationVersion } = await import("@redcode-ai/core/installation/version")
const { NamedError } = await import("@redcode-ai/core/util/error")
const { FormatError } = await import("./cli/error")
const { ServeCommand } = await import("./cli/cmd/serve")
const { Filesystem } = await import("@/util/filesystem")
const { DebugCommand } = await import("./cli/cmd/debug")
const { StatsCommand } = await import("./cli/cmd/stats")
const { McpCommand } = await import("./cli/cmd/mcp")
const { GithubCommand } = await import("./cli/cmd/github")
const { ExportCommand } = await import("./cli/cmd/export")
const { ImportCommand } = await import("./cli/cmd/import")
const { AttachCommand } = await import("./cli/cmd/tui/attach")
const { TuiThreadCommand } = await import("./cli/cmd/tui/thread")
const { AcpCommand } = await import("./cli/cmd/acp")
const { WebCommand } = await import("./cli/cmd/web")
const { PrCommand } = await import("./cli/cmd/pr")
const { SessionCommand } = await import("./cli/cmd/session")
const { DbCommand } = await import("./cli/cmd/db")
const { Global } = await import("@redcode-ai/core/global")
const { JsonMigration } = await import("@/storage/json-migration")
const { Database } = await import("@/storage/db")
const { SessionDiffGc } = await import("@/session/session-diff-gc")
const { errorMessage } = await import("./util/error")
const { PluginCommand } = await import("./cli/cmd/plug")
const { DoctorCommand } = await import("./cli/cmd/doctor")
const { Heap } = await import("./cli/heap")
const { drizzle } = await import("drizzle-orm/bun-sqlite")
const { ensureProcessMetadata } = await import("@redcode-ai/core/util/redcode-process")
const { isRecord } = await import("@/util/record")

const processMetadata = ensureProcessMetadata("main")

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: errorMessage(e),
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: errorMessage(e),
  })
})

const args = hideBin(process.argv)

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("redcode ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("redcode")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.pure) {
      process.env.REDCODE_PURE = "1"
    }

    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: Installation.isLocal(),
      level: (() => {
        if (opts.logLevel) return opts.logLevel as LogLevel
        if (Installation.isLocal()) return "DEBUG"
        return "INFO"
      })(),
    })

    Heap.start()

    process.env.AGENT = "1"
    process.env.REDCODE = "1"
    process.env.REDCODE_PID = String(process.pid)

    Log.Default.info("redcode", {
      version: InstallationVersion,
      args: process.argv.slice(2),
      process_role: processMetadata.processRole,
      run_id: processMetadata.runID,
    })

    const marker = path.join(Global.Path.data, "redcode.db")
    if (!(await Filesystem.exists(marker))) {
      const tty = process.stderr.isTTY
      process.stderr.write("Performing one time database migration, may take a few minutes..." + EOL)
      const width = 36
      const orange = "\x1b[38;5;214m"
      const muted = "\x1b[0;2m"
      const reset = "\x1b[0m"
      let last = -1
      if (tty) process.stderr.write("\x1b[?25l")
      try {
        await JsonMigration.run(drizzle({ client: Database.Client().$client }), {
          progress: (event) => {
            const percent = Math.floor((event.current / event.total) * 100)
            if (percent === last && event.current !== event.total) return
            last = percent
            if (tty) {
              const fill = Math.round((percent / 100) * width)
              const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
              process.stderr.write(
                `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.label.padEnd(12)} ${event.current}/${event.total}${reset}`,
              )
              if (event.current === event.total) process.stderr.write("\n")
            } else {
              process.stderr.write(`sqlite-migration:${percent}${EOL}`)
            }
          },
        })
      } finally {
        if (tty) process.stderr.write("\x1b[?25h")
        else {
          process.stderr.write(`sqlite-migration:done${EOL}`)
        }
      }
      process.stderr.write("Database migration complete." + EOL)
    }
    // 260904 cc 已删会话留下的 session_diff 孤儿文件，启动时顺手清（见模块头两道保险）；不阻塞命令
    void SessionDiffGc.sweep().catch((e) => Log.Default.warn("session_diff gc failed", { error: errorMessage(e) }))
  })
  .usage("")
  .completion("completion", "generate shell completion script")
  .command(AcpCommand)
  .command(McpCommand)
  .command(TuiThreadCommand)
  .command(AttachCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(ConsoleCommand)
  .command(ProvidersCommand)
  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(ServeCommand)
  .command(WebCommand)
  .command(ModelsCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(GithubCommand)
  .command(PrCommand)
  .command(SessionCommand)
  .command(PluginCommand)
  .command(DbCommand)
  .command(DoctorCommand)
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  let data: Record<string, any> = {}
  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  if (e instanceof NamedError) {
    const obj = e.toObject()
    if (isRecord(obj.data)) {
      for (const [key, value] of Object.entries(obj.data)) {
        if (key === "name" || key === "stack" || key === "cause") continue
        data[key] = value
      }
    }
  }

  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }
  Log.Default.error("fatal", data)
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
