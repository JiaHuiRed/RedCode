import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event, ProcessMetric } from "electron"
import { app, BrowserWindow, nativeTheme } from "electron"

import contextMenu from "electron-context-menu"

import type { InitStep, ServerReadyData, SqliteMigrationProgress, WslConfig } from "../preload/types"
import { checkAppExists, resolveAppPath, wslPath } from "./apps"
import { CHANNEL, UPDATER_ENABLED } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand, sendSqliteMigrationProgress } from "./ipc"
import { exportDebugLogs, initCrashReporter, initLogging, startNetLog, write as writeLog } from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import {
  getDefaultServerUrl,
  getWslConfig,
  preferAppEnv,
  setDefaultServerUrl,
  setWslConfig,
  spawnLocalServer,
  killSidecarTreeSync,
  type SidecarListener,
} from "./server"
import {
  createMainWindow,
  registerRendererProtocol,
  setRelaunchHandler,
  setBackgroundColor,
  setDockIcon,
} from "./windows"
import { migrate } from "./migrate"
import { checkUpdate, checkForUpdates, installUpdate, setupAutoUpdater } from "./updater"
import { Deferred, Effect, Fiber } from "effect"

const APP_NAMES: Record<string, string> = {
  dev: "RedCode Dev",
  beta: "RedCode Beta",
  prod: "RedCode",
}
const APP_IDS: Record<string, string> = {
  dev: "ai.redcode.desktop.dev",
  beta: "ai.redcode.desktop.beta",
  prod: "ai.redcode.desktop",
}
const TEST_ONBOARDING = process.env.REDCODE_TEST_ONBOARDING === "1"
const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

let logger: ReturnType<typeof initLogging>
let mainWindow: BrowserWindow | null = null
let server: SidecarListener | null = null
// 260706 Red 排查 GUI 内存诊断：定期把 app.getAppMetrics() 按进程类型/PID 打到日志里，
//   下次复现"打开对话飙到 7G"时能直接看是哪个真实进程（渲染/utility/GPU）在涨，而不是靠猜。
let metricsInterval: NodeJS.Timeout | undefined
const METRICS_INTERVAL_MS = 15_000

function formatMetric(metric: ProcessMetric) {
  return {
    type: metric.type,
    pid: metric.pid,
    name: metric.name,
    memoryMB: Math.round(metric.memory.workingSetSize / 1024),
    cpuPercent: Math.round(metric.cpu.percentCPUUsage * 100) / 100,
  }
}

function startMetricsLogging() {
  if (metricsInterval) return
  metricsInterval = setInterval(() => {
    const metrics = app.getAppMetrics().map(formatMetric)
    const totalMB = metrics.reduce((sum, m) => sum + m.memoryMB, 0)
    writeLog("metrics", "process memory snapshot", { totalMB, metrics })
    if (sidecarPid) void querySidecarProcessTree(sidecarPid)
  }, METRICS_INTERVAL_MS)
  metricsInterval.unref()
}

function stopMetricsLogging() {
  if (!metricsInterval) return
  clearInterval(metricsInterval)
  metricsInterval = undefined
}

// 260706 Red app.getAppMetrics() 只看 Electron 自己 fork 的进程，sidecar 内部再用原生
//   child_process 拉起来的 MCP server（node/python/uv/bun）它完全看不见——之前那版日志
//   totalMB 从没破 1.2G 就是因为漏了这块。这里用 PowerShell CIM 拿全量进程表（含
//   ParentProcessId），在 JS 里递归找出 sidecarPid 的全部子孙进程并按 WorkingSetSize 求和，
//   才能看到 MCP 子进程树真实吃了多少、具体是哪个 server 的进程名。
type CimProcess = { ProcessId: number; ParentProcessId: number; Name: string; WorkingSetSize: string }

