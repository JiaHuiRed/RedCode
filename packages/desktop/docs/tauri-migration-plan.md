# GUI Electron → Tauri 迁移设计方案

> 2026-07-18 可行性预研产出。本文只是设计方案 + 已验证结论，尚未开始实施。
> 目标环境：**仅 Windows、自用**（不考虑 macOS / Linux WebView 一致性）。

## 0. 为什么做

- **体积**：Electron 42.x 把整个 Chromium/V8 编进主 exe，`RedCode Dev.exe` 单文件 232MB，与原装 `electron.exe`（232,313,344 字节）只差 108KB——RedCode 自己的代码一点没往里加，这块靠配置无法优化（已在 0.7.7 排查确认）。Tauri 在 Windows 复用系统自带 WebView2，壳体积通常个位数 MB，不背 Chromium。
- 语言包裁剪 + effect/drizzle-orm 打包已让安装目录从 500M 降到 405M（0.7.7），但主 exe 那 232M 是 Electron 架构决定的硬地板，只有换运行时才能突破。

## 1. 已验证的结论（原型实测，非推测）

用编译好的 `redcode.exe serve` 当 Tauri sidecar，加了个几十行的 `window.api` 桩，实测跑到"渲染出真实 UI、只差 server 握手时序"：

| 项 | 结论 | 证据 |
|---|---|---|
| **sidecar 架构** | ✅ 可行 | `redcode.exe serve --port 6183` 被 Tauri `externalBin` 拉起，`curl http://127.0.0.1:6183/` 返回 200，两次复现 |
| **渲染层兼容性** | ✅ 像素级还原 | 整个 SolidJS bundle、Tailwind、字体、错误边界组件在 WebView2 里零 CSS/字体/渲染问题 |
| **IPC 桥** | ⚠️ 需重写，规模明确 | preload 暴露 55 个方法（见 §3），renderer 实际用到 39 个；几十行桩就能让页面跑起来 |
| **首屏 server 握手** | ⚠️ 时序，非 Tauri 限制 | `main-CQ_dqgNI.js:59198` 的 `GlobalSDKProvider` 在 `server.key` 已置位但 `server.current` 列表未就绪时抛 "No server available"——纯前端信号时序竞争，真实 IPC（近同步 invoke）走的路径不同，�CB桩用独立 Promise 才触发 |

**关键判断**：风险最大的两块（sidecar 能不能跑、WebView2 渲不渲染得出来）都已拿到实证。剩下是工作量明确、可拆解的桥接层重写，不是探索性风险。

## 2. 架构对照

| Electron 侧 | Tauri 侧 | 备注 |
|---|---|---|
| `utilityProcess.fork(sidecar.js)`（`server.ts:98`）跑 opencode server | `tauri-plugin-shell` 的 sidecar（`externalBin`）拉 `redcode.exe serve` | 原型已跑通。sidecar.ts 里的 env 准备/系统证书/代理逻辑（`sidecar.ts:130-175`）需要在 `serve` 命令启动前用等价环境变量注入 |
| `preload.ts` + `contextBridge` 暴露 `window.api` | `tauri::generate_handler!` 注册 command + `invoke` | renderer 侧调用点全走 `window.api.*`，可先加一层 shim 转发到 `invoke`，逐个替换 |
| `ipcMain.handle/on`（`ipc.ts`、`index.ts:356+`） | `#[tauri::command]` 函数 | 一对一 |
| `electron-store` | `tauri-plugin-store` | store 名 → JSON 文件；迁移见 §5 |
| `electron-updater` | `tauri-plugin-updater` + `tauri-plugin-process` | 更新签名格式要换；现有 `finalize-latest-*.ts` 已经在用 `@tauri-apps/cli signer`（历史遗留），反而对得上 |
| `electron-window-state` | `tauri-plugin-window-state` | |
| `electron-log` | `tauri-plugin-log` | 原型已用 |
| `electron-context-menu` | Tauri `Menu`/`Submenu` API 或自绘 | |
| `dialog.showOpenDialog` 等 | `tauri-plugin-dialog` | 原生文件/目录/保存选择器 |
| `shell.openExternal` / `openPath` | `tauri-plugin-opener` | |
| `clipboard.readImage` | `tauri-plugin-clipboard-manager` | |
| `Notification` | `tauri-plugin-notification` | |
| deep link（`redcode://`） | `tauri-plugin-deep-link` | 单实例 + 协议注册 |

