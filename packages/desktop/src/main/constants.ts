import { app } from "electron"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.REDCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const SETTINGS_STORE = "redcode.settings"

// 261119 Red appId 从 index.ts 挪入：桌宠宿主（--pet-host）要用同一 appId 派生独立 userData，
// 不能复用 GUI 的（requestSingleInstanceLock 按 userData 目录区分，同目录两进程锁会互斥）。
const APP_IDS: Record<string, string> = {
  dev: "ai.redcode.desktop.dev",
  beta: "ai.redcode.desktop.beta",
  prod: "ai.redcode.desktop",
}

export function desktopAppId() {
  return app.isPackaged ? APP_IDS[CHANNEL] : "ai.redcode.desktop.dev"
}

export const DEFAULT_SERVER_URL_KEY = "defaultServerUrl"
export const WSL_ENABLED_KEY = "wslEnabled"
export const PINCH_ZOOM_ENABLED_KEY = "pinchZoomEnabled"
export const QUIT_CONFIRM_DISABLED_KEY = "quitConfirmDisabled"
export const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev"
