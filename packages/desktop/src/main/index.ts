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
import { listFonts } from "./fonts"
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

// 260901 cc 默认关掉，改成 REDCODE_METRICS=1 才开。
//
// 这套东西是 260706 为了排查「打开对话飙到 7G」临时加的取证工具，但它留在了常驻路径上、
// 没有任何开关。代价在实测里是可见的：
//   · 每 15 秒 spawn 一个 powershell.exe 跑 Get-CimInstance Win32_Process 拉全机进程表，
//     本机实测单次 565-697ms 墙钟。常驻开着一天就是 5760 次进程创建（还各带一个 conhost），
//     Windows 上每次还会触发 Defender 对镜像的扫描。
//   · %APPDATA%\ai.redcode.desktop.dev\logs 整个目录 18MB，其中 17.5MB 是它写的
//     （单个 metrics.log 最大 4.7MB）；其余所有日志加起来不到 500KB。
// 取证能力没有删掉，需要时 REDCODE_METRICS=1 起一次就有。
const METRICS_ENABLED = process.env.REDCODE_METRICS === "1"

function startMetricsLogging() {
  if (!METRICS_ENABLED) return
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

// 260902 cc 时间窗闸门。原来只有 respawnAttempts 一个计数器，而它在**健康检查通过**时清零
// （见下面 respawnSidecar 里那句）——问题是"过了健康检查"不等于"稳住了"。260828 15:58-15:59
// 实测：70 秒内死三次，每次都健康起来、活约 33 秒又死，于是计数器每轮清零、attempt 恒为 1，
// "giving up" 永远不触发，理论上可以无限拉尸体。
// 所以再加一道与健康无关的闸：滑动窗口内重生次数超限就停手。孤立的偶发猝死照旧自愈
// （一次死亡只占一个名额、10 分钟后自然过期），只有"起来又死"的循环会撞上限。
const RESPAWN_WINDOW_MS = 10 * 60_000
const RESPAWN_MAX_IN_WINDOW = 5
let respawnTimes: number[] = []
// 上一次 sidecar 起来的时刻——用来在退出日志里给出存活时长，
// 一眼分清"孤立猝死"与"起来又死"（此前退出日志只有 code，两者长得一样）。
let sidecarStartedAt: number | undefined

function handleSidecarExit(code: number) {
  const aliveMs = sidecarStartedAt === undefined ? undefined : Date.now() - sidecarStartedAt
  sidecarStartedAt = undefined
  writeLog("utility", "sidecar exited", { code, aliveMs }, "warn")
  if (quitting || !server || !sidecarSpawnCfg) return
  server = null
  sidecarPid = undefined
  void respawnSidecar(code)
}

async function respawnSidecar(code: number) {
  const cfg = sidecarSpawnCfg
  if (!cfg) return
  const now = Date.now()
  respawnTimes = respawnTimes.filter((t) => now - t < RESPAWN_WINDOW_MS)
  respawnTimes.push(now)
  if (respawnTimes.length > RESPAWN_MAX_IN_WINDOW) {
    // 与健康检查无关的第二道闸：窗口内重生太频繁 = 起来又死，再拉也是拉尸体
    writeLog(
      "utility",
      "sidecar respawn giving up (rate)",
      { code, respawnsInWindow: respawnTimes.length, windowMs: RESPAWN_WINDOW_MS },
      "error",
    )
    return
  }
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
    sidecarStartedAt = Date.now()
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
  // 260901 cc sidecar 就绪信号。窗口现在早于 sidecar 创建（见下方 createMainWindow 那段），
  //   所以 awaitInitialization 不能再立刻 resolve —— 渲染层拿到 url 就会去连，连早了必然失败。
  const serverReady = Deferred.makeUnsafe<void>()

  registerIpcHandlers({
    killSidecar: () => killSidecar(),
    // 260901 cc 原先这里是「注册 listener → 立刻注销 → 立刻 resolve」，那套 init-step 协议
    //   等于是死的：窗口本来就建在 sidecar 就绪之后，第一次被调用时 initStep 早已是 done。
    //   现在窗口早于 sidecar 出现，这条才真正开始承担它本来的职责：把启动进度推给渲染层，
    //   并在 sidecar 真的好了之后才交出 url —— 提前交出去渲染层会连一个还没监听的端口。
    awaitInitialization: async (sendStep: (step: InitStep) => void) => {
      sendStep(initStep)
      const listener = (step: InitStep) => sendStep(step)
      initEmitter.on("step", listener)
      logger.log("awaiting server ready")
      try {
        await Effect.runPromise(Deferred.await(serverReady))
      } finally {
        initEmitter.off("step", listener)
      }
      logger.log("server ready", { url })
      return { url, username: "redcode", password }
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
    listFonts: () => listFonts(),
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
    sidecarStartedAt = Date.now()
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

  // 260901 cc 建窗提到等 sidecar **之前**。
  //
  // 他打包版的真实日志（两次一致）：
  //   app starting            T+0
  //   sidecar ready           T+1.49s
  //   sidecar healthy         T+1.63s   ← 原先窗口到这一刻才被创建
  //   awaiting server ready   T+2.07s   ← 渲染层自己只花了 0.44s
  // 也就是说点了图标之后 1.6 秒屏幕上什么都没有，而这 1.6 秒里渲染进程根本还没被 fork，
  // 主进程只是在等 sidecar 的 I/O。两件事之间没有依赖：sidecar 是独立的 utilityProcess，
  // 渲染层拿 url/password 走的是 awaitInitialization 这条 IPC。
  //
  // 放在这个位置而不是更靠前，是因为 port/hostname/url/password（上面几十行）必须先算完 ——
  // registerIpcHandlers 的闭包捕获的是这几个 const，窗口一旦早于它们创建，渲染层调
  // await-initialization 就会撞 TDZ。这里已经在它们之后、loadingTask fork 之后，是最早的安全点。
  //
  // 配套两处缺一不可：
  //   ① awaitInitialization 改成真的等 serverReady（原先立刻 resolve，因为那时 sidecar
  //      必然已经好了）；
  //   ② renderer/index.tsx 那个包住整个 UI 的 <Show> 必须补 fallback —— 它原先没有，
  //      窗口提前出现会变成「1.4 秒空白窗」，比没窗口更糟（仓里 ca2eebea 打过一次这种黑窗）。
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

  // Fiber.await 仍然留在 main 的末尾，位置不能再往前收：loadingTask 是 Effect.forkChild，
  // 生命周期挂在父 fiber 上，main 一结束它就会被打断。这里只是不再让**建窗**等它。
  yield* Fiber.await(loadingTask)
  setInitStep({ phase: "done" })
  Deferred.doneUnsafe(serverReady, Effect.void)
})

Effect.runFork(main)
