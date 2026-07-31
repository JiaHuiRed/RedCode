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
| **首屏 server 握手** | ✅ 已解决（见 §7.2） | 根因是两个 IPC 桩（`await-initialization`/`get-default-server-url`）时序不对，不是 Tauri 限制、不用改 renderer。真实 command 严格按 sidecar 就绪时序 resolve 后，`<Show>` 门槛正常放行，`GlobalSDKProvider` 不再抛 "No server available" |

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

- ~~阶段一的握手时序修复没在原型里跑通~~ **已实测跑通（2026-07-23），见 §7.2。**
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

### 7.2 首屏握手时序 —— 已跑通（2026-07-23）

在 §7.1 那个原型基础上，这次把 `await-initialization`/`get-default-server-url` 换成两个真实 Tauri command（不再是猜时序的桩）：

- `await_initialization`：真的 `tauri-plugin-shell` 拉起 `redcode serve`，解析 stdout 的 `listening on http://...` 拿到真实 url，**resolve 严格晚于 sidecar 真正就绪**，不再有"两个独立 Promise 抢跑"的问题。
- `get_default_server_url`：老实返回 `None`（对应 `null`），不为了"看着有个 server"瞎填。

结果：真实 renderer bundle（未做任何魔改）从 `GlobalSDKProvider` 的 `"No server available"` 硬崩，变成完整渲染出项目列表、会话卡片、缓存/花费统计——`<Show when={!defaultServer.loading && !sidecar.loading && ...}>` 这道已有的门槛本身没问题，之前卡住纯粹是因为两个 IPC 桩实现的时序不对。**结论：§4.1 那条坑的修法（"command 尽早/严格 resolve，getDefaultServerUrl 老实返回 null"）验证有效，不需要改 renderer 侧任何代码。**

顺带在同一轮原型里发现并修好三个配套问题（都属于"照抄 Electron 语义"范畴，不是新坑）：

1. **窗口装饰重复**：Tauri 窗口默认原生装饰 + renderer 自己画的 macOS 风格红黄绿标题栏叠在一起。Electron 侧 Windows 下已经是 `frame: false` + `titleBarStyle: "hidden"`（`main/windows.ts:136-140`），Tauri 对应项是 `decorations: false`，一行配置解决。
2. **窗口控制按钮被 ACL 拦截**：`window.close()/.minimize()/.toggleMaximize()` 这类核心窗口命令直接从前端 invoke 时会被 Tauri v2 权限系统拦（`Command plugin:window|minimize not allowed by ACL`），报错是 unhandledrejection、界面上完全无提示，容易误判成"没绑定"。需要 `src-tauri/capabilities/*.json` 显式声明 `core:window:allow-close/minimize/toggle-maximize`。自定义 `#[tauri::command]`（比如 `await_initialization`）不受此限——只有前端直接调 Tauri 核心/插件命令才要过 ACL。
3. **`window.api.storeGet/Set` 桩必须是真实持久化，不能偷懒**：desktop 侧侧边栏"最近打开的工作区"列表是从这层持久化状态读的，不是直接照抄 `/project` 接口的返回（那个接口本身没问题，全量数据都在）。用一个 JSON 文件桩实现（一个 store name 一个文件）验证后，侧边栏行为符合预期——新目录只有实际在 app 里打开过的才会被记住并跨重启保留。**这确认了 §3-A 档"IPC 直译"里 store 那六个方法不能简化成假的 no-op，得是真持久化**，正式实现建议直接上 §2 表格里定的 `tauri-plugin-store`。

**一个没修、但确认是部署方式问题不是产品问题的发现**：这次原型的 sidecar 二进制放在临时 scratch 目录（不在真实安装目录结构里），`findRedcodeRoot()`（`mcp/index.ts`，今天早些时候为 `$REDCODE_ROOT` 修的那个函数）两条兜底路径都找不到 RedCode 安装根，回退到"当前项目目录"——这次因为原型里当前项目恰好就是 `E:\AI\RedCode` 本身，所有本地 MCP 意外地全部连接成功，掩盖了问题。换成任何其他项目目录，这个巧合就没了，本地 MCP 会重现今天早上修过的同一个坑。**真正装包时不会有这个问题**——现有 Electron dist 产物本身就在 sidecar 旁边放了一份 `package.json`（`build.ts` 里 `dist/${name}/package.json`），`findRedcodeRoot()` 的 exe 路径向上找分支能正常命中；Tauri 打包时只要复刻同样的目录结构（sidecar 与 `package.json`/`.opencode` 同级）就没有这问题，纯粹是这次图快搭的 scratch 原型没还原完整安装布局。

---

**原型残留**：可行性验证的 Tauri 工程在临时 scratchpad 目录（非仓库），会话结束即弃。本文是唯一需要保留的产出。

---

## 8. A 档收尾结论（2026-07-29）

A 档 22 项里 19 项已移植（见 `src-tauri/src/main.rs`）。剩下 3 项经核实**都不该照着方法名直译**，逐条记录原因，免得下次又被当成"待办"重新拾起来：

### 8.1 `install-cli` —— Electron 里就是坏的，无可移植

`preload/index.ts:7` 声明了 `ipcRenderer.invoke("install-cli")`，`renderer/cli.ts:7` 也在调，但**全仓库不存在 `ipcMain.handle("install-cli", …)`**。也就是说这条 IPC 从写下来那天起就必然 reject，只是 `renderer/cli.ts` 用 try/catch 包住、弹了个失败 alert，所以没人注意到。

