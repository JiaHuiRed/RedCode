# 更新日志

本文件记录 RedCode 的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

---

## [0.2.2] - 2026-05-27

### 修复

- **桌面端 sidecar 崩溃**：Bundle 不再复制到 `out/main/`，而是留在 `packages/opencode/dist/node/` 原位置，使 `jsonc-parser` 等依赖能从原始 `node_modules` 解析；添加 `@parcel/watcher` 最小 shim 避免拉入 `micromatch` 依赖链；sidecar 添加 `await new Promise` 保持进程存活
- **桌面端安装版白屏**：移除 NSIS 安装器目标（`target: ["dir"]`），只生成免安装 `win-unpacked` 版
- **桌面端任务栏图标缺失**：图标通过 `extraResources` 放到 ASAR 外部，`BrowserWindow` 改用 `nativeImage.createFromPath` 加载
- **桌面端 sidecar 错误不可见**：添加永久 IPC 错误监听器，sidecar 崩溃日志写入 `%TEMP%\redcode-sidecar-crash.log`
- **桌面端 loading 灰屏**：`awaitInitialization` 改用原生 `Promise.withResolvers` 替代 Effect `Deferred`，解决跨运行时挂起
- **桌面端类型错误**：`server-sync.tsx` 参数顺序互换修复、`bootstrapGlobal` 属性名修复、`custom-elements.d.ts` 三斜线指令修复
- **TUI 版本号显示错误**：`build-node.ts` 改从 `packages/desktop/package.json` 读取 RedCode 版本（`0.2.2`），替代原来错误注入的 upstream opencode 版本（`1.15.10`）；需重建 TUI 生效（见下方构建说明）
- **Desktop HTML 版本徽章**：`out/renderer/index.html` hardcode 版本从 `v0.2.1` 更新为 `v0.2.2`
- **上游 Logo 残留**：`packages/ui/src/components/logo.tsx` 完全重写，`Mark`（写轮眼 SVG）、`Splash`（旋转动画 SVG）、`Logo`（REDCODE 像素字）全部替换，消除新建会话时出现的 opencode 原版图标和 GitHub Mona GIF

### 新增

- **万花筒写轮眼图标**：新增 `packages/desktop/scripts/gen-icon.py`，程序化生成全套 Windows/macOS 图标（负空间法：实心红圆切三个黑色楔形 = 写轮眼三刀片）；输出到 `packages/desktop/icons/`

### 构建说明

**TUI 重建（版本号修复生效）：**
```bash
cd packages/opencode
bun run script/build-node.ts
```
版本号在构建时烘焙进产物，之后 TUI 侧边栏底部将显示 `• RedCode 0.2.2`。

**图标重新生成：**
```bash
cd packages/desktop
py scripts/gen-icon.py
```
生成后在 electron-builder 配置中引用 `icons/icon.ico` 和 `icons/icon.png`，再重打包 desktop。

### 待修复

**DeepSeek 缓存 Token 费用计算偏高**（`packages/opencode/src/session/session.ts` 约 387–440 行）

**问题根因：** DeepSeek OpenAI 兼容 API 返回 `prompt_cache_hit_tokens`（缓存命中部分），但 Vercel AI SDK `@ai-sdk/openai-compatible` 适配器可能未将其映射到 `cacheReadInputTokens`，导致所有 token 全部按全价 ¥0.27/M 计算，而非命中缓存的 ¥0.07/M，显示费用远高于 DeepSeek 官网账单。

**排查步骤：**
1. 在 `onFinish` 回调处打印 `usage` 和 `experimental_providerMetadata`，确认 `prompt_cache_hit_tokens` 是否出现
2. 若在 `experimental_providerMetadata.deepseek` 下，可在提取 usage 时补充：
   ```ts
   const meta = (rawResponse as any)?.experimental_providerMetadata
   const deepseekCacheHit  = meta?.deepseek?.promptCacheHitTokens  ?? 0
   const deepseekCacheMiss = meta?.deepseek?.promptCacheMissTokens ?? 0
   if (deepseekCacheHit > 0 || deepseekCacheMiss > 0) {
     cacheReadInputTokens  = deepseekCacheHit
     cacheWriteInputTokens = deepseekCacheMiss
   }
   ```
3. 若 AI SDK 完全丢弃该字段，需在 provider 层拦截原始 HTTP 响应，或使用 `@ai-sdk/openai-compatible` 的自定义 `extractUsage` 选项
4. 确认 `models.dev` 中 DeepSeek 的 `costInfo.cache.read` 已配置正确价格（$0.01/M = ¥0.07/M）

---

## [0.2.1] - 2026-05-26

### 新增

