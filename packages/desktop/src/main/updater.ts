import { app, dialog } from "electron"
import pkg from "electron-updater"
import { UPDATER_ENABLED } from "./constants"
import { getLogger } from "./logging"

const { autoUpdater } = pkg

// 261116 Red 更新状态必须能区分「禁用 / 有新版 / 无新版 / 检查失败」和下载失败：
//   旧实现把检查异常返回成 updateAvailable:false，设置页据此提示「已是最新版」；
//   下载/安装失败只写日志，界面拿不到任何结果。状态与错误经 IPC 原样回渲染层。
export type UpdateCheckStatus = "disabled" | "available" | "up-to-date" | "failed"
export type UpdateCheckResult = {
  updateAvailable: boolean
  status: UpdateCheckStatus
  version?: string
  error?: string
}
export type UpdateInstallResult =
  | { status: "downloaded"; version: string }
  | { status: "skipped"; reason: "disabled" | "no-update" }
  | { status: "failed"; reason: "check" | "download" | "install"; error: string; version?: string }

let availableVersion: string | undefined
let pendingCheck: Promise<UpdateCheckResult> | undefined
let pendingInstall: Promise<UpdateInstallResult> | undefined

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function setupAutoUpdater() {
  if (!UPDATER_ENABLED) return
  const logger = getLogger()
  autoUpdater.logger = logger
  autoUpdater.channel = "latest"
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  // 261116 Red EventEmitter 的 error 事件没有监听者会直接抛出，失败就变成
  //   主进程崩溃或彻底静默；只记日志，失败仍由下方返回值暴露给界面。
  autoUpdater.on("error", (error: unknown) => logger.error("auto updater error", error))
  logger.log("auto updater configured", {
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
    currentVersion: app.getVersion(),
  })
}

export async function checkUpdate(): Promise<UpdateCheckResult> {
  if (!UPDATER_ENABLED) return { updateAvailable: false, status: "disabled" }
  if (availableVersion) return { updateAvailable: true, status: "available", version: availableVersion }
  if (pendingCheck) return pendingCheck

  pendingCheck = checkForAvailableUpdate().finally(() => {
    pendingCheck = undefined
  })
  return pendingCheck
}

async function checkForAvailableUpdate(): Promise<UpdateCheckResult> {
  const logger = getLogger()
  logger.log("checking for updates", {
    currentVersion: app.getVersion(),
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
  })
  try {
    const result = await autoUpdater.checkForUpdates()
    const updateInfo = result?.updateInfo
    logger.log("update metadata fetched", {
      releaseVersion: updateInfo?.version ?? null,
      releaseDate: updateInfo?.releaseDate ?? null,
      releaseName: updateInfo?.releaseName ?? null,
      files: updateInfo?.files?.map((file) => file.url) ?? [],
    })
    const version = result?.updateInfo?.version
    if (result?.isUpdateAvailable === false || !version) {
      logger.log("no update available", {
        reason: "provider returned no newer version",
      })
      return { updateAvailable: false, status: "up-to-date" }
    }
    logger.log("update available", { version })
    availableVersion = version
    return { updateAvailable: true, status: "available", version }
  } catch (error) {
    logger.error("update check failed", error)
    return { updateAvailable: false, status: "failed", error: errorMessage(error) }
  }
}

export async function installUpdate(killSidecar: () => Promise<void>): Promise<UpdateInstallResult> {
  if (pendingInstall) return pendingInstall
  pendingInstall = downloadAndInstallUpdate(killSidecar).finally(() => {
    pendingInstall = undefined
  })
  return pendingInstall
}

async function downloadAndInstallUpdate(killSidecar: () => Promise<void>): Promise<UpdateInstallResult> {
  const result = await checkUpdate()
  const logger = getLogger()
  const version = availableVersion
  if (result.status === "disabled") {
    logger.log("install update skipped", { reason: "updater disabled" })
    return { status: "skipped", reason: "disabled" }
  }
  if (!result.updateAvailable || !version) {
    logger.log("install update skipped", {
      reason: result.status === "failed" ? "update check failed" : "no update available",
    })
    if (result.status === "failed") {
      return { status: "failed", reason: "check", error: result.error ?? "update check failed" }
    }
    return { status: "skipped", reason: "no-update" }
  }

  logger.log("downloading update", { version })
  try {
    await autoUpdater.downloadUpdate()
  } catch (error) {
    // 保留 availableVersion：下载失败后用户重试仍能直接重新下载，不必再查一次。
    logger.error("update download failed", error)
    return { status: "failed", reason: "download", error: errorMessage(error), version }
  }
  availableVersion = undefined
  logger.log("update download completed", { version })
  logger.log("installing downloaded update", { version })
  try {
    await killSidecar()
    autoUpdater.quitAndInstall()
  } catch (error) {
    logger.error("update install failed", error)
    return { status: "failed", reason: "install", error: errorMessage(error), version }
  }
  return { status: "downloaded", version }
}

export async function checkForUpdates(alertOnFail: boolean, killSidecar: () => Promise<void>) {
  if (!UPDATER_ENABLED) {
    getLogger().log("checkForUpdates skipped", { reason: "updater disabled" })
    return
  }
  const logger = getLogger()
  logger.log("checkForUpdates invoked", { alertOnFail })
  const result = await checkUpdate()
  if (!result.updateAvailable) {
    if (result.status === "failed") {
      logger.log("no update decision", { reason: "update check failed" })
      if (!alertOnFail) return
      await dialog.showMessageBox({
        type: "error",
        message: "Update check failed.",
        detail: result.error,
        title: "Update Error",
      })
      return
    }

    logger.log("no update decision", { reason: "already up to date" })
    if (!alertOnFail) return
    await dialog.showMessageBox({
      type: "info",
      message: "You're up to date.",
      title: "No Updates",
    })
    return
  }

  const response = await dialog.showMessageBox({
    type: "info",
    message: `Update ${result.version ?? ""} is available. Download and restart now?`,
    title: "Update Available",
    buttons: ["Download and Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
  })
  logger.log("update prompt response", {
    version: result.version ?? null,
    restartNow: response.response === 0,
  })
  if (response.response !== 0) return

  const install = await installUpdate(killSidecar)
  if (install.status !== "failed") return
  logger.error("update install failed", { reason: install.reason, error: install.error })
  await dialog.showMessageBox({
    type: "error",
    message: "Update failed.",
    detail: install.error,
    title: "Update Error",
  })
}
