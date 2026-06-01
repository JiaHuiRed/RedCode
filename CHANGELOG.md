# 更新日志

本文件记录 RedCode 的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

0.3.0 起 TUI 与 GUI 独立维护版本号，各自独立记录。0.3.0 及之前为共同历史。

---

## TUI

### [0.3.7] - 2026-06-01

#### 新增

- 记忆系统：新增每日日志 + 定期审视机制，被纠正时自动写入 `memory/YYMMDD.md`，收工时摘要合并到 MEMORY.md，确保教训跨会话持久

#### 修复

- **构建流程纠正**：TUI exe 编译改用 `bun run build -- --single`（`script/build.ts`），替代之前手拼 `bun build --compile` 的错误方式

---

### [0.3.6] - 2026-06-01

#### 新增

- 侧边栏 Context 区块充实：显示 provider 名、模型名、token 明细（输入/输出/推理/缓存）、消息数、agent 名、创建时间和最后活动时间；未知上下文上限显示 `?`，超过 200% 显示 `⚠` 警告
- Loading 动画替换：左下角蓝色方块 Knight Rider 动画改为 🐲🔥 喷火龙呼吸动画
- 右键粘贴：主输入框和对话框输入框支持右键粘贴剪贴板内容

### [0.3.5] - 2026-05-31

#### 新增

- prompt 输入框自适应 & 可配置高度：合并上游实现，文本框行数根据内容自动伸缩，支持用户配置最小/最大行数

#### 修复

- 行内 tool 行换行对齐：提取 `InlineToolRow` 组件，图标与文字使用 flex 布局，换行后文字正确对齐

### [0.3.4] - 2026-05-31

#### 新增

- Shell Mode：空提示框按 `!` 进入 Shell 模式，直接运行系统命令（通过 `session.shell` 而非发送消息），命令完成后自动退出 Shell 模式
- Session Switcher：新增 `$session.list` 命令和 `/sessions` 斜杠命令，打开会话切换对话框，支持按项目/状态过滤、消息预览和 diff 摘要

#### 修复

- Diff Viewer 改进：合并上游空白状态展示、交互优化、设计重设计等修复；修复文件树中已审查文件的勾选标记 Unicode 乱码
- 测试文件 import 路径修正：`diff-viewer.test.tsx` 中 `@opencode-ai` → `@redcode-ai`

### [0.3.3] - 2026-05-31

#### 修复

- compacted 会话 HTTP API 消息过滤：消息分页查询自动跳过 compaction summary 之前的旧消息，避免 GUI 加载大量旧消息导致 OOM/卡死。同时在 `packages/opencode` 侧生效，TUI 和 GUI 共享同一服务端
- 测试用例 import 补全：`db.test.ts` 补全 `it` 的 `bun:test` import，修复测试运行时引用错误

### [0.3.2] - 2026-05-30

#### 变更

- 统一数据库路径：移除 channel 分库逻辑（`redcode-dev.db` / `redcode-beta.db` 等），所有渠道统一使用 `redcode.db` 主库；删除 `disableChannelDb` 运行时标志
- 斜杠命令中文化：`/compact`→压缩会话、`/connect`→连接供应商、`/copy`→复制会话记录、`/export`→导出会话记录、`/fork`→分叉会话、`/init`→初始化 AGENTS.md、`/review`→审查变更

### [0.3.1] - 2026-05-28

#### 新增

- 对话框 Ctrl+V 粘贴：`dialog-prompt.tsx` 添加系统剪贴板读取，作为 bracketed paste fallback；`keybind.ts` 新增 `dialog.prompt.paste` 快捷键绑定

#### 修复

- DeepSeek 模型变体不可用：`transform.ts` 移除 DeepSeek 模型 variants 排除列表，`openai-compatible` 类型模型绕过 `reasoning` 能力检查

#### 重构

- 删除死代码：移除未使用的 `GoLogo` 组件（`logo.tsx`）、整个 `dialog-tag.tsx` 文件、未引用的 `Descriptions` 和 `TuiAttentionSoundPaths` 导出
- 类型安全提升：`toast.tsx` `err: any` → `unknown`、`kv.tsx` `defaultValue?: any` → `unknown`、`dialog.tsx` `replace(input: any)` → `JSX.Element`、`dialog-prompt.tsx` `ctx: any` → `CommandContext`、`local.tsx` 反序列化类型标注

