import { describe, expect, mock, test } from "bun:test"

const logger = {
  log: mock(),
  error: mock(),
}
const constants = { enabled: true }
const autoUpdater = {
  channel: "",
  allowPrerelease: false,
  allowDowngrade: false,
  autoDownload: true,
  autoInstallOnAppQuit: true,
  on: mock(),
  checkForUpdates: mock(async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: "0.12.0" },
  })),
  downloadUpdate: mock(async () => []),
  quitAndInstall: mock(),
}
const dialog = {
  showMessageBox: mock(async () => ({ response: 1 })),
}

mock.module("electron", () => ({
  app: {
    getVersion: () => "0.11.0",
    isPackaged: true,
  },
  dialog,
}))
mock.module("electron-updater", () => ({
  default: { autoUpdater },
}))
mock.module("./constants", () => ({
  get UPDATER_ENABLED() {
    return constants.enabled
  },
}))
mock.module("./logging", () => ({
  getLogger: () => logger,
}))

const { checkUpdate, installUpdate, setupAutoUpdater } = await import("./updater")

// 顺序有依赖：模块内 availableVersion 会缓存成功检查结果，下面各测试按「无缓存 → 失败 → 无更新 → 有更新
// → 下载失败（保留缓存以便重试）→ 下载成功（清缓存）→ 无更新」排列。
describe("desktop updater", () => {
  test("reports a failed check instead of claiming the app is up to date", async () => {
    autoUpdater.checkForUpdates.mockImplementationOnce(async () => {
      throw new Error("offline")
    })

    await expect(checkUpdate()).resolves.toEqual({ updateAvailable: false, status: "failed", error: "offline" })
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  test("reports up-to-date only when the provider returns no newer version", async () => {
    autoUpdater.checkForUpdates.mockImplementationOnce(async () => ({
      isUpdateAvailable: false,
      updateInfo: { version: "0.11.0" },
    }))

    await expect(checkUpdate()).resolves.toEqual({ updateAvailable: false, status: "up-to-date" })
  })

  test("reports the available version without downloading it", async () => {
    setupAutoUpdater()

    await expect(checkUpdate()).resolves.toEqual({ updateAvailable: true, status: "available", version: "0.12.0" })
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
  })

  test("keeps the update available for retry when the download fails", async () => {
    autoUpdater.downloadUpdate.mockImplementationOnce(async () => {
      throw new Error("connection reset")
    })
    const killSidecar = mock(async () => {})

    await expect(installUpdate(killSidecar)).resolves.toEqual({
      status: "failed",
      reason: "download",
      error: "connection reset",
      version: "0.12.0",
    })
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled()
    expect(killSidecar).not.toHaveBeenCalled()

    await expect(checkUpdate()).resolves.toEqual({ updateAvailable: true, status: "available", version: "0.12.0" })
  })

  test("downloads and hands off to the installer when the user installs", async () => {
    const killSidecar = mock(async () => {})

    await expect(installUpdate(killSidecar)).resolves.toEqual({ status: "downloaded", version: "0.12.0" })
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(2)
    expect(killSidecar).toHaveBeenCalledTimes(1)
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  test("skips install when no update is available", async () => {
    autoUpdater.checkForUpdates.mockImplementationOnce(async () => ({
      isUpdateAvailable: false,
      updateInfo: { version: "0.11.0" },
    }))
    const killSidecar = mock(async () => {})

    await expect(installUpdate(killSidecar)).resolves.toEqual({ status: "skipped", reason: "no-update" })
    expect(killSidecar).not.toHaveBeenCalled()
  })
})
