import { createSimpleContext } from "@redcode-ai/ui/context"
import type { AsyncStorage, SyncStorage } from "@solid-primitives/storage"
import type { Accessor } from "solid-js"
import type { DesktopMenuAction } from "../desktop-menu"
import type { DesktopPetBridge } from "../pet/desktop-pet"
import { ServerConnection } from "./server"

type PickerPaths = string | string[] | null
type OpenDirectoryPickerOptions = { title?: string; multiple?: boolean }
type OpenFilePickerOptions = { title?: string; multiple?: boolean; accept?: string[]; extensions?: string[] }
type SaveFilePickerOptions = { title?: string; defaultPath?: string }
export type UpdateCheckStatus = "disabled" | "available" | "up-to-date" | "failed"
// status 缺失只可能是旧的渲染层桥（例如布局兜底对象）：调用方按「失败」处理，不降级成「已是最新版」。
export type UpdateInfo = { updateAvailable: boolean; status?: UpdateCheckStatus; version?: string; error?: string }
export type UpdateInstallResult =
  | { status: "downloaded"; version?: string }
  | { status: "skipped"; reason: "disabled" | "no-update" }
  | { status: "failed"; reason: "check" | "download" | "install"; error: string; version?: string }
type PlatformName = "web" | "desktop"
type DesktopOS = "macos" | "windows" | "linux"

export type FatalRendererErrorLog = {
  error: string
  url: string
  version?: string
  platform: PlatformName
  os?: DesktopOS
}

export type MobileGatewayHost = { address: string; name: string }
export type MobileGatewayDevice = { id: string; name: string; pairedAt: number }
export type MobileGatewayStartInfo = {
  url: string
  host: string
  port: number
  pairingCode: string
  pairingExpiresAt: number
  fingerprint: string
}
export type MobileGatewayStatus = {
  hosts: MobileGatewayHost[]
  running: boolean
  info: MobileGatewayStartInfo | null
  devices: MobileGatewayDevice[]
}

export type LogDirectories = {
  desktop: string
  currentRun: string
  server: string[]
}

export type Platform = {
  /** Platform discriminator */
  platform: PlatformName
  /** Android WebView companion mode */
  mobileCompanion?: boolean

  /** Desktop OS (Electron desktop only) */
  os?: DesktopOS

  /** App version */
  version?: string

  /** Open a URL in the default browser */
  openLink(url: string): void

  /** Open a self-contained HTML document preview in the default browser (desktop only) */
  openHtmlPreview?(document: string): Promise<void>

  /** Open a local path in a local app (desktop only) */
  openPath?(path: string, app?: string): Promise<void>

  /** Reveal a local file in the system file manager (desktop only) */
  revealPath?(path: string): Promise<void>

  /** Restart the app  */
  restart(): Promise<void>

  /** Navigate back in history */
  back(): void

  /** Navigate forward in history */
  forward(): void

  /** Send a system notification (optional deep link); true means created, false/void means not sent */
  notify(title: string, description?: string, href?: string): Promise<boolean | void>

  /** Open directory picker dialog (native on desktop, server-backed on web) */
  openDirectoryPickerDialog?(opts?: OpenDirectoryPickerOptions): Promise<PickerPaths>

  /** Open native file picker dialog (desktop only) */
  openFilePickerDialog?(opts?: OpenFilePickerOptions): Promise<PickerPaths>

  /** Save file picker dialog (desktop only) */
  saveFilePickerDialog?(opts?: SaveFilePickerOptions): Promise<string | null>

  /** Storage mechanism, defaults to localStorage */
  storage?: (name?: string) => SyncStorage | AsyncStorage

  /** Check for a downloadable desktop update */
  checkUpdate?(): Promise<UpdateInfo>

  /** Download and install the available update, reporting where it stopped */
  updateAndRestart?(): Promise<UpdateInstallResult>

  /** Fetch override */
  fetch?: typeof fetch

  /** Get the configured default server URL (platform-specific) */
  getDefaultServer?(): Promise<ServerConnection.Key | null>

  /** Set the default server URL to use on app startup (platform-specific) */
  setDefaultServer?(url: ServerConnection.Key | null): Promise<void> | void

  /** Get the configured WSL integration (desktop only) */
  getWslEnabled?(): Promise<boolean>

  /** Set the configured WSL integration (desktop only) */
  setWslEnabled?(config: boolean): Promise<void> | void

  /** Webview zoom level (desktop only) */
  webviewZoom?: Accessor<number>

  /** 桌面端 Network Service 子进程崩溃重启的次数（desktop only）。
      递增即代表本地请求刚被整批掐断，事件流需要立刻重建。 */
  networkServiceRestart?: Accessor<number>

  /** Native desktop pet window bridge; absent means the inline GUI pet stays in charge (desktop only) */
  desktopPet?: DesktopPetBridge

  /** Get whether native pinch/Ctrl-scroll zoom gestures are enabled (desktop only) */
  getPinchZoomEnabled?(): Promise<boolean> | boolean

  /** Allow native pinch/Ctrl-scroll zoom gestures (desktop only) */
  setPinchZoomEnabled?(enabled: boolean): Promise<void> | void

  /** Run a desktop-only menu action from the app chrome */
  runDesktopMenuAction?(action: DesktopMenuAction): Promise<void> | void

  /** Check if an editor app exists (desktop only) */
  checkAppExists?(appName: string): Promise<boolean>

  /** List font families installed on this machine (desktop only) */
  listFonts?(): Promise<string[]>

  /** Read image from clipboard (desktop only) */
  readClipboardImage?(): Promise<File | null>

  /** Write an image attachment to sessionDir/.attachments/ (desktop only) */
  writeAttachment?(sessionDir: string, filename: string, data: Uint8Array): Promise<string>

  /** Export collected diagnostic logs (desktop only) */
  exportDebugLogs?(): Promise<string>

  /** Actual log locations on this desktop host, independent of the selected server */
  getLogDirectories?(): Promise<LogDirectories>
  openLogDirectory?(kind: "desktop" | "server"): Promise<void>

  /** Persist the sanitized GUI diagnostics payload into the current log directory so the next debug-log export includes it (desktop only) */
  saveGuiDiagnostics?(payload: string): Promise<string | null>

  /** Record a fatal renderer error in platform logs (desktop only) */
  recordFatalRendererError?(error: FatalRendererErrorLog): Promise<void>

  /** Manage the explicitly enabled mobile companion Gateway (desktop only) */
  getMobileGatewayStatus?(): Promise<MobileGatewayStatus>
  startMobileGateway?(host: string, directory: string, sessionID: string): Promise<MobileGatewayStartInfo>
  refreshMobileGatewayPairingCode?(): Promise<MobileGatewayStartInfo>
  stopMobileGateway?(): Promise<void>
  revokeMobileGatewayDevice?(id: string): Promise<boolean>
}

export const { use: usePlatform, provider: PlatformProvider } = createSimpleContext({
  name: "Platform",
  init: (props: { value: Platform }) => {
    return props.value
  },
})
