import { describe, expect, mock, test } from "bun:test"

const logger = {
  log: mock(),
  error: mock(),
}
const autoUpdater = {
  channel: "",
  allowPrerelease: false,
  allowDowngrade: false,
  autoDownload: true,
  autoInstallOnAppQuit: true,
  checkForUpdates: mock(async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: "0.12.0" },
  })),
  downloadUpdate: mock(async () => []),
  quitAndInstall: mock(),
}

mock.module("electron", () => ({
  app: {
    getVersion: () => "0.11.0",
    isPackaged: true,
  },
  dialog: {
    showMessageBox: mock(),
  },
}))
mock.module("electron-updater", () => ({
  default: { autoUpdater },
}))
mock.module("./constants", () => ({
  UPDATER_ENABLED: true,
}))
mock.module("./logging", () => ({
  getLogger: () => logger,
}))

const { checkUpdate, installUpdate, setupAutoUpdater } = await import("./updater")

describe("desktop updater", () => {
  test("downloads only after the user installs an available update", async () => {
    setupAutoUpdater()

    await expect(checkUpdate()).resolves.toEqual({
      updateAvailable: true,
      version: "0.12.0",
    })
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()

    const killSidecar = mock(async () => {})
    await installUpdate(killSidecar)

    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(killSidecar).toHaveBeenCalledTimes(1)
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
  })
})