function querySidecarProcessTree(rootPid: number): Promise<void> {
  return new Promise((resolve) => {
    const script =
      "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize | ConvertTo-Json -Compress"
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          writeLog("metrics", "sidecar process tree query failed", { error: error.message }, "warn")
          resolve()
          return
        }
        try {
          const rows: CimProcess[] = JSON.parse(stdout)
          const byParent = new Map<number, CimProcess[]>()
          for (const row of rows) {
            const list = byParent.get(row.ParentProcessId) ?? []
            list.push(row)
            byParent.set(row.ParentProcessId, list)
          }
          const descendants: { pid: number; name: string; memoryMB: number }[] = []
          const stack = [...(byParent.get(rootPid) ?? [])]
          while (stack.length > 0) {
            const proc = stack.pop()!
            descendants.push({
              pid: proc.ProcessId,
              name: proc.Name,
              memoryMB: Math.round(Number(proc.WorkingSetSize) / 1024 / 1024),
            })
            stack.push(...(byParent.get(proc.ProcessId) ?? []))
          }
          const totalMB = descendants.reduce((sum, p) => sum + p.memoryMB, 0)
          writeLog("metrics", "sidecar descendant process tree", { rootPid, totalMB, descendants })
        } catch (parseError) {
          writeLog(
            "metrics",
            "sidecar process tree parse failed",
            { error: parseError instanceof Error ? parseError.message : String(parseError) },
            "warn",
          )
        }
        resolve()
      },
    )
  })
}
// 260609 CC sidecar PID 留给 exit/SIGINT/SIGTERM 同步兜底用：dev 热重启时 electron-vite 掐主进程、
//   before-quit/will-quit 不一定触发，优雅 stop 来不及跑→MCP 孙进程成孤儿。捕到信号即 taskkill /T 整树。
let sidecarPid: number | undefined
let sidecarCleanupHooked = false

function hookSidecarCleanup() {
  if (sidecarCleanupHooked) return
  sidecarCleanupHooked = true
  process.on("exit", () => killSidecarTreeSync(sidecarPid))
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      killSidecarTreeSync(sidecarPid)
      process.exit(0)
    })
  }
}

const initEmitter = new EventEmitter()
let initStep: InitStep = { phase: "server_waiting" }

const pendingDeepLinks: string[] = []

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  if (mainWindow) sendDeepLinks(mainWindow, urls)
}

function setInitStep(step: InitStep) {
  initStep = step
  logger.log("init step", { step })
  initEmitter.emit("step", step)
}

async function killSidecar() {
  if (!server) return
  const current = server
  server = null
  await current.stop()
  sidecarPid = undefined
}

// 260813 cc sidecar 猝死自愈。死因层出不穷（FILEWATCHER V8 崩已修一种；今晨又见
// "事件循环静默排空 exit 0"），与其逐个追死因，不如保证"死了必复活"：同端口同密码
// 重拉，渲染层 SSE 重连循环（server-sdk/global-sdk 自带退避重试）会自动接上——此前
// onExit 只打一行日志，渲染层 Failed to fetch 无限刷屏永不自愈。
// 判别"猝死 vs 有意停"：killSidecar() 先把 server 置 null 再 stop —— exit 事件到达时
// server 仍指着死者 = 猝死；已是 null = 有意停，不复活。quitting 兜底退出窗口期。
let quitting = false
let respawnAttempts = 0
let sidecarSpawnCfg: { hostname: string; port: number; password: string; userDataPath: string } | undefined
const RESPAWN_DELAYS_MS = [1000, 3000, 10000]

function handleSidecarExit(code: number) {
  writeLog("utility", "sidecar exited", { code }, "warn")
  if (quitting || !server || !sidecarSpawnCfg) return
  server = null
  sidecarPid = undefined
  void respawnSidecar(code)
}

async function respawnSidecar(code: number) {
  const cfg = sidecarSpawnCfg
  if (!cfg) return
  const attempt = respawnAttempts++
  if (attempt >= RESPAWN_DELAYS_MS.length) {
    // 连续三次都没活过健康检查，别无限拉尸体——留日志请人来看
    writeLog("utility", "sidecar respawn giving up", { code, attempts: attempt }, "error")
    return
  }
  const delayMs = RESPAWN_DELAYS_MS[attempt]
  writeLog("utility", "sidecar respawn scheduled", { code, attempt: attempt + 1, delayMs }, "warn")
  await new Promise((resolve) => setTimeout(resolve, delayMs))
  if (quitting || server) return
  try {
    const { listener, health } = await spawnLocalServer(cfg.hostname, cfg.port, cfg.password, {
      needsMigration: false,
      userDataPath: cfg.userDataPath,
      onStdout: (message) => writeLog("server", "stdout", { message }),
      onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
      onExit: handleSidecarExit,
    })
    server = listener
    sidecarPid = listener.pid
    const healthy = await Promise.race([
      health.wait.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30_000)),
    ])
    // 只有真过了健康检查才清零重试计数——否则"起来又死"会无限循环
    if (healthy) respawnAttempts = 0
    writeLog("utility", "sidecar respawned", { pid: listener.pid, healthy }, "warn")
  } catch (error) {
    writeLog("utility", "sidecar respawn failed", { error: String(error) }, "error")
    void respawnSidecar(code)
  }
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