- **缓存命中率显示**：TUI 底部栏及 subagent footer 显示 `Cache: XX%` 缓存命中率
- **Windows 剪贴板粘贴**：添加 PowerShell `Get-Clipboard` 回退，修复 Windows TUI 粘贴问题
- **标题栏版本号**：`ChannelIndicator` 改为显示 `v{platform.version}`，实时读取 package.json 版本
- **macOS 交通灯（V2 titlebar）**：dev 构建左上角补齐红黄绿圆点，支持关闭/最小化/最大化

### 变更

- **底部栏去重**：移除右下角冗余的 token 用量和费用显示（右侧面板 context 中已有），仅保留缓存率和快捷键提示
- **移除帮助按钮**：侧边栏底部及首页帮助按钮均已删除（原跳转外网，无实际用途）
- **错误页精简**：仅保留「导出日志」按钮，移除重启/Sentry/检查更新/Discord 链接
- **侧边栏左对齐**：首页 Grid 容器去掉 `mx-auto max-w-[1080px] px-6` 居中约束，项目列表紧贴左边
- **帮助菜单精简**：只保留「RedCode 源码」（→ GitHub）和「导出日志...」，删除原作者的论坛/反馈/Bug 上报链接

### 修复

- **双交通灯**：`<Match when>` 改为 `<Match when={!USE_V2_TITLEBAR}>` 确保两个 titlebar 分支互斥，消除重复按钮和版本号
- **标题栏宽度**：无原生边框窗口 `env(titlebar-area-width)` fallback 改为 `100vw`，避免按钮超出可视区域

---

## [0.2.0] - 2026-05-26

### 新增

- **i18n 补全**：三套自定义配色方案（米黄/护眼绿/深蓝）接入 i18n，英文标签 Cream / Eye Green / Deep Blue
- **标题栏版本号**：`ChannelIndicator` 改为显示 `v{platform.version}`，实时读取 package.json 版本
- **V2 titlebar 交通灯**：开发构建的 V2 titlebar 补齐左上角红黄绿圆点，与生产版行为一致

### 变更

- **首页简化**：删除 `LegacyHome` 组件，始终使用 `HomeDesign`；移除频道门控逻辑
- **频道简化**：去掉 dev/beta/prod 分支门控，UI 功能统一走发布版路径
- **删除无效 UI**：移除首页装饰性 `Branch: dev` 按钮及遗留 `console.log`
- **移除帮助按钮**：侧边栏底部及首页帮助按钮均已删除（原链接跳转外网，无实际用途）
- **错误页精简**：仅保留「导出日志」按钮，移除重启、Sentry 上报、检查更新、Discord 链接
- **侧边栏左对齐**：首页 Grid 容器去掉 `mx-auto max-w-[1080px] px-6` 居中约束，项目列表紧贴左边
- **标题栏宽度修复**：无原生边框窗口 `env(titlebar-area-width)` fallback 改为 `100vw`，避免按钮超出可视区域

### 修复

- **`refcount.ts` 损坏**：恢复正确的 `createRefCountMap` 实现，修复渲染器白屏
- **`new-session-layout.ts` 损坏**：恢复正确的 `shouldUseV2NewSessionPage` 实现

---

## [0.1.0] - 2026-05-24

### 新增

- **macOS 交通灯标题栏**：Windows 桌面端左上角红黄绿圆点，支持关闭/最小化/最大化
- **中文菜单**：三条线菜单全部中文化（文件/编辑/视图/导航/窗口/帮助）
- **中文斜杠命令**：`/models` 选择大模型、`/sessions` 切换会话 等 20+ 命令中文化
- **三套新主题**：米黄、护眼绿、深蓝
- **启动 Logo**：TUI 启动界面替换为 REDCODE 纯█点阵
- **版本号**：Sidebar 右下角显示硬编码 `0.1.0`
- **README 猫猫**：README 顶部猫猫 GIF + ASCII RedCode 并排显示
- **记忆系统**：`.opencode/MEMORY.md` + `AGENTS.md` 持久记录主人偏好

### 变更

- **货币符号**：`$` → `¥`（USD → CNY），用于 DeepSeek 等中国模型
- **Logo 颜色**：左面板 RED 与右面板 CODE 同色同粗，不再偏暗
- **Web UI 移除**：桌面端渲染器剥离 SolidJS Web UI 依赖，改用独立 HTML
- **桌面端构建修复**：修复 `vitefu` BOM 解析崩溃、Electron 路径重命名遗留问题

### 修复

- **TUI Proxy 崩溃**：`opencode.json` 格式错误导致 `TypeError: Proxy target should be Object`
- **桌面端白屏**：恢复 `loading.html`，修复 Vite 缓存导致的白屏
- **Logo 不清晰**：从 `█▀▄` 阴影风格改为纯 `█` 点阵 5×5 字模

## [0.0.1] - 2026-05-24

### 新增

- **项目 Fork**：基于 opencode (sst.dev) 二次开发
- **品牌重命名**：opencode → RedCode，全面替换包名、URL、环境变量