---

## GUI

### [0.3.9] - 2026-06-01

#### 新增

- **图标重制**：`gen-icon.py` 从 `Red.ico` 源图生成全尺寸图标，支持 16~1024px 多分辨率 ICO，修复文件资源管理器/任务栏图标模糊问题
- 图标渠道同步：dev/beta/prod 三渠道 `icon.ico` 统一使用 `Red.ico`

---

### [0.3.8] - 2026-06-01

#### 新增

- TypeGraph MCP 集成：新增 `typegraph-mcp` 代码语义导航服务器（14 个工具），支持类型解析、调用链追踪、影响分析、循环依赖检测等，与现有 CodeGraph 互补

#### 修复

- 会话模型/智能体选择修复：`submit.ts` 将 ready 检查移到取值之前，同时检查 `providers.ready()` 和 `models.ready()`，避免 provider 已加载但 localStorage 持久化数据未就绪时误弹"请选择智能体和模型"toast
- Windows 打包签名挂起：`electron-builder.config.ts` 的 `afterAllArtifactBuild` 改用 `fs.cp` + `fs.rm` 替换不可靠的 `fs.rename`；本地打包改用 PowerShell 自签名证书，不再因 signtool.exe 挂起

### [0.3.7] - 2026-06-01

#### 新增

- TTS 朗读配置面板：设置 → 通用新增「文字转语音」区块，支持独立配置 MiMo TTS `sk-` 前缀 API Key、音色选择（冰糖 / 茉莉 / 苏打 / 白桦 / 英文四种）、以及朗读功能总开关；朗读按钮仅在开关开启时显示

#### 修复

- TTS 调用逻辑修正：原实现调用不存在的本地路由 `/session/tts`（必然静默失败），现改为渲染进程直接请求 `https://api.xiaomimimo.com/v1/chat/completions`，使用 MiMo v2.5 TTS 模型，base64 WAV 响应直接通过浏览器 Audio API 播放
- 标题栏版本号动态化：版本徽章从硬编码字符串改为读取 `window.api.appVersion`（由 preload 注入 `npm_package_version`），后续只需改 `package.json` 版本号，标题栏自动同步
- 侧边栏项目自动置顶：当前活跃项目调用 `touch()` 时自动移到侧边栏列表顶部，不再保持静态创建顺序
- compaction 消息加载方向修正：`MessageV2.page` 新增 `after` 参数；compacted 会话初始加载从「summary 之前的旧消息」（原逻辑反向）修正为「summary 及之后的新消息」，避免加载大量 pre-compaction 历史导致渲染器 OOM
- 新建会话 provider 检测再修正：`global-sync.tsx` 将 `global.provider` 从初始化时的静态快照改为惰性 getter，确保 child-store 响应式 getter 运行时读取的是实时 `globalStore.provider` 而非启动时 global query 尚未完成的 EMPTY 快照；修复了项目级 provider 查询完成而全局查询尚未结束时 fallback 判断失效、导致"需要配置 provider"弹窗的竞态问题

### [0.3.6] - 2026-05-30

#### 新增

- 消息朗读按钮：AI 回复气泡旁新增 🔊 按钮，点击调用 MiMo TTS API（限时免费 `mimo-v2-tts`）朗读回复内容；利用已有的 `notification.tsx` + `sound.ts` 音频基础设施，TTS 音频通过浏览器 `Audio` API 播放；复用现有 provider 配置体系接入 TTS 模型，无需额外 API key

### [0.3.5] - 2026-05-29

#### 修复