结论：Tauri 侧不实现。要真做"安装 CLI"功能，得先决定安装位置与 PATH 写入策略，那是新功能不是移植。

### 8.2 `parse-markdown` —— 不该跨进程，应该留在渲染进程

Electron 侧（`main/markdown.ts`）用的是 JS 库 `marked` 加一个自定义 link renderer（给外链加 `class="external-link" target="_blank" rel="noopener noreferrer"`）。

移植到 Rust 意味着换一个 markdown crate（comrak / pulldown-cmark），**GFM 边缘行为必然与 `marked` 有出入**，而它的输出直接进 UI。为了一个纯字符串变换去赌解析器行为一致，收益为负。

而且 `marked` 本来就是 `packages/desktop` 自己的 JS 依赖（`package.json:34`），渲染进程完全可以直接 import。当初放进主进程是 Electron 时代的惯性，不是必要。

结论：Tauri 侧不实现该 command。等写 `window.api` shim 时，`parseMarkdownCommand` 直接在 shim 的 JS 里调 `marked`，不走 invoke。

### 8.3 `export-debug-logs` —— 需要先定 zip 方案，暂缓

`logging.ts:57` 把若干日志目录打包成 zip 落到下载目录。Rust 侧要引 zip crate（`zip` / `async_zip`），并决定是否保留 Electron 那套 `XDG_DATA_HOME` 兜底路径收集逻辑（`logging.ts:153-154`）。工作量不大但需要选型，未做。

`record-fatal-renderer-error` 已移植（写 `app_log_dir()/<启动时间戳>/renderer.log`），未连带移植 `initLogging`/`initCrashReporter`/netLog —— 那几个依赖 Electron 的 crashReporter 与 net-log，Tauri 无对等物，需要单独设计。

### 8.4 真正的下一个阻塞：`window.api` shim 尚不存在

目前 `src-tauri` 已有 **28 个 command**，但仓库里**没有任何 JS 侧的 `window.api` → `invoke()` 桥接**（`grep -rl "@tauri-apps/api|__TAURI__" packages/desktop/src` 无结果）。原型里那份 shim 活在临时目录、从未提交。

也就是说：这 28 个 command 目前**一个都不可达**，渲染进程在 Tauri 下仍然起不来（`window.api` 未定义时 `renderer/index.tsx` 模块顶层就会崩，见 §1）。

这比 A 档剩下那几项重要得多，应作为下一步，优先于任务 #6。

## 9. 跨语言边界的漂移防护（2026-07-31）

§8.4 描述的阻塞已解除（shim 于 07-29 落地）。本节记录随后补上的**契约层**——
shim 用 `ElectronAPI` 类型守住了 TS 那一半，但 `invoke("store_get", { name, key })`
里的命令名与参数名是字符串字面量，Rust 侧改名、改参数、漏登记 `generate_handler![]`，
编译器全都看不见，只在用户点下去时报 `Command not found`。

### 9.1 生成物（编译期）

`scripts/gen-tauri-commands.ts` 解析 `src-tauri/src/main.rs`，生成
`src/renderer/tauri-commands.generated.ts`：

- `TauriCommandArgs` —— 每个 command 的 payload 键名与类型（snake_case → camelCase，
  与 Tauri v2 的默认转换一致；`AppHandle`/`State` 等注入参数不计入）
- `TauriCommandResult` —— resolve 出来的类型（`Result<T, E>` 取 `T`，`Err` 走 reject）
- `TAURI_COMMANDS` —— `generate_handler![]` 里登记过、因而真正可调用的名字

shim 里唯一允许直接碰 `invoke` 的是 `call()` 包装，其余调用全部经它，于是命令名/参数名/
返回类型三者的漂移都变成编译错误。已实测：把 `resolve_app_path` 的参数改名后
`tsgo -b` 报 `'appName' does not exist in type '{ applicationName: string }'`。

生成器遇到映射不了的 Rust 类型直接抛错，不吐 `any` —— 一个错的类型比没有类型更糟。

命令：`bun --cwd packages/desktop run gen:tauri-commands`（加 `-- --check` 只校验不写入）。

### 9.2 契约测试（编译器看不见的那一半）

`src/renderer/tauri-command-contract.test.ts`：

1. 生成物与 `main.rs` 同步（等价于 `--check`，CI 走 `bun turbo test:ci` 这条路）
2. 每个 `#[tauri::command]` 都登记在 `generate_handler![]`，反之亦然
3. **返回集合的 command 不得把集合包在 `Option` 里** —— `Vec<T>` 序列化必是数组，
   `Option<Vec<T>>` 会给前端 `null`，`.map()` 当场炸。目前唯一返回集合的 `store_keys`
   已是 `unwrap_or_default()`；这条规矩是给任务 #6/#7/#8 后续落地的 command 立的
4. 返回 `unknown`（`serde_json::Value`）的 command 必须在清单内——目前只有两个 picker，
   它们的 `string | string[] | null` 形状约定来自 Electron 侧既有契约，只活在注释里
5. 没有绕过 `call()` 的裸 `invoke("字面量")`，也没有「Rust 实现了但前端忘了接」的孤儿

### 9.3 顺带修好的

`packages/desktop` 此前**没有 test 脚本**，`src/main/shell-env.test.ts` 与
`src/renderer/html.test.ts` 从写下那天起就没在 CI 跑过。现已接上 `test` / `test:ci`
（turbo 的通用 `test:ci` 任务会自动带上），并加了 `bun-preload.ts` 给 `electron` 做替身
—— `bun test` 里没有 Electron 运行时，`import { crashReporter }` 会让整条 import 链塌掉。
