// 260729 Red Tauri 侧的 `window.api` 桥接。
//
// Electron 下这个对象来自 preload（`contextBridge.exposeInMainWorld("api", api)`）；
// Tauri 没有 preload 这一层，得由前端自己在渲染进程里把 `window.api` 建起来，转发到
// `invoke()`。此前 `src-tauri` 已有 28 个 command，但仓库里**没有任何 JS 侧桥接**，
// 于是那些 command 一个都不可达、渲染进程在 Tauri 下直接起不来 —— `index.tsx:69`
// 在模块顶层就无条件调用 `window.api.consumeInitialDeepLinks()`，`window.api` 未定义
// 就是一个模块级 TypeError，白屏且无错误边界（见 tauri-migration-plan.md §1）。
//
// 加载时机：`index.html` 里本文件的 <script type="module"> 排在 `index.tsx` 之前。
// module 脚本按文档顺序执行，且本文件用了顶层 await，后续脚本会等它评估完成，
// 因此 `index.tsx` 拿到的一定是已装好的 `window.api`。
//
// **Electron 下必须是惰性的**：同一份 index.html 两边共用，检测不到 Tauri 就原样返回，
// 绝不能覆盖 preload already 注入好的那个 api。
import { invoke } from "@tauri-apps/api/core"
import { marked } from "marked"
import type {
  ElectronAPI,
  LinuxDisplayBackend,
  ServerReadyData,
  WindowConfig,
  WslConfig,
} from "../preload/types"

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
  }
}

// 按 ElectronAPI 契约声明，让编译器替我们核对 53 个方法一个不漏、签名不走样 ——
// 这正是 preload 那份的价值：两端共用同一个类型，Tauri 侧漏一个就编译不过。
const isTauri = typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined

// 尚未移植的能力统一走这里，便于日后 grep 出还欠哪些，也避免"静默返回 undefined"
// 被误当成功能已就绪。参数保留占位以免 lint 报未使用。
const notPorted =
  (name: string, task: string) =>
  (..._args: unknown[]): never => {
    throw new Error(`window.api.${name} 尚未移植到 Tauri（${task}）`)
  }
const noopUnsubscribe = () => () => {}