- 大会话导致渲染器 OOM/卡死：compacted 会话的消息查询只返回 compaction summary 之后的消息（`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`），避免 GUI 加载大量旧消息导致渲染器内存溢出或无响应
- 初始消息加载量减半：`initialMessagePageSize` 从 80 降至 40，`historyMessagePageSize` 从 200 降至 80，降低首次渲染压力
- 新建项目/provider查询失败时回退到全局 provider：`child-store.ts` 补充 `!projectData` 判断，当项目级 provider 查询返回 `undefined`/`null` 时自动回退到全局已连接 providers，避免要求重新配置
- 中文 i18n 适配：`zh.ts` 补全 24 条缺失翻译（project 切换、设置页面、错误页等），修复 `layout.tsx` 中 "Export logs" 硬编码英文（TUI 同步生效）

### [0.3.4] - 2026-05-29

#### 变更

- 包含服务端更新：统一数据库路径、CodeGraph MCP 代码知识图谱集成、斜杠命令中文化、provider 错误处理改进、shell/message-v2 修复

### [0.3.3] - 2026-05-29

#### 修复

- 新建会话重复弹出"选择智能体和模型"：`child-store.ts` 项目级 provider 查询 fallback 条件扩展，当 `connected` 为空但全局有已连接 providers 时自动回退，避免每次新建会话都要求重新配置
- 会话右键重命名菜单缺失：`sidebar-items.tsx` 手动 `onContextMenu` 实现替换为 Kobalte `ContextMenu` 组件，使用 Portal 渲染避免 overflow 裁剪
- GUI 图标白底：`yayi_256x256.ico` 用 sharp `unflatten` 去除白色背景，重新打包 ico/png 资源
- DeepSeek 模型变体下拉框不显示：`transform.ts` 移除 DeepSeek 排除列表，`@ai-sdk/openai-compatible` 类型模型绕过 `reasoning` 能力检查

### [0.3.2] - 2026-05-28

#### 新增

- 项目右键删除：首页 (`home.tsx`) 项目列表新增 `ContextMenu`，右键单个项目可删除；旧侧边栏 (`sidebar-project.tsx`) 项目图标右键菜单同样新增"删除"；旧侧边栏展开后项目头部三点 `DropdownMenu` 也补充"删除"项
- 项目删除后端 API：`Project.remove` Effect 服务方法 + DELETE `/project/:projectID` HTTP 路由 + `Event.Removed` 全局事件广播；SDK (`sdk.gen.ts`) 新增 `project.remove` 客户端方法；前端 `event-reducer.ts` 监听 `project.removed` 自动从列表移除
- 会话归档右键菜单：`sidebar-items.tsx` 会话项右键菜单加入"归档"选项
- 侧边栏底部收起按钮：`sidebar-shell.tsx` 加 `onToggleSidebar` prop，左侧 rail 设置按钮上方新增侧边栏切换按钮（旧设计 / prod channel 生效）

#### 修复

- 原生右键菜单拦截 HTML 菜单：`main/index.ts` 的 `electron-context-menu` 加 `shouldShowMenu`，限定只在图片/视频上触发，避免压制 Kobalte `ContextMenu` 不出现
- 任务栏 / 标题栏图标糊化：`scripts/gen-icon.py` 移除 `GaussianBlur(radius=1.0)`，红环改用 `ellipse(width=ring_w)` 单次抗锯齿描边，小尺寸（≤32 / ≤64）超采样倍率提升至 16x / 8x，重新生成全套 PNG/ICO
- 标题栏版本徽章：`packages/desktop/src/renderer/index.html` 顶部交通灯旁版本徽章更新为 `v0.3.2`
- DeepSeek 费用按 CNY 计价（3d3b0ce）

#### 变更

- TUI 与 GUI 版本号解耦：`packages/opencode/script/build-node.ts` 不再从 `packages/desktop/package.json` 读取版本，改读 opencode 自己的 `package.json`；TUI 现可独立递增版本号，互不影响

### [0.3.1] - 2026-05-28

#### 新增

- 对话框 Ctrl+V 粘贴：`dialog-prompt.tsx` 添加系统剪贴板读取，作为 bracketed paste fallback；`keybind.ts` 新增 `dialog.prompt.paste` 快捷键绑定

#### 修复

- DeepSeek 模型变体不可用：`transform.ts` 移除 DeepSeek 模型 variants 排除列表，`openai-compatible` 类型模型绕过 `reasoning` 能力检查

#### 重构

