import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event, ProcessMetric } from "electron"
import { app, BrowserWindow, dialog, Menu, nativeTheme, shell, Tray } from "electron"

import contextMenu from "electron-context-menu"
import { CHANNEL, QUIT_CONFIRM_DISABLED_KEY, UPDATER_ENABLED } from "./constants"
import type { InitStep, ServerReadyData, SqliteMigrationProgress, WslConfig } from "../preload/types"
import { checkAppExists, resolveAppPath, wslPath, wslPathMany } from "./apps"
import { listFonts } from "./fonts"
import {
  broadcastSidecarState,
  registerIpcHandlers,
  sendDeepLinks,
  sendMenuCommand,
  sendNetworkServiceRestart,
  sendSqliteMigrationProgress,
} from "./ipc"
import {
  exportDebugLogs,
  initCrashReporter,
  initLogging,
  startNetLog,
  write as writeLog,
  writeCrashReport,
  writeGuiDiagnostics,
} from "./logging"
import { createMenu } from "./menu"
import {
  getDefaultServerUrl,
  getWslConfig,
  preferAppEnv,
  setDefaultServerUrl,
  setWslConfig,
  spawnLocalServer,
  type SidecarListener,
} from "./server"
import { getStore } from "./store"
import { killSidecarTreeSync } from "./sidecar-process"
import { createSidecarSupervisor } from "./sidecar-supervisor"
import { beginStaleSidecarSweep, forgetSidecarTree, killOrphanChildren, rememberSidecarTree } from "./sidecar-registry"
import {
  createMainWindow,
  iconPath,
  registerRendererProtocol,
  setRelaunchHandler,
  setBackgroundColor,
  setDockIcon,
} from "./windows"
import { checkUpdate, checkForUpdates, installUpdate, setupAutoUpdater } from "./updater"
import { createDeepLinkDelivery } from "./deep-link-delivery"
import { ensureNotificationShortcut } from "./notification-shortcut"
import {
  createMobileGateway,
  listMobileGatewayHosts,
  mobileGatewaySessionInScope,
  type MobileGatewayStartInfo,
} from "./mobile-gateway"
import { Cause, Deferred, Effect, Fiber } from "effect"

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
let mobileGateway: ReturnType<typeof createMobileGateway> | undefined
let mobileGatewayInfo: MobileGatewayStartInfo | undefined
let mobileGatewayStartGeneration = 0
let mobileGatewayStarting = false
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

const deepLinks = createDeepLinkDelivery((urls) => {
  if (!mainWindow) return false
  sendDeepLinks(mainWindow, urls)
  return true
})

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

function emitDeepLinks(urls: string[]) {
  deepLinks.emit(urls)
}

function setInitStep(step: InitStep) {
  initStep = step
  logger.log("init step", { step })
  initEmitter.emit("step", step)
}

async function stopMobileGateway() {
  mobileGatewayStartGeneration++
  mobileGatewayStarting = false
  const current = mobileGateway
  mobileGateway = undefined
  mobileGatewayInfo = undefined
  await current?.stop()
}

/** 只停进程，不碰 supervisor 的恢复判断 —— supervisor 自己的重试走这条。 */
async function stopCurrentSidecar() {
  await stopMobileGateway()
  if (!server) return
  const current = server
  server = null
  await current.stop()
  sidecarPid = undefined
  // 260916 Red 树已经连孩子一起杀掉（taskkill /T），记录留着只会让下次启动白扫一遍。
  forgetSidecarTree()
}

async function killSidecar() {
  // 261021 Red 审计 RC21-06：先告诉 supervisor「这是有意停」。否则进程的退出回调会被
  //   当成猝死，用户点退出/切换时反而在身后把服务又拉起来。
  supervisor.stop()
  await stopCurrentSidecar()
}