## 3. IPC 桥迁移清单（55 方法，按类别）

按迁移难度分三档：

**A. 纯数据 invoke，一对一直译（易）** — `store-get/set/delete/clear/keys/length`(6)、`parse-markdown`、`check-app-exists`、`resolve-app-path`、`get/set-default-server-url`、`get/set-wsl-config`、`wsl-path`、`get/set-display-backend`、`get-window-config`、`get-window-count`、`set-background-color`、`export-debug-logs`、`record-fatal-renderer-error`、`install-cli`

**B. 走 Tauri 插件（中）** — 文件选择器 `open-directory/file-picker`、`save-file-picker` → dialog 插件；`open-link`/`open-path` → opener；`read-clipboard-image` → clipboard-manager；`show-notification` → notification；`write-attachment` → fs 插件（注意保留 0.6.15 的路径遍历防御，`ipc.ts` 里的 resolve 校验）；updater 三件套 `run-updater/check-update/install-update`

**C. 事件通道 + 窗口控制（中，需 Rust 侧状态）** — 事件：`init-step`、`sqlite-migration-progress`、`menu-command`、`deep-link`、`pinch-zoom-enabled-changed`、`zoom-factor-changed` → Tauri `app.emit` + 前端 `listen`；窗口：`get-window-focused`/`set-window-focus`/`show-window`/`relaunch`/`set-titlebar`/`loading-window-complete`/zoom factor 相关 → WebviewWindow API；sidecar 生命周期 `kill-sidecar`/`await-initialization`（含首屏 init step 流）

renderer 侧调用点集中在 `src/renderer/index.tsx`（39 处）+ `titlebar.tsx`（已有 `window.__TAURI__` 检测的历史残留，反而好改）。

## 4. 已知坑

1. **首屏 server 握手时序**（§1）：真实 sidecar 的 `await-initialization` 会同步返回 `{url, username, password}`，而 `getDefaultServerUrl` 返回 null（无持久化默认 server 时）。原型里两个独立 Promise 造成竞争。迁移时让 `await-initialization` 对应的 command **同步/尽早** resolve，且 `getDefaultServerUrl` 忠实返回 null（不要为了"有个 server"乱塞），让 `ServerProvider` 走正常的 sidecar 注入路径。
2. **sidecar env 注入**：`sidecar.ts` 现在在 fork 后于子进程内 `prepareSidecarEnv`（设 `REDCODE_SERVER_PASSWORD`、`XDG_STATE_HOME`、loopback NO_PROXY、系统证书、env 代理）。Tauri sidecar 是外部进程，这些得在 spawn 时通过 `.env()` / `.envs()` 传入，或让 `redcode serve` 自己读环境。密码要用随机生成而非硬编码（现在 Electron 侧就是随机的）。
3. **WebView2 运行时依赖**：目标机已装（150.0.4078.65）。分发时要么假设系统已有（Win10/11 大多自带），要么带 Evergreen Bootstrapper——Tauri 支持配置。
4. **单实例 + deep link**：`redcode://` 协议注册和"已开窗口时把 deep link 转发给现有实例"需要 `tauri-plugin-single-instance` + `deep-link`。

## 5. 数据迁移

老用户从 Electron 版升级时，`electron-store` 的 JSON 需要迁到 `tauri-plugin-store`。注意：**RedCode 曾经就是 Tauri**（fork 自 opencode 时上游是 Electron，更早 opencode 用过 Tauri），`src/main/migrate.ts` 里还留着"从 Tauri `.dat` 迁到 electron-store"的完整逻辑——迁回 Tauri 时这段可作反向参考。自用场景下，也可以直接手动搬一次配置文件，省掉迁移代码。