const main = Effect.gen(function* () {
  // 260624 Red 强制深色主题，让原生右键菜单跟 app 风格一致
  nativeTheme.themeSource = "dark"

  // 260624 Red 原生右键菜单中文化（仅图片/视频触发）
  contextMenu({
    showSaveImageAs: true,
    showLookUpSelection: false,
    showSearchWithGoogle: false,
    showSelectAll: false,
    shouldShowMenu: (_, params) => params.mediaType === "image" || params.mediaType === "video",
    labels: {
      saveImageAs: "图片另存为…",
      copyImage: "复制图片",
      copyImageAddress: "复制图片地址",
      saveLinkAs: "链接另存为…",
      copyLink: "复制链接",
      copy: "复制",
      cut: "剪切",
      paste: "粘贴",
      selectAll: "全选",
      saveImage: "保存图片",
      saveVideo: "保存视频",
      copyVideoAddress: "复制视频地址",
      inspect: "检查元素",
    },
  })

  // on macOS apps run in `/` which can cause issues with ripgrep
  try {
    process.chdir(homedir())
  } catch {}

  process.env.REDCODE_DISABLE_EMBEDDED_WEB_UI = "true"

  const appId = app.isPackaged ? APP_IDS[CHANNEL] : "ai.redcode.desktop.dev"
  const onboardingTestRoot = ((): string | undefined => {
    if (!TEST_ONBOARDING) return

    const root = join(tmpdir(), `redcode-onboarding-${randomUUID()}`)
    rmSync(root, { recursive: true, force: true })
    ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
      mkdirSync(join(root, dir), { recursive: true }),
    )
    process.env.REDCODE_DB = ":memory:"
    process.env.XDG_DATA_HOME = join(root, "data")
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_CACHE_HOME = join(root, "cache")
    process.env.XDG_STATE_HOME = join(root, "state")
    return root
  })()
  app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "RedCode Dev")
  app.setAppUserModelId(appId)
  app.setPath(
    "userData",
    onboardingTestRoot ? join(onboardingTestRoot, "desktop") : join(app.getPath("appData"), appId),
  )
  if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))
  logger = initLogging()
  initCrashReporter()

  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }

  logger.log("app starting", {
    version: app.getVersion(),
    packaged: app.isPackaged,
    onboardingTest: Boolean(onboardingTestRoot),
  })

  ensureLoopbackNoProxy()
  useEnvProxy()
  // 260609 Red 删除 "<-loopback>"：该 token 是「取消 loopback 隐式旁路」=强制 127.0.0.1 走系统代理，
  //   开代理(如 7890)时渲染进程连本地 sidecar 全被代理截走 → Failed to fetch / 超时 11s。
  //   Chromium 默认就旁路 loopback，外部请求仍走系统代理，去掉此行即恢复本机回环直连。
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", "9222")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  preferAppEnv(app.getPath("userData"))

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("redcode://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("before-quit", () => {
    quitting = true
    stopMetricsLogging()
    void killSidecar()
  })

  app.on("will-quit", () => {
    quitting = true
    void killSidecar()
  })

  app.on("child-process-gone", (_event, details) => {
    writeLog("utility", "child process gone", { details }, "error")
  })

  app.on("render-process-gone", (_event, webContents, details) => {
    writeLog("window", "app render process gone", { url: webContents.getURL(), details }, "error")
  })

  setRelaunchHandler(() => {
    quitting = true
    void killSidecar().finally(() => {
      app.relaunch()
      app.exit(0)
    })
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      quitting = true
      void killSidecar().finally(() => app.exit(0))
    })
  }

  const loadingComplete = Deferred.makeUnsafe<void>()

  registerIpcHandlers({
    killSidecar: () => killSidecar(),
    awaitInitialization: (sendStep: (step: InitStep) => void) => {
      sendStep(initStep)
      const listener = (step: InitStep) => sendStep(step)
      initEmitter.on("step", listener)
      logger.log("awaiting server ready")
      logger.log("server ready", { url })
      initEmitter.off("step", listener)
      return Promise.resolve({ url, username: "redcode", password })
    },
    getWindowConfig: () => ({ updaterEnabled: UPDATER_ENABLED }),
    consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
    getDefaultServerUrl: () => getDefaultServerUrl(),
    setDefaultServerUrl: (url) => setDefaultServerUrl(url),
    getWslConfig: () => Promise.resolve(getWslConfig()),
    setWslConfig: (config: WslConfig) => setWslConfig(config),
    getDisplayBackend: async () => null,
    setDisplayBackend: async () => undefined,
    parseMarkdown: async (markdown) => parseMarkdown(markdown),
    checkAppExists: (appName) => checkAppExists(appName),
    wslPath: async (path, mode) => wslPath(path, mode),
    resolveAppPath: async (appName) => resolveAppPath(appName),
    loadingWindowComplete: () => Deferred.doneUnsafe(loadingComplete, Effect.void),
    runUpdater: async (alertOnFail) => checkForUpdates(alertOnFail, killSidecar),
    checkUpdate: async () => checkUpdate(),
    installUpdate: async () => installUpdate(killSidecar),
    setBackgroundColor: (color) => setBackgroundColor(color),
    exportDebugLogs: () => exportDebugLogs(),
    recordFatalRendererError: (error) => writeLog("renderer", "fatal renderer error", { ...error }, "error"),
  })

  yield* Effect.promise(() => app.whenReady())

  if (!TEST_ONBOARDING) migrate()
  app.setAsDefaultProtocolClient("redcode")
  registerRendererProtocol()
  setDockIcon()
  setupAutoUpdater()
  yield* Effect.promise(() => startNetLog()).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to start net log", error)
      }),
    ),
  )

  const needsMigration = ((): boolean => {
    if (process.env.REDCODE_DB === ":memory:") return false

    const xdg = process.env.XDG_DATA_HOME
    const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share")
    return !existsSync(join(base, "redcode", "redcode.db"))
  })()
  const port = yield* Effect.gen(function* () {
    const fromEnv = process.env.REDCODE_PORT
    if (fromEnv) {
      const parsed = Number.parseInt(fromEnv, 10)
      if (!Number.isNaN(parsed)) return parsed
    }

    const res = yield* Deferred.make<number, unknown>()
    const server = createServer()
    server.on("error", (e) => Deferred.failSync(res, () => e))
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        Deferred.failSync(res, () => new Error("Failed to get port"))
        return
      }
      const port = address.port
      server.close(() => Effect.runSync(Deferred.succeed(res, port)))
    })

    return yield* Deferred.await(res)
  })
  const hostname = "127.0.0.1"
  const url = `http://${hostname}:${port}`
  const password = randomUUID()

  const loadingTask = yield* Effect.gen(function* () {
    logger.log("sidecar connection started", { url })

    initEmitter.on("sqlite", (progress: SqliteMigrationProgress) => {
      setInitStep({ phase: "sqlite_waiting" })
      if (mainWindow) sendSqliteMigrationProgress(mainWindow, progress)
    })

    ensureLoopbackNoProxy()
    useEnvProxy()

    logger.log("spawning sidecar", { url })
    // 260608 Red 启动计时：spawn→ready、ready→healthy 各占多久，定位首页"加载中"瓶颈，测完即删
    const tSpawn = performance.now()
    // 260813 cc 存一份 spawn 参数供猝死自愈重拉（同端口同密码，渲染层免感知）
    sidecarSpawnCfg = { hostname, port, password, userDataPath: app.getPath("userData") }
    const { listener, health } = yield* Effect.promise(() =>
      spawnLocalServer(hostname, port, password, {
        needsMigration,
        userDataPath: app.getPath("userData"),
        onSqliteProgress: (progress) => initEmitter.emit("sqlite", progress),
        onStdout: (message) => writeLog("server", "stdout", { message }),
        onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
        onExit: handleSidecarExit,
      }),
    )
    server = listener
    sidecarPid = listener.pid
    hookSidecarCleanup()
    logger.log("[timing] sidecar ready", { ms: Math.round(performance.now() - tSpawn) })

    yield* Effect.promise(() => health.wait).pipe(
      Effect.timeout("30 seconds"),
      Effect.catch((e) =>
        Effect.sync(() => {
          logger.error("sidecar health check failed", e.toString())
        }),
      ),
    )
    logger.log("[timing] sidecar healthy", { ms: Math.round(performance.now() - tSpawn) })

    logger.log("loading task finished")
  }).pipe(Effect.forkChild)

  yield* Fiber.await(loadingTask)
  setInitStep({ phase: "done" })

  mainWindow = createMainWindow()
  startMetricsLogging()
  if (mainWindow) {
    createMenu({
      trigger: (id) => {
        const win = BrowserWindow.getFocusedWindow() ?? mainWindow
        if (win) sendMenuCommand(win, id)
      },
      checkForUpdates: () => {
        void checkForUpdates(true, killSidecar)
      },
      relaunch: () => {
        void killSidecar().finally(() => {
          app.relaunch()
          app.exit(0)
        })
      },
    })
  }
})

Effect.runFork(main)