// 260813 cc sidecar 猝死自愈：死因层出不穷（FILEWATCHER V8 崩已修一种；今晨又见
// "事件循环静默排空 exit 0"），与其逐个追死因，不如保证"死了必复活"：同端口同密码
// 重拉，渲染层 SSE 重连循环（server-sdk/global-sdk 自带退避重试）会自动接上——此前
// onExit 只打一行日志，渲染层 Failed to fetch 无限刷屏永不自愈。
// 261021 Red 审计 RC21-06：推动恢复的只能有一处。旧实现里退出回调与健康失败各推一次重启，
//   重启后已发 ready、未过健康检查就退出的那次故障会吃两个恢复预算。现在统一由
//   sidecar-supervisor 持有代次、单任务与预算，这里只提供「怎么拉起、怎么停、怎么记日志」。
//   见 docs/notes/implemented/bug-fix/2026-10-21-sidecar-supervisor.md。
let quitting = false
let sidecarSpawnCfg: { hostname: string; port: number; password: string; userDataPath: string } | undefined
let sidecarStartedAt: number | undefined
// 261024 Red 异常退出后的孤儿清理闸：handleSidecarExit 记账，spawn 前置等待。旧同步版
//   在退出回调里 execSync 清完才放行恢复；异步化时改成 void fire-and-forget，丢掉了
//   「清完旧树再拉新树」的先后——下一代 sidecar 可能带着上代还没杀完的 MCP 孤儿一起起
//   （单例端口/文件锁撞车，冷启动 sweep-then-spawn 防的就是这类）。链式追加：连续异常
//   退出时，所有代的清理都完成才允许再 spawn；冷启动路径这里是已 resolve 的空链，零等待。
let orphanCleanup: Promise<void> = Promise.resolve()
// 首次启动独有的 spawn 参数（迁移状态与 sqlite 进度回调）；恢复启动只需要同端口同密码。
let nextSpawnHook: { needsMigration: boolean; onSqliteProgress?: (progress: SqliteMigrationProgress) => void } = {
  needsMigration: false,
}

const supervisor = createSidecarSupervisor({
  spawn: async (onExit) => {
    const cfg = sidecarSpawnCfg
    if (!cfg) throw new Error("sidecar spawn requested before the server configuration is ready")
    // 261024 Red 上代孤儿清完才起新进程——与冷启动 sweep-then-spawn 同一条先后硬约束。
    //   killOrphanChildren 内部逐步吞错，这里不会因单步清扫失败而卡住恢复。
    await orphanCleanup
    const hook = nextSpawnHook
    nextSpawnHook = { needsMigration: false }
    const { listener, health } = await spawnLocalServer(cfg.hostname, cfg.port, cfg.password, {
      needsMigration: hook.needsMigration,
      userDataPath: cfg.userDataPath,
      onSqliteProgress: hook.onSqliteProgress,
      onStdout: (message) => writeLog("server", "stdout", { message }),
      onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
      onExit: (code) => {
        handleSidecarExit(code)
        onExit(code)
      },
    })
    server = listener
    sidecarPid = listener.pid
    sidecarStartedAt = Date.now()
    hookSidecarCleanup()
    rememberSidecarTree(process.pid, listener.pid)
    return { pid: listener.pid, waitHealthy: () => health.waitUntilHealthy() }
  },
  kill: () => stopCurrentSidecar(),
  delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
  quitting: () => quitting,
  log: (event, data, level) => writeLog("utility", event, data, level),
  onState: (state) => broadcastSidecarState(state),
})

function getMobileGatewayStatus() {
  return {
    hosts: listMobileGatewayHosts(),
    running: Boolean(mobileGateway),
    info: mobileGatewayInfo ?? null,
    devices: mobileGateway?.devices() ?? [],
  }
}