## 6. 分阶段实施建议

1. **阶段一 · 骨架跑通**：Tauri 项目 + sidecar 拉起 `redcode serve` + `window.api` shim（转发到 invoke，缺的先 stub）→ 目标：首屏真正连上 sidecar、聊天界面能用。**先解决 §4.1 的握手时序**。
2. **阶段二 · 核心 IPC**：A 档全部直译 + store（含数据迁移或手动搬）+ 文件选择器 + open-link/path + 剪贴板 → 目标：日常功能齐全。
3. **阶段三 · 窗口/系统集成**：窗口状态记忆、标题栏、zoom、菜单、通知、deep link、单实例 → 目标：体验对齐 Electron 版。
4. **阶段四 · 更新器 + 打包**：updater 插件 + 签名 + `tauri build` 产物验证 → 目标：可发布，验证最终体积。
5. **阶段五 · 清理**：删 `packages/desktop` 的 Electron 依赖（electron/electron-builder/electron-*），`window.api` shim 收敛成正式 invoke 封装。

## 7. 尚未验证 / 待确认

- 阶段一的握手时序修复没在原型里跑通（环境不稳定，且属于 RedCode 自己的 SolidJS 信号时序，非 Tauri 问题）——真正做时优先解决。
- ~~`tauri build` 的最终产物体积没实测~~ **已实测（2026-07-21），见 §7.1。**
- updater 端到端（生成→签名→自动更新）没验证。

### 7.1 产物体积实测（2026-07-21）

真实构建，非估算：最小 Tauri 壳（release，LTO+strip，`opt-level=s`）+ 完整嵌入当前 `packages/desktop/out/renderer`（47M 真实 SolidJS/Tailwind 产物）+ 当天编译的真实 `redcode.exe`（0.7.31，138MB）作为 externalBin sidecar，跑通 `cargo tauri build` 出 NSIS 安装包。

| 产物 | 体积 | 说明 |
|---|---|---|
| Tauri 壳体裸 exe | **14.52 MB**（13.85 MiB） | `target/release/redcode-tauri-proto.exe`，已含嵌入的 47M 前端资源（压缩后） |
| sidecar `redcode.exe` | 144.74 MB（138.03 MiB） | 当天 0.7.31 真实构建，比 §7 原估算 126MB 略大 |
| **两文件合计（壳+sidecar 落地体积）** | **159.26 MB** | 对应 Electron 当前单文件 `RedCode Dev.exe` 232.42 MB —— **减少约 31.5%** |
| NSIS 安装包（LZMA 压缩后，用户实际下载体积） | 47.81 MB（45.59 MiB） | sidecar 是 Bun 编译产物、内含大量可压缩的 JS/文本，压缩比约 3.6x |

**结论**：壳体积比 §1 估算的“个位数 MB”略高但仍然极小（14.5MB vs Electron 232MB 里 Chromium/V8 占的大头），**真正的体积瓶颈是 sidecar 本身（138MB，自身架构决定，与 Electron/Tauri 选型无关）**。如果要进一步压缩，方向是瘦身 `redcode.exe`（baseline target、精简依赖），而不是继续抠 Tauri 壳。安装包（用户下载体积）从 Electron 的 232MB 降到 47.8MB，是更直观的可感知收益。

方法留痕：sidecar 复用了当时已在跑的另一会话编译产物（`packages/opencode/dist/redcode-windows-x64/bin/redcode.exe`，该文件被运行中进程锁定，构建脚本重新编译会 EPERM，故直接拷贝复用，未触碰该进程）。Tauri 侧工程本身是本次会话在 scratchpad 新建的一次性最小工程（仅 `tauri-plugin-shell`，无真实 IPC），测完即弃，不在仓库内。

---

**原型残留**：可行性验证的 Tauri 工程在临时 scratchpad 目录（非仓库），会话结束即弃。本文是唯一需要保留的产出。
