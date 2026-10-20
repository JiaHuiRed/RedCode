import type { BrowserWindow, Session, WebContents } from "electron"
import { isTrustedRendererUrl } from "./renderer-url"

// 260907 ZCode Electron 44 clipboard W3C 化：读图改走 navigator.clipboard.read()，需要 clipboard-read 权限。
const rendererPermissions = new Set(["clipboard-sanitized-write", "clipboard-read", "notifications"])
const registeredSessions = new WeakSet<Session>()

function isTrustedWindow(webContents: WebContents, windows: BrowserWindow[]) {
  return windows.some(
    (win) =>
      !win.isDestroyed() && win.webContents.id === webContents.id && isTrustedRendererUrl(win.webContents.getURL()),
  )
}

// 261020 Red Permission handlers belong to the shared Session; register once and authorize each live renderer window.
// 261020 Red 决策记录：docs/notes/implemented/bug-fix/2026-10-20-electron-session-permissions.md
export function allowRendererPermissions(session: Session, getWindows: () => BrowserWindow[]) {
  if (registeredSessions.has(session)) return

  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(
      rendererPermissions.has(permission) &&
        isTrustedRendererUrl(details.requestingUrl) &&
        isTrustedWindow(webContents, getWindows()),
    )
  })
  session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    if (!rendererPermissions.has(permission)) return false
    if (!isTrustedRendererUrl(details.requestingUrl) && !isTrustedRendererUrl(requestingOrigin)) return false
    return !webContents || isTrustedWindow(webContents, getWindows())
  })

  registeredSessions.add(session)
}