async function startMobileGateway(host: string, directory: string, sessionID: string) {
  if (mobileGateway) throw new Error("Stop the active mobile Gateway before changing its workspace")
  if (mobileGatewayStarting) throw new Error("The mobile Gateway is already starting")
  const generation = ++mobileGatewayStartGeneration
  mobileGatewayStarting = true
  const currentServer = server
  const currentConfig = sidecarSpawnCfg
  try {
    if (!currentServer || !currentConfig) throw new Error("The GUI sidecar is not ready")
    if (!listMobileGatewayHosts().some((item) => item.address === host))
      throw new Error("Select a loopback or private network interface")
    if (!isAbsolute(directory) || directory.includes("\0")) throw new Error("A valid project directory is required")
    if (!/^ses_[A-Za-z0-9_-]{1,128}$/.test(sessionID)) throw new Error("Open a session before enabling mobile access")

    const upstream = `http://${currentConfig.hostname}:${currentConfig.port}`
    const response = await fetch(new URL(`/session/${sessionID}`, upstream), {
      headers: {
        authorization: `Basic ${Buffer.from(`redcode:${currentConfig.password}`).toString("base64")}`,
        "x-redcode-directory": directory,
      },
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error("The selected session could not be verified in this project")
    }
    const session: unknown = await response.json().catch(() => undefined)
    if (!mobileGatewaySessionInScope(session, sessionID, directory)) {
      throw new Error("The selected session could not be verified in this project")
    }
    if (generation !== mobileGatewayStartGeneration || server !== currentServer || sidecarSpawnCfg !== currentConfig) {
      throw new Error("The GUI sidecar changed while starting the mobile Gateway")
    }

    const gateway = createMobileGateway({
      host,
      sidecar: { url: upstream, username: "redcode", password: currentConfig.password },
      scope: { directory, initialSessionID: sessionID },
    })
    const info = await gateway.start()
    if (generation !== mobileGatewayStartGeneration || server !== currentServer || sidecarSpawnCfg !== currentConfig) {
      await gateway.stop()
      throw new Error("The GUI sidecar changed while starting the mobile Gateway")
    }
    mobileGateway = gateway
    mobileGatewayInfo = info
    logger.log("mobile gateway started", { host: info.host, port: info.port })
    return info
  } finally {
    if (generation === mobileGatewayStartGeneration) mobileGatewayStarting = false
  }
}

function refreshMobileGatewayPairingCode() {
  const info = mobileGateway?.refreshPairingCode()
  if (!info) throw new Error("The mobile Gateway is not running")
  mobileGatewayInfo = info
  return info
}

/** 只负责退出后的日志与清理；推动恢复是 sidecar-supervisor 的事（按代次去重）。 */
function handleSidecarExit(code: number) {
  const aliveMs = sidecarStartedAt === undefined ? undefined : Date.now() - sidecarStartedAt
  sidecarStartedAt = undefined
  writeLog("utility", "sidecar exited", { code, aliveMs }, "warn")
  // 260916 Red sidecar 死了，但它拉起的 MCP 子进程还活着（Windows 上没有 job object 兜底），
  //   接下来 respawn 会把新的一套拉起来，旧的就永远留成孤儿。趁还知道旧 PID，先清掉它的孩子。
  //   261024 Red 清扫异步化后不再 fire-and-forget：记进 orphanCleanup 链，下一次 spawn
  //   （恢复/手动重试都走同一入口）会先等它完成，恢复「清完旧树再拉新树」的先后。
  if (sidecarPid !== undefined) {
    const pid = sidecarPid
    orphanCleanup = orphanCleanup.then(() => killOrphanChildren(pid)).catch(() => undefined)
  }
  sidecarPid = undefined
  server = null
}

// 260929 Red Windows 没有应用菜单（menu.ts 仅 darwin），close→hide 之后 X/Alt+F4 不再是
// 退出入口，必须配套托盘（学 deepseek-harness 的 close-to-background + tray + quit
// confirmation）：托盘提供显示/退出，退出前确认一次——后台可能还有会话任务在跑，
// 退出会停掉 sidecar 及其全部子进程。可勾选「不再询问」。
let tray: Tray | undefined

function confirmQuit() {
  void (async () => {
    if (getStore().get(QUIT_CONFIRM_DISABLED_KEY) !== true) {
      const result = await dialog.showMessageBox({
        type: "question",
        buttons: ["退出", "取消"],
        defaultId: 1,
        cancelId: 1,
        checkboxLabel: "不再询问",
        message: "确定退出 RedCode？",
        detail: "后台可能还有正在运行的任务（模型生成、工具执行）。退出会停止服务进程及其全部子进程。",
      })
      if (result.response !== 0) return
      if (result.checkboxChecked) getStore().set(QUIT_CONFIRM_DISABLED_KEY, true)
    }
    quitting = true
    app.quit()
  })()
}

function showTray() {
  const menu = Menu.buildFromTemplate([
    {
      label: "显示 RedCode",
      click: () => {
        mainWindow?.show()
        mainWindow?.focus()
      },
    },
    { type: "separator" },
    { label: "退出", click: confirmQuit },
  ])
  tray = new Tray(iconPath())
  tray.setToolTip("RedCode")
  tray.setContextMenu(menu)
  tray.on("click", () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
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
  /**
   * 260903 cc AUMID 与 userData 目录**分开取值**，别再共用 appId。
   *
   * 原来两者都用 appId，而未打包时的 appId 与 dev 渠道打包版是同一个字符串，于是：
   * 跑一次 `bun dev:desktop`，Electron 为了让 toast 有归属会往开始菜单塞一个
   * 指向 `process.execPath`（= 裸 electron.exe，**无参数**）的快捷方式，并给它写上
   * 这个 AUMID。此后打包版发的系统通知，Windows 按 AUMID 反查快捷方式时会命中那一个，
   * 点击就启动裸 electron.exe —— 屏幕上出现 Electron 的欢迎页而不是回到应用。
   *
   * 实测取证（哥哥机器，2026-09-03）：开始菜单下两个 .lnk 都带 AUMID
   * `ai.redcode.desktop.dev` —— `Electron.lnk`（08-31 建，指向 node_modules 里的
   * electron.exe，参数为空）与 `RedCode Dev.lnk`（09-01 建，指向打包版 exe）。
   *
   * 只改 AUMID、不改 userData：后者是数据目录，跟着变会把已有的 dev 设置/日志甩掉。
   *
   * 未打包版通过独立 AUMID 和带绝对 app 路径参数的快捷方式接收 toast；快捷方式管理见下方 helper。
   */
  const userModelId = app.isPackaged ? appId : `${appId}.unpackaged`
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
  app.setAppUserModelId(userModelId)
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
  // 260921 Red Windows 原生窗口遮挡计算：窗口被盖住时 Chromium 判定页面不可见，跳过布局，
  //   ResizeObserver 不再回调 → virtua 的 viewportSize 停在 0 → 可视区间恒为空 → 整片空白，
  //   且遮挡解除前不自愈（实测 window.innerHeight/innerH 均正常、RO 回调数为 0，一次性对照
  //   实验：不关时被遮挡窗口 document.hidden 恒 true，关掉后恒 false）。
  //   Electron 没有对应 webPreferences——backgroundThrottling 只覆盖 Page Visibility 那一层，
  //   实测打开后 document.hidden 仍为 true。单独关这一个 feature 即可，无需再关遮挡后台化。
  const disabledFeatures = app.commandLine.getSwitchValue("disable-features")
  app.commandLine.appendSwitch(
    "disable-features",
    disabledFeatures ? `CalculateNativeWinOcclusion,${disabledFeatures}` : "CalculateNativeWinOcclusion",
  )
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
    if (details.type !== "Utility" || details.serviceName !== "network.mojom.NetworkService") return
    // 260916 Red Network Service 崩溃渲染层是无感的（连接静默挂死，不报错），只能靠 90s 心跳超时
    //   才重连；这里立刻推一条通知，让渲染层主动拆掉旧事件流重建，把恢复时间从 90s 压到秒级。
    for (const win of BrowserWindow.getAllWindows()) sendNetworkServiceRestart(win)
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
  // 260909 Red 错误通道放宽到 Error：启动失败时 serverReady 要能 fail（渲染层拿到拒绝而非干等）。
  const serverReady = Deferred.makeUnsafe<void, Error>()

  registerIpcHandlers({
    killSidecar: () => killSidecar(),
    restartSidecar: () => supervisor.retry(),
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
    consumeInitialDeepLinks: () => deepLinks.consumeInitial(),
    markDeepLinksReady: () => deepLinks.markReady(),
    getDefaultServerUrl: () => getDefaultServerUrl(),
    setDefaultServerUrl: (url) => setDefaultServerUrl(url),
    getWslConfig: () => Promise.resolve(getWslConfig()),
    setWslConfig: (config: WslConfig) => setWslConfig(config),
    checkAppExists: (appName) => checkAppExists(appName),
    listFonts: () => listFonts(),
    wslPath: async (path, mode) => wslPath(path, mode),
    // 261021 Red 审计 RC21-07：多选时合并成一次 WSL 调用，不再对每个路径各冷启动一次。
    wslPaths: async (paths, mode) => wslPathMany(paths, mode),
    resolveAppPath: async (appName) => resolveAppPath(appName),
    loadingWindowComplete: () => Deferred.doneUnsafe(loadingComplete, Effect.void),
    runUpdater: async (alertOnFail) => checkForUpdates(alertOnFail, killSidecar),
    checkUpdate: async () => checkUpdate(),
    installUpdate: async () => installUpdate(killSidecar),
    setBackgroundColor: (color) => setBackgroundColor(color),
    exportDebugLogs: () => exportDebugLogs(),
    saveGuiDiagnostics: (payload) => writeGuiDiagnostics(payload),
    recordFatalRendererError: (error) => {
      // 260929 Red 渲染层 fatal 也落诊断报告（error boundary 捕到的顶部异常），不只是日志
      const reportPath = writeCrashReport("fatal renderer error", { ...error })
      writeLog("renderer", "fatal renderer error", { ...error, reportPath }, "error")
    },
    getMobileGatewayStatus: () => getMobileGatewayStatus(),
    startMobileGateway: (host, directory, sessionID) => startMobileGateway(host, directory, sessionID),
    refreshMobileGatewayPairingCode: async () => refreshMobileGatewayPairingCode(),
    stopMobileGateway: () => stopMobileGateway(),
    revokeMobileGatewayDevice: (id) => mobileGateway?.revoke(id) ?? false,
  })

  yield* Effect.promise(() => app.whenReady())

  // 260929 Red 托盘只 Windows 需要（darwin 有 Dock）；close→hide 见下方 mainWindow close 监听
  if (process.platform === "win32") showTray()

  // 260916 Red 上一次会话如果是崩溃或被强杀退出的，它的 sidecar 树还留在系统里——
  //   这种退出跑不到任何 cleanup 钩子，只能在下次启动、拉起新 sidecar 之前清一遍。
  //   261024 Red 改为异步起跑：PowerShell 最坏 3×10s + taskkill 10s，同步跑会把主进程
  //   冻结在建窗之前（异常恢复路径上每次必撞）。「清完旧树才起新 sidecar」的先后关系
  //   不放在这里兑现，而是由下方 loadingTask 在 spawn 前显式 await 这条 promise。
  const staleSidecarSweep = beginStaleSidecarSweep()

  // 260903 cc 只有打包版才登记 `redcode://`。
  //   `setAsDefaultProtocolClient` 不传 path/args 时默认用 `process.execPath` + 空参数，
  //   未打包时那就是裸 electron.exe —— 注册完之后系统里的 redcode:// 全部指向它，
  //   点开只会得到 Electron 欢迎页，而且**跑完 dev 之后这个注册还留着**，把打包版的
  //   深链一并弄坏（与上面 AUMID 那条同源：dev 不该冒用打包版的系统身份）。
  //   开发要测深链就带 REDCODE_REGISTER_PROTOCOL=1，此时按 Electron 文档补齐两个参数。
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient("redcode")
  } else if (process.env.REDCODE_REGISTER_PROTOCOL === "1" && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("redcode", process.execPath, [resolve(process.argv[1]!)])
  }

  if (process.platform === "win32") {
    ensureNotificationShortcut({
      platform: process.platform,
      packaged: app.isPackaged,
      appUserModelId: userModelId,
      packagedAppUserModelId: appId,
      displayName: APP_NAMES[CHANNEL],
      startMenuProgramsPath: join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs"),
      userDataPath: app.getPath("userData"),
      execPath: process.execPath,
      appPath: app.isPackaged ? undefined : app.getAppPath(),
      appArguments: process.argv.slice(2),
      cwd: process.cwd(),
      iconPath: iconPath(),
      shell,
      logger,
    })
  }
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

    // 261024 Red spawn 前等启动清扫落地：旧进程清理与新 sidecar 的先后是硬约束，不能为
    //   提速让新旧进程争抢同一棵进程树。清扫 promise 不会 reject（内部已逐条降级），
    //   Effect.promise 的 defect 通道在这里不可达。
    yield* Effect.promise(() => staleSidecarSweep)

    logger.log("spawning sidecar", { url })
    // 260608 Red 启动计时：spawn→ready、ready→healthy 各占多久，定位首页"加载中"瓶颈，测完即删
    const tSpawn = performance.now()
    // 260813 cc 存一份 spawn 参数供猝死自愈重拉（同端口同密码，渲染层免感知）
    sidecarSpawnCfg = { hostname, port, password, userDataPath: app.getPath("userData") }
    nextSpawnHook = {
      needsMigration,
      onSqliteProgress: (progress) => initEmitter.emit("sqlite", progress),
    }
    // 260916 Red only a confirmed health probe reaches the healthy state; timeout/exit
    // rejects startup and is handled by the loading-task failure path below.
    // See docs/notes/implemented/bug-fix/2026-09-16-sidecar-health-contract.md.
    yield* Effect.promise(() => supervisor.start())
    logger.log("[timing] sidecar ready", { ms: Math.round(performance.now() - tSpawn) })

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
  mainWindow.webContents.on("did-start-loading", () => deepLinks.reset())
  // 260929 Red close→hide：X/Alt+F4 只藏窗不退出，后台任务继续跑；真正退出收口到托盘
  //「退出」（confirmQuit）。quitting 为 true（confirmQuit/SIGINT/relaunch/启动失败）时不拦。
  // 仅 win32——darwin 红按钮本就只是关窗，hide 后无 Dock activate 唤醒路径，保持原行为。
  mainWindow.on("close", (event) => {
    if (quitting || process.platform !== "win32") return
    event.preventDefault()
    mainWindow?.hide()
  })
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
  //
  // 260909 Red 启动失败必须响：原先 loadingTask 一失败（spawn 抛错/提前退出被打穿），
  // Fiber.await 把错误重新抛进 main，Effect.runFork 静默吞掉——serverReady 永不完成，
  // 加载窗永远停在"正在启动服务器"；首次启动时 supervisor 还没拿到代次，退出回调
  // 只留下日志、没有任何出路。现在弹窗写明原因后干净退出，重启可清掉瞬时故障；
  // serverReady 先 fail，渲染层的 awaitInitialization 拿到拒绝而不是干等。
  const loadExit = yield* Fiber.await(loadingTask).pipe(Effect.exit)
  if (loadExit._tag === "Failure") {
    const detail = Cause.squash(loadExit.cause)
    const message = detail instanceof Error ? detail.message : String(detail)
    logger.error("sidecar startup failed", { error: message })
    Deferred.failSync(serverReady, () => (detail instanceof Error ? detail : new Error(message)))
    // 260929 Red 弹窗前落诊断报告，路径直接给到弹窗里，省去「该看哪个日志」的排查弯路
    const reportPath = writeCrashReport("sidecar startup failed", { error: message })
    dialog.showErrorBox(
      "RedCode 启动失败",
      `服务进程未能启动：${message}\n\n${reportPath ? `诊断报告：${reportPath}\n\n` : ""}请重启 RedCode 重试；若反复出现，请在反馈里附上这条原因。`,
    )
    app.quit()
    return
  }
  setInitStep({ phase: "done" })
  setInitStep({ phase: "done" })
  Deferred.doneUnsafe(serverReady, Effect.void)
})

Effect.runFork(main)