- 删除死代码：移除未使用的 `GoLogo` 组件（`logo.tsx`）、整个 `dialog-tag.tsx` 文件、未引用的 `Descriptions` 和 `TuiAttentionSoundPaths` 导出
- 类型安全提升：`toast.tsx` `err: any` → `unknown`、`kv.tsx` `defaultValue?: any` → `unknown`、`dialog.tsx` `replace(input: any)` → `JSX.Element`、`dialog-prompt.tsx` `ctx: any` → `CommandContext`、`local.tsx` 反序列化类型标注

---

## 共同历史

### [0.3.0] - 2026-05-27

#### 修复

- 桌面端 sidecar 崩溃：Bundle 不再复制到 `out/main/`，而是留在 `packages/opencode/dist/node/` 原位置，使 `jsonc-parser` 等依赖能从原始 `node_modules` 解析；添加 `@parcel/watcher` 最小 shim 避免拉入 `micromatch` 依赖链；sidecar 添加 `await new Promise` 保持进程存活
- 桌面端安装版白屏：移除 NSIS 安装器目标（`target: ["dir"]`），只生成免安装 `win-unpacked` 版
- 桌面端任务栏图标缺失：图标通过 `extraResources` 放到 ASAR 外部，`BrowserWindow` 改用 `nativeImage.createFromPath` 加载
- 桌面端 sidecar 错误不可见：添加永久 IPC 错误监听器，sidecar 崩溃日志写入 `%TEMP%\redcode-sidecar-crash.log`
- 桌面端 loading 灰屏：`awaitInitialization` 改用原生 `Promise.withResolvers` 替代 Effect `Deferred`，解决跨运行时挂起
- 桌面端类型错误：`server-sync.tsx` 参数顺序互换修复、`bootstrapGlobal` 属性名修复、`custom-elements.d.ts` 三斜线指令修复
- TUI 版本号显示错误：`build-node.ts` 改从 `packages/desktop/package.json` 读取 RedCode 版本（`0.2.2`），替代原来错误注入的 upstream opencode 版本（`1.15.10`）；需重建 TUI 生效（见下方构建说明）
- Desktop HTML 版本徽章：`out/renderer/index.html` hardcode 版本从 `v0.2.1` 更新为 `v0.2.2`
- 上游 Logo 残留：`packages/ui/src/components/logo.tsx` 完全重写，`Mark`（写轮眼 SVG）、`Splash`（旋转动画 SVG）、`Logo`（REDCODE 像素字）全部替换，消除新建会话时出现的 opencode 原版图标和 GitHub Mona GIF
- 新建会话 Wordmark：`wordmark-v2.tsx` 从 opencode SVG 路径改为 Space Grotesk 字体文字，RED 柔红色（`#e84057`），居中 72px
- 桌面端图标全部替换：`icons/dev/`、`icons/beta/`、`icons/prod/` 全套图标替换为万花筒写轮眼设计
- DeepSeek 缓存 Token 费用计算偏高：`session.ts` 添加 DeepSeek metadata fallback，从 `experimental_providerMetadata.deepseek.promptCacheHitTokens` / `promptCacheMissTokens` 读取缓存命中/未命中 token 数，修复所有 token 按全价计费的问题
- 对话框输入框无法粘贴：`dialog-prompt.tsx` 添加 `onPaste` handler，支持 Ctrl+V 在 API 密钥输入框中粘贴

#### 新增

- 万花筒写轮眼图标：新增 `packages/desktop/scripts/gen-icon.py`，程序化生成全套 Windows/macOS 图标（负空间法：实心红圆切三个黑色楔形 = 写轮眼三刀片）；输出到 `packages/desktop/icons/`

#### 构建说明

**TUI 重建（版本号修复生效）：**
```bash
cd packages/opencode
bun run script/build-node.ts
```
版本号在构建时烘焙进产物，之后 TUI 侧边栏底部将显示 `• RedCode 0.3.0`。

**图标重新生成：**
```bash
cd packages/desktop
py scripts/gen-icon.py
```
生成后在 electron-builder 配置中引用 `icons/icon.ico` 和 `icons/icon.png`，再重打包 desktop。

### [0.2.1] - 2026-05-26