async function install() {
  if (!isTauri) return
  if (window.api) return // 已经有了（理论上只可能是 Electron），不覆盖

  // Electron 侧 appVersion 是**字符串属性**不是函数（preload/index.ts:5），
  // 所以这里必须先取回值再装配，不能暴露一个 Promise。
  const appVersion = await invoke<string>("app_version").catch(() => "unknown")

  const api: ElectronAPI = {
    appVersion,

    // ── 已在 Rust 侧实现 ───────────────────────────────────────────
    getWindowConfig: () => invoke<WindowConfig>("get_window_config"),
    getDefaultServerUrl: () => invoke<string | null>("get_default_server_url"),
    setDefaultServerUrl: (url) => invoke<void>("set_default_server_url", { url }),
    getWslConfig: () => invoke<WslConfig>("get_wsl_config"),
    setWslConfig: (config) => invoke<void>("set_wsl_config", { config }),
    getDisplayBackend: () => invoke<LinuxDisplayBackend | null>("get_display_backend"),
    setDisplayBackend: () => invoke<void>("set_display_backend"),
    checkAppExists: () => invoke<boolean>("check_app_exists"),
    wslPath: (path, mode) => invoke<string>("wsl_path", { path, mode }),
    resolveAppPath: (appName) => invoke<string | null>("resolve_app_path", { appName }),
    storeGet: (name, key) => invoke<string | null>("store_get", { name, key }),
    storeSet: (name, key, value) => invoke<void>("store_set", { name, key, value }),
    storeDelete: (name, key) => invoke<void>("store_delete", { name, key }),
    storeClear: (name) => invoke<void>("store_clear", { name }),
    storeKeys: (name) => invoke<string[]>("store_keys", { name }),
    storeLength: (name) => invoke<number>("store_length", { name }),
    getWindowCount: () => invoke<number>("get_window_count"),
    openDirectoryPicker: (opts) => invoke("open_directory_picker", { opts }),
    openFilePicker: (opts) => invoke("open_file_picker", { opts }),
    saveFilePicker: (opts) => invoke<string | null>("save_file_picker", { opts }),
    openLink: (url) => void invoke("open_link", { url }),
    openPath: (path, app) => invoke<void>("open_path", { path, appName: app ?? null }),
    writeAttachment: (sessionDir, filename, data) =>
      invoke<string>("write_attachment", { sessionDir, filename, data: Array.from(data) }),
    showNotification: (title, body) => void invoke("show_notification", { title, body: body ?? null }),
    setBackgroundColor: (color) => invoke<void>("set_background_color", { color }),
    recordFatalRendererError: (error) => invoke<void>("record_fatal_renderer_error", { error }),

    // `await-initialization` 的 onStep 回调依赖 init-step 事件通道，属任务 #6；
    // 在事件接上之前先忽略回调，但**主流程照常走通** —— 首屏握手本身不依赖进度上报。
    awaitInitialization: () => invoke<ServerReadyData>("await_initialization"),

    // ── 刻意留在 JS 侧，不走 invoke ────────────────────────────────
    // 见 tauri-migration-plan.md §8.2：marked 本就是本包的 JS 依赖，换成 Rust 的
    // markdown crate 会让 GFM 边缘行为与 Electron 版出现差异，而输出直接进 UI。
    // 当初放主进程是 Electron 时代的惯性，不是必要。
    parseMarkdownCommand: async (markdown: string) => {
      const renderer = new marked.Renderer()
      renderer.link = ({ href, title, text }: { href: string; title?: string | null; text: string }) =>
        `<a href="${href}"${title ? ` title="${title}"` : ""} class="external-link" target="_blank" rel="noopener noreferrer">${text}</a>`
      return marked(markdown, { renderer, breaks: false, gfm: true })
    },

    // ── 事件订阅：任务 #6 接 Tauri listen，现在返回空退订函数 ──────
    onSqliteMigrationProgress: noopUnsubscribe,
    onMenuCommand: noopUnsubscribe,
    onDeepLink: noopUnsubscribe,
    onPinchZoomEnabledChanged: noopUnsubscribe,
    onZoomFactorChanged: noopUnsubscribe,

    // 任务 #7（deep link + 单实例）。返回空数组而不是抛错 —— index.tsx:69 在模块顶层
    // 无条件调用它，抛出会让整个渲染进程起不来。
    consumeInitialDeepLinks: async () => [] as string[],

    // ── 尚未移植，明确抛错而非静默失败 ────────────────────────────
    killSidecar: notPorted("killSidecar", "任务 #6 sidecar 生命周期"),
    getWindowFocused: notPorted("getWindowFocused", "任务 #6 窗口控制"),
    setWindowFocus: notPorted("setWindowFocus", "任务 #6 窗口控制"),
    showWindow: notPorted("showWindow", "任务 #6 窗口控制"),
    relaunch: notPorted("relaunch", "任务 #6 窗口控制"),
    getZoomFactor: notPorted("getZoomFactor", "任务 #6 zoom"),
    setZoomFactor: notPorted("setZoomFactor", "任务 #6 zoom"),
    getPinchZoomEnabled: notPorted("getPinchZoomEnabled", "任务 #6 zoom"),
    setPinchZoomEnabled: notPorted("setPinchZoomEnabled", "任务 #6 zoom"),
    setTitlebar: notPorted("setTitlebar", "任务 #6 标题栏"),
    runDesktopMenuAction: notPorted("runDesktopMenuAction", "任务 #7 菜单"),
    loadingWindowComplete: notPorted("loadingWindowComplete", "任务 #6 窗口控制"),
    runUpdater: notPorted("runUpdater", "任务 #8 更新器"),
    checkUpdate: notPorted("checkUpdate", "任务 #8 更新器"),
    installUpdate: notPorted("installUpdate", "任务 #8 更新器"),
    readClipboardImage: notPorted("readClipboardImage", "需先定 PNG 编码方案，见 §8"),
    exportDebugLogs: notPorted("exportDebugLogs", "需先选 zip crate，见 §8.3"),
    // Electron 侧这条本来就没有 main 端实现、必然 reject（见 §8.1），此处如实反映
    installCli: notPorted("installCli", "Electron 侧亦无实现，见 §8.1"),
  }

  window.api = api
}

await install()