#### 新增

- 缓存命中率显示：TUI 底部栏及 subagent footer 显示 `Cache: XX%` 缓存命中率
- Windows 剪贴板粘贴：添加 PowerShell `Get-Clipboard` 回退，修复 Windows TUI 粘贴问题
- 标题栏版本号：`ChannelIndicator` 改为显示 `v{platform.version}`，实时读取 package.json 版本
- macOS 交通灯（V2 titlebar）：dev 构建左上角补齐红黄绿圆点，支持关闭/最小化/最大化

#### 变更

- 底部栏去重：移除右下角冗余的 token 用量和费用显示（右侧面板 context 中已有），仅保留缓存率和快捷键提示
- 移除帮助按钮：侧边栏底部及首页帮助按钮均已删除（原跳转外网，无实际用途）
- 错误页精简：仅保留「导出日志」按钮，移除重启/Sentry/检查更新/Discord 链接
- 侧边栏左对齐：首页 Grid 容器去掉 `mx-auto max-w-[1080px] px-6` 居中约束，项目列表紧贴左边
- 帮助菜单精简：只保留「RedCode 源码」（→ GitHub）和「导出日志...」，删除原作者的论坛/反馈/Bug 上报链接

#### 修复

- 双交通灯：`<Match when>` 改为 `<Match when={!USE_V2_TITLEBAR}>` 确保两个 titlebar 分支互斥，消除重复按钮和版本号
- 标题栏宽度：无原生边框窗口 `env(titlebar-area-width)` fallback 改为 `100vw`，避免按钮超出可视区域

### [0.2.0] - 2026-05-26

#### 新增

- i18n 补全：三套自定义配色方案（米黄/护眼绿/深蓝）接入 i18n，英文标签 Cream / Eye Green / Deep Blue
- 标题栏版本号：`ChannelIndicator` 改为显示 `v{platform.version}`，实时读取 package.json 版本
- V2 titlebar 交通灯：开发构建的 V2 titlebar 补齐左上角红黄绿圆点，与生产版行为一致

#### 变更

- 首页简化：删除 `LegacyHome` 组件，始终使用 `HomeDesign`；移除频道门控逻辑
- 频道简化：去掉 dev/beta/prod 分支门控，UI 功能统一走发布版路径
- 删除无效 UI：移除首页装饰性 `Branch: dev` 按钮及遗留 `console.log`
- 移除帮助按钮：侧边栏底部及首页帮助按钮均已删除（原链接跳转外网，无实际用途）
- 错误页精简：仅保留「导出日志」按钮，移除重启、Sentry 上报、检查更新、Discord 链接
- 侧边栏左对齐：首页 Grid 容器去掉 `mx-auto max-w-[1080px] px-6` 居中约束，项目列表紧贴左边
- 标题栏宽度修复：无原生边框窗口 `env(titlebar-area-width)` fallback 改为 `100vw`，避免按钮超出可视区域

#### 修复

- `refcount.ts` 损坏：恢复正确的 `createRefCountMap` 实现，修复渲染器白屏
- `new-session-layout.ts` 损坏：恢复正确的 `shouldUseV2NewSessionPage` 实现

### [0.1.0] - 2026-05-24

#### 新增

- macOS 交通灯标题栏：Windows 桌面端左上角红黄绿圆点，支持关闭/最小化/最大化
- 中文菜单：三条线菜单全部中文化（文件/编辑/视图/导航/窗口/帮助）
- 中文斜杠命令：`/models` 选择大模型、`/sessions` 切换会话 等 20+ 命令中文化
- 三套新主题：米黄、护眼绿、深蓝
- 启动 Logo：TUI 启动界面替换为 REDCODE 纯█点阵
- README 猫猫：README 顶部猫猫 GIF + ASCII RedCode 并排显示
- 记忆系统：`.opencode/MEMORY.md` + `AGENTS.md` 持久记录主人偏好
- 版本号：Sidebar 右下角显示硬编码 `0.1.0`

#### 变更

- 货币符号：`$` → `¥`（USD → CNY），用于 DeepSeek 等中国模型
- Logo 颜色：左面板 RED 与右面板 CODE 同色同粗，不再偏暗
- Web UI 移除：桌面端渲染器剥离 SolidJS Web UI 依赖，改用独立 HTML
- 桌面端构建修复：修复 `vitefu` BOM 解析崩溃、Electron 路径重命名遗留问题

#### 修复

- TUI Proxy 崩溃：`opencode.json` 格式错误导致 `TypeError: Proxy target should be Object`
- 桌面端 sidecar 崩溃：Bundle 不再复制到 `out/main/`，而是留在 `packages/opencode/dist/node/` 原位置，使 `jsonc-parser` 等依赖能从原始 `node_modules` 解析；添加 `@parcel/watcher` 最小 shim 避免拉入 `micromatch` 依赖链；sidecar 添加 `await new Promise` 保持进程存活
- 桌面端安装版白屏：移除 NSIS 安装器目标（`target: ["dir"]`），只生成免安装 `win-unpacked` 版
- 桌面端任务栏图标缺失：图标通过 `extraResources` 放到 ASAR 外部，`BrowserWindow` 改用 `nativeImage.createFromPath` 加载
- 桌面端 sidecar 错误不可见：添加永久 IPC 错误监听器，sidecar 崩溃日志写入 `%TEMP%\redcode-sidecar-crash.log`
- 桌面端 loading 灰屏：`awaitInitialization` 改用原生 `Promise.withResolvers` 替代 Effect `Deferred`，解决跨运行时挂起
- 桌面端类型错误：`server-sync.tsx` 参数顺序互换修复、`bootstrapGlobal` 属性名修复、`custom-elements.d.ts` 三斜线指令修复
- TUI 版本号显示错误：`build-node.ts` 改从 `packages/desktop/package.json` 读取 RedCode 版本（`0.2.2`），替代原来错误注入的 upstream opencode 版本（`1.15.10`）；需重建 TUI 生效（见下方构建说明）
- Desktop HTML 版本徽章：`out/renderer/index.html` hardcode 版本从 `v0.2.1` 更新为 `v0.2.2`
- 上游 Logo 残留：`packages/ui/src/components/logo.tsx` 完全重写，`Mark`（写轮眼 SVG）、`Splash`（旋转动画 SVG）、`Logo`（REDCODE 像素字）全部替换，消除新建会话时出现的 opencode 原版图标和 GitHub Mona GIF
- 新建会话 Wordmark：`wordmark-v2.tsx` 从 opencode SVG 路径改为 Space Grotesk 字体文字，RED 柔红色（`#e84057`），居中 72px
- 桌面端图标全部替换：`icons/dev/`、`icons/beta/`、`icons/prod/` 全套图标替换为万花筒写轮眼设计
- DeepSeek 缓存 Token 费用计算偏高：`session.ts` 添加 DeepSeek metadata fallback，从 `experimental_providerMetadata.deepseek.promptCacheHitTokens` / `promptCacheMissTokens` 读取缓存命中/未命中 token 数，修复所有 token 按全价计费的问题
- 对话框输入框无法粘贴：`dialog-prompt.tsx` 添加 `onPaste` handler，支持 Ctrl+V 在 API 密钥输入框中粘贴

#### 新增

- 万花筒写轮眼图标：新增 `packages/desktop/scripts/gen-icon.py`，程序化生成全套 Windows/macOS 图标（负空间法：实心红圆切三个黑色楔形 = 写轮眼三刀片）；输出到 `packages/desktop/icons/`

#### 构建说明

**TUI 重建（版本号修复生效）：**
```bash
cd packages/opencode
bun run script/build-node.ts
```
版本号在构建时烘焙进产物，之后 TUI 侧边栏底部将显示 `• RedCode 0.3.0`。

**图标重新生成：**
```bash
cd packages/desktop
py scripts/gen-icon.py
```
生成后在 electron-builder 配置中引用 `icons/icon.ico` 和 `icons/icon.png`，再重打包 desktop。

### [0.0.1] - 2026-05-24

#### 新增

- 项目 Fork：基于 opencode (sst.dev) 二次开发
- 品牌重命名：opencode → RedCode，全面替换包名、URL、环境变量
