# 更新日志

本文件记录 RedCode 的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

0.3.0 起 TUI 与 GUI 独立维护版本号，各自独立记录。0.3.0 及之前为共同历史。

---

## TUI

### [0.4.6] - 2026-06-07

#### 新增

- **RedNote MCP — 小红书插件**：新增 `plugins/rednote-mcp/`，基于 Playwright 浏览器自动化的小红书 MCP 服务器
  - `post_note` — 发布图文笔记（1–18 图，标题 ≤20 字，正文 ≤1000 字）
  - `search_notes` — 关键词搜索笔记
  - `get_note_details` — 获取笔记详情和评论
  - `get_user_profile` — 获取用户信息
  - `login` — 扫码登录，Cookie 持久化复用
  - `set_browser_mode` — 切换有头/无头模式（反爬时开有头）
- **反爬对抗**：playwright-stealth + 模拟鼠标抖动 + 逐字符键入 + 随机延迟

#### 文档

- **MANUAL.md 大幅更新**：MCP 章节从 4+2 个服务器升级为 11 个，按功能分 4 类表格化呈现，新增 RedNote MCP 说明

### [0.4.5] - 2026-06-07

#### 新增

- **Agent Reach — 统一搜索 MCP**：新增 `plugins/agent-reach-mcp/`，内置 6 个搜索工具覆盖 3 大平台
  - `search_github` / `get_github_repo` — 搜仓库、搜 Issue、看详情（通过 `gh` CLI）
  - `search_bilibili` / `get_bilibili_video` — 搜 B站视频、提取字幕（B站 API + yt-dlp）
  - `get_douyin_video` — 解析抖音视频信息（通过 yt-dlp Douyin extractor）
  - `doctor` — 一条命令检查各工具可用性
- **Exa 语义搜索 MCP**：接入 Exa AI 语义搜索引擎（`type: "remote"`，`https://mcp.exa.ai/mcp`），免费 1000 次/月，覆盖 web search + web fetch
- **MCP disabledTools 配置**：`ConfigMCP.Local` 新增 `disabledTools` 字段，可在配置层面屏蔽指定 MCP 服务器的多余工具，无需改 RedCode 源码
  - 应用于 codegraph：隐藏 7 个被 jCodeMunch 替代的冗余工具，仅暴露 `codegraph_explore`
- **Supermmemory 本地记忆插件**：`plugins/mcp-su-prememory-local/` — 纯本地 SQLite+FTS5 语义记忆 MCP，三种工具（`memory` 记/忘、`recall` 搜、`stats` 统计），数据存 `~/.redcode/supermemory.db`
- **Diagnose 技能**：`.opencode/skill/diagnose/SKILL.md` — 结构化 bug 诊断工作流（重现 → 缩小范围 → 定位根因 → 修复 → 验证），适配自 @mattpocock/skills

#### 安装/配置

- **Agent Reach 依赖安装**（各平台首次使用前需执行）：
  - B站/抖音：`uv tool install yt-dlp`（视频信息提取）
  - GitHub：`gh` CLI 预装，`gh auth login` 后可用

### [0.4.4] - 2026-06-07

#### 新增

- **MCP 全局配置化**：`ConfigMCP.Local` 新增 `cwd` 字段（支持 `~/` 和 `$REDCODE_ROOT` 占位符展开）；`mcp/index.ts` 新增 `findRedcodeRoot()` 从 exe 路径自动定位 RedCode 安装根目录；6 个 MCP 服务器定义从项目级配置（`opencode.jsonc` / `redcode.jsonc`）移至全局 `~/.redcode/redcode.jsonc`。现在在任何项目目录启动 RedCode 均可自动加载 MCP 工具，不依赖项目 `.opencode/` 目录
- **Session 全局 scope**：`Session.list()` 支持 `scope: "global"` 列出所有项目的会话（不限于当前项目）；HTTP API (`GET /session?scope=global`) 及 SDK 类型同步更新；会话目录过滤默认关闭（`session_directory_filter_enabled` 默认值 `true` → `false`），新用户开箱即见跨项目会话列表
- **技能指令全局化**：6 个共享技能指令从项目配置（`opencode.jsonc` / `redcode.jsonc`）移至全局 `~/.redcode/redcode.jsonc`，使用 `~/.redcode/skill/...` 路径，跨项目目录自动加载。之前仅在 RedCode 项目内可用的技能（memory-automation、guardrail-profiles、defensive-agent、goal-automation、simplify、vision-autoagent）现在任意项目目录均生效。同时也补上了之前漏掉的 `simplify` 技能注入

#### 改进

- **记忆自动化规则强化**：扩展 SKILL.md 中的硬触发器（批评/夸奖/个人信息/项目决策 → 自动记日志），提升自动提取的可靠性

### [0.4.3] - 2026-06-06

#### 新增

- **条件技能（paths frontmatter）**：SKILL.md 支持 `paths` 字段声明 glob 模式（如 `"src/**/*.py"`）。设定了路径的技能只在当前项目目录匹配时才注入系统上下文，避免无关技能膨胀 prompt。`Skill.available()` 新增 `directory` 参数，`forDirectory()` 内部使用 `Glob.scan` 做路径匹配
- **search_tools 工具**：新增 `/search_tools` 工具，允许 LLM 按名称或描述搜索可用工具。端口自 claude-code 的 SearchExtraToolsTool 模式。所有内建/MCP/插件工具均可搜索
- **buildTool 简化工场**：`Tool.build()` 工厂函数，为零服务依赖的简单工具提供更简洁的创建方式，安全默认值，支持 3 行创建一个工具

#### 重构

- **Shell cancel race 修复**：从 upstream 移植 `run-state.ts` `cancel()` 中缺失的 `busy` 检查，避免 shell 取消时的竞态条件

#### 技术债

- **Effect v4 类型适配**：`Tool.build()` 需要 `as Effect.Effect<DefWithoutID>` 断言以保持泛型参数推断；搜索工具使用 `InstanceState.get(state)` 而非 `ToolRegistry.Service` 避免层内循环依赖

---


### [0.4.2] - 2026-06-06

#### 修复

- **"请选择智能体和模型"误弹 toast 根治（第 6 次复发）**：`bootstrap.ts` 新增 `agent_ready` 信号 + 5s 超时兜底；`local.tsx` 统一就绪 gate 收敛三路异步信号；`submit.ts` 轮询等最多 5s 而非静默丢提交；`use-providers.ts` `ready()` 不要求 `connected.length > 0`

#### 功能

- **Vision AutoAgent 技能**：DeepSeek 不支持多模态时自动调用 vision MCP (`qwen3-vl:8b`) 分析用户发送的图片，前端只回"分析中..."，不报错、不多耗 token。新建 `.opencode/skill/vision-autoagent/SKILL.md`，`redcode.jsonc` 统一注册所有 skill 至 `instructions` 段

#### 重构

- **双仓分离 — 隐私重构**：灵魂文件 (Tsoul.md/Gsoul.md)、工作记忆 (MEMORY.md)、每日日志 (memory/)、个人命令 (Karina.md/son.md) 全部从仓库移出。仓库仅保留通用模板，实际数据存 `~/.redcode/`。修改涉及：
  - `.opencode/agents/` → 空白模板，不再含个人人格
  - `.opencode/MEMORY.md` → 格式模板，清空个人内容
  - `.opencode/command/` → 重命名为 tui-persona/gui-persona，路径指向 `~/.redcode/souls/`
  - `AGENTS.md` / `README.md` / packages `AGENTS.md` → 抹掉所有个人身份名
  - `CHANGELOG.md` / 配置文件 → 清除 `D:\AI\`、`D:\AI\KLX\` 等硬编码路径
  - `script/sync-home.bat` → 停止同步个人文件，只同步 skill/插件
  - `skill/memory-automation` / `*` → `哥哥` → `用户`，路径改为 `~/.redcode/`
  - 全身搜索已确认无个人名/路径/称呼残留

#### 新增

- **启动时自动播种 `~/.redcode/`**：`InstanceBootstrap.run` 中新增 `ensureDir` + 模板复制逻辑。首次启动自动创建 `~/.redcode/{memory,souls}/`，从 `.opencode/agents/` 复制 Tsoul.md/Gsoul.md/USER.template.md/MEMORY.md，已存在的文件不被覆盖。TUI、GUI sidecar、打包 exe 均走同一路径

#### 文档

- **README 精简 + MANUAL.md 用户手册**：README 仅保留核心介绍和快速开始链接；MANUAL.md 从新人视角编写 420 行完整操作指南，覆盖模型配置、MCP 安装、人格系统、记忆系统、权限控制、Skill 扩展、多机同步

### [0.4.1] - 2026-06-05

#### 修复

- **web-search MCP 系统代理探测**：`search-server/index.ts` 的 `fetchHtml` 之前直接调 PowerShell `Invoke-WebRequest` 不传 `-Proxy`，系统代理关了就直连超时；新增 `getSystemProxy()` 读注册表 `Internet Settings` 的 `ProxyEnable`/`ProxyServer`，代理开启时提取地址显式传给 `-Proxy` 参数，启动时探测一次缓存（`.opencode/search-server/index.ts:25-56`）
- **Compaction 静默化**：之前压缩摘要的完整文本会渲染进对话滚动区，干扰阅读；过滤掉 `mode === "compaction"` 的 assistant 消息，三处同步修改（`pending` memo / `lastAssistant` memo / render Match 条件），标题栏 `—— Compaction ——` 保持不变（`routes/session/index.tsx:204,208,1213`）

#### 优化

- **doom_loop 循环检测扩展**：原判定仅覆盖「同一工具连续 3 次」；新增 `CYCLE_WINDOW = 6` 窗口，检测 A→B→A→B（周期 2）和 A→B→C→A→B→C（周期 3）交替模式，解决 MiMo 等模型在 agentic 任务中反复横跳却绕过阈值的问题（`session/processor.ts:427-458`）

### [0.4.0] - 2026-06-04

#### 新增

- **ECC 启发三件套**：借鉴 ECC（Everything Claude Code）的设计理念，新增三个共享 skill：
  - **`memory-automation`** — 自动化记忆环：SessionStart 自动注入最近 3 天日志教训、PreCompact 保存状态到 `.session-last.json`、Stop 时自动提取教训更新长期库（`.opencode/skill/memory-automation/SKILL.md`）
  - **`guardrail-profiles`** — 三档控制：`ECC_PROFILE=minimal|standard|strict` 环境变量切换，不改配置文件；minimal 少确认快干活、strict 每步都问（`.opencode/skill/guardrail-profiles/SKILL.md`）
  - **`defensive-agent`** — Agent 防御性设计：11 种 FP 不报、4/4 confidence gate、首次编辑不熟文件强制调查引用和依赖（`.opencode/skill/defensive-agent/SKILL.md`）
- **ecc-shell-stub v2**：注入 `ECC_PROFILE`/`ECC_MEMORY_RECENT`/`ECC_MEMORY_LONG` 到 `shell.env`，`permission.ask` 按 profile 区分放行策略
- **Tsoul 人格内化防御模式**：新增"防御模式""怎么改不熟的文件""Guardrail 怎么跑"小节
- **HOOKS.md**：定义 RedCode 的生命周期约定（SessionStart/PreCompact/Stop），plugin 自动 + agent 手动分工

- **DCP 插件集成**：安装 `@tarquinen/opencode-dcp`（动态上下文裁剪），自动压缩旧对话、去重工具调用、裁剪错误输入，节省 token
- **`opencode.jsonc` + `redcode.jsonc` 自动加载**：两个配置文件同步添加 `plugin` + `instructions`，启动即生效

- **`web-search` 极简 MCP server**：受 FreeWeb 启发，只保留 `web_search` 一个工具（`.opencode/search-server/index.ts`，165 行），DuckDuckGo HTML 搜索 + Yahoo 兜底，零 API key；依赖仅 `@modelcontextprotocol/sdk` 一个包，启动 ~1s；Windows 系统代理自动透传（走 PowerShell `Invoke-WebRequest`）

### [0.3.17] - 2026-06-04

#### 新增

- **DeepSeek / MiMo 专属系统提示词**：`session/system.ts` 的 `provider()` 新增 `deepseek`/`mimo` 子串匹配，分别返回 `prompt/deepseek.txt`、`prompt/mimo.txt`；主用的 DeepSeek V4 与小米 MiMo-V2.5 不再走 default 提示词
- **人格触发命令**：`.opencode/command/{gui-persona,tui-persona}.md`，对话里一条命令即加载 GUI/TUI 人格，比手打"你是X"更快；命令仅向上下文注入文字、不替换模型提示词（`request.ts` 的 `agent.prompt` 会顶掉 deepseek/mimo 提示词，故不做成 agent）。**修复**：命令此前从未被引擎加载——`config/paths.ts` 只扫 `.redcode` 目录，命令却放在 `.opencode/command/`；`script/sync-home.bat` 之前同步了 skill 却漏了 command。现补同步 `.opencode/command` → `~/.redcode/command`（真镜像：先删后拷），重启后命令真正生效

#### 工作流

- **全局配置目录迁移 `.redcode` → `~/.redcode`**：从旧位置迁到用户 home 目录。引擎 `config/paths.ts` 的 `directories()` 无条件扫描 `home/.redcode`，不管项目在哪个盘都自动发现，彻底解决跨盘/跨机器路径问题；`build.bat` 同步目标改为 `%USERPROFILE%\.redcode`
- **全局记忆/画像机制化注入**：`~/.redcode/redcode.jsonc` 的 `instructions` 由 `session/instruction.ts` 引擎侧读取并在 `:137` 展开 `~/`，每个项目启动自动注入 `MEMORY.md`/`USER.md`，消除旧的"靠 AGENTS.md 喊话读 MEMORY"行为链脆弱点

#### 文档

- **AGENTS.md 重构**：根 AGENTS.md 身份触发段补充人格命令与自动注入说明；`packages/{opencode,desktop}/AGENTS.md` 顶部加 breadcrumb（本包=TUI/GUI、对应人格），进子目录读文件时自动叠加强化身份

### [0.3.16] - 2026-06-03

#### 重构

- **语义颜色分层**：在 47 个扁平颜色属性之上新增 `theme.colors` 语义层，按 text/surface/border/status/diff/markdown/syntax 8 组分群。旧属性完全兼容，新代码可用 `colors.text.body`、`colors.surface.panel`、`colors.status.error` 等语义路径访问
- **Theme 类型导出**：`Theme` 类型从 `theme.tsx` 导出，`SharedSyntaxTheme` 收敛为类型断言，减少重复类型定义

#### 修复

- **llm 模块循环依赖**：`schema/options.ts` → `route/client.ts` → `schema/index.ts` → `schema/options.ts` 的 17 文件循环依赖降至 3 文件（transport barrel 循环，可接受）。移除 `schema/options.ts` 对 `route/client.ts` 的反向导入，改用本地类型定义
- **theme-store 测试**：`DEFAULT_THEMES.redcode` 修正为 `DEFAULT_THEMES.opencode`，恢复 4 个损坏的单元测试
- **system 主题 isDark 时序**：`generateSystem` 中 `isDark` 声明移至 `fallbackBg`/`fallbackFg` 之前，修复 Temporal Dead Zone 导致的 ReferenceError
- **palette 回退兜底**：`generateSystem` 中 `palette[0]`/`palette[7]` 可能为 undefined，补充 `#1a1b26`/`#ffffff` 硬编码回退色值
- **Proxy 类型安全**：`theme.tsx` 中 Proxy getter 移除 `@ts-expect-error`，改用 `keyof Theme` 类型断言
- **resolveTheme 过滤补全**：`backgroundMessage` 加入初始过滤列表，避免重复解析

### [0.3.15] - 2026-06-03

#### 新增

- **MCP 懒加载**：启动时不连接 MCP server，第一次调用该 MCP 的 tool 时才按需连接，减少冷启动等待
- **MCP pending 状态**：侧边栏 MCP 面板显示"Waiting…"等待状态，启动时一目了然

#### 工作流

- **删除文件单独授权**：`apply_patch` 中 `type: "delete"` 的操作需额外弹窗确认，不再是编辑权限附带的
- **灵魂文件进仓库**：`Gsoul.md` / `Tsoul.md` 从上级目录移入 `.opencode/agents/`，git 跟踪推送，换机自动同步
- **全局 workspace（`.redcode/`）**：在项目上级创建全局共享目录，包含 AGENTS.md、MEMORY.md、USER.md、souls 等，所有项目共享身份与记忆，不再每项目重复搭建
- **`build.bat` 版本自检**：编译前自动跑 `check-version-consistency.ts`，版本不一致时阻止编译并提示
- **权限范围扩展**：`containsPath` 增加上级目录检查，信任与项目同级的兄弟项目

---

### [0.3.14] - 2026-06-03

#### 新增

- **MCP 配置热重载**：文件 watch `redcode.jsonc`，检测到 MCP 配置变更后自动添加/删除/重连服务器，无需重启 TUI
- **MCP 工具调用进度推送**：耗时较长的 MCP 工具调用（如 browser 截图）实时显示进度状态，避免无响应感

---

### [0.3.13] - 2026-06-03

#### 新增

- **消息视觉区分**：用户消息添加 `> ` 前缀（agent 色加粗），AI 消息添加 ✦ 前缀（accent 色）
- **语义色 `backgroundMessage`**：用户消息背景色独立于面板色，后续主题可单独定制

#### 修复

- **Browser MCP 端口冲突**：server 启动时自动检测 9001 端口，被僵尸进程占用时自动 kill 旧进程并重试

---

### [0.3.12] - 2026-06-03

#### 新增

- **MCP 健康监控**：每 30s 检查所有 connected 的 MCP server，连续 3 次失败标记断开并自动尝试重连
- **MCP 工具调用失败自动重连**：tool call 报错时自动尝试 reconnect 并重试（最多 3 次）
- **MCP Transport 日志**：记录实际使用的 transport 类型（stdio/SSE/HTTP），便于排查

---

### [0.3.11] - 2026-06-03

#### 修复

- **MCP 进程树泄漏（Windows）**：`descendants` 在 Win32 直接返回空数组，导致每次 TUI 退出时子进程（codegraph/typegraph/npx 链）变成僵尸堆积。改为 `taskkill /F /T /PID` 一次杀整棵树，Unix 保持原逻辑
- **Browser MCP 断连**：server `socket.on("close")` 无条件置 `ws = null`，导致新连接被旧 socket 的 close 事件覆盖破坏。改为 `if (ws === socket)` 条件判断
- **exe MCP 路径解析**：编译后的 exe 运行时 `cwd` 是 bin/ 目录，相对路径（`./browsermcp-server/index.js`）解析失败。新增 `findProjectRoot`，从 exe 所在目录向上查找 `redcode.jsonc` 或 `.git`，确保 MCP 命令路径正确解析
- **滚动条默认值迁移**：kv 存储中旧的 `scrollbar_visible: false` 会覆盖新默认值。新增一次性版本迁移（`kv_version`），首次启动时自动升级为 `true`

#### 变更

- **滚动条默认开启**：消息区域右侧滚动条默认显示，支持鼠标点击轨道跳转和拖拽滑块滚动。可通过 `session.toggle.scrollbar` 命令或 `/mcps` 切换
- **Browser MCP 扩展 v1.0.3**：改用 `chrome.alarms` 保活（每 24s 触发），替代不可靠的 `setTimeout`，解决 Manifest V3 service worker 休眠后断连

#### 配置

- `redcode.jsonc` 新增 browsermcp 配置
- `.opencode/opencode.jsonc` 新增 browsermcp 配置

#### 新增

- **Browser MCP 集成**：新增浏览器自动化 MCP 服务器，支持导航、截图、点击、输入、获取页面内容等操作，可让 AI 直接操控主人的浏览器
- **jCodeMunch MCP 集成**：新增结构化代码检索服务器（60+ 工具），支持精确符号获取、死代码检测、影响评估、编辑安全预检、AST 模式匹配等，比 grep 省 95% token
- **TypeGraph MCP 集成**：TypeScript 语义导航服务器（14 个工具），支持类型解析、调用链追踪、barrel 文件穿透、循环依赖检测

#### Browser MCP 使用方式

1. 安装 Chrome 扩展：
   - 打开 `chrome://extensions/`
   - 开启"开发者模式"
   - 点"加载已解压的扩展程序" → 选择项目内的 `browsermcp-extension` 目录（相对路径，跨电脑/盘符通用）
2. 点击扩展图标 → Connect（图标显示绿色 "ON" 表示连接成功）
3. 重启 TUI 生效

可用工具：`browser_navigate`、`browser_go_back`、`browser_go_forward`、`browser_snapshot`、`browser_click`、`browser_type`、`browser_hover`、`browser_select_option`、`browser_press_key`、`browser_wait`、`browser_screenshot`、`browser_get_console_logs`

---

### [0.3.9] - 2026-06-02

#### 新增

- **Prompt 栏点击切换**：Agent 名称、模型名称、推理强度标签支持鼠标点击，直接弹出对应选择列表（DialogAgent/DialogModel/DialogVariant）
- **用户可配置快捷键**：`tui.json` / `tui.jsonc` 已完整支持 `keybinds` 字段覆盖默认快捷键，支持全局（`~/.config/redcode/tui.json`）、项目级、`.redcode/` 目录级配置，逐级合并覆盖

---

### [0.3.8] - 2026-06-02

#### 新增

- 动态终端标题：session 忙碌时标签栏显示 `▶` 前缀，空闲恢复；多 tab 终端一目了然
- 统一清理注册表：`CleanupRegistry` 集中管理所有退出清理（keymap、console 劫持、plugin runtime、audio），避免散落 `finally` 导致泄漏

#### 修复

- **构建流程修复**：Windows 上 `rm -rf` 因文件锁定失败不再中断编译，用 `try/catch` 安全跳过
- **版本号硬编码**：预览版不再生成 `0.0.0-dev-<timestamp>`，改用 `package.json` 中的真实版本号
- **Console 污染 TUI 渲染**：`console.log/warn/error` 在 TUI 启动后被劫持转入环形缓冲区（500 条），退出时还原，避免第三方库日志乱入终端

---

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

### [0.4.4] - 2026-06-06

#### 新增

- **错误兜底 P1 — Retry UI**：提交消息失败时，composer 底部显示错误横幅（包含可读错误信息 + Retry 按钮 + 关闭按钮）。用户编辑输入或发送成功时自动清除。`restoreInput()` 已在 0.4.2 确保输入文本保留，此版在保留基础上增加可视化反馈和重试入口（`prompt-input/submit.ts` + `prompt-input.tsx`）
- **Session 标签状态指示器**：标题栏会话标签页新增状态指示点——`busy` 时显示黄色脉冲点、`retry` 时显示红色点。通过 `sync.data.session_status` 驱动，实时的会话运行状态一目了然（`titlebar.tsx`）

### [0.4.3] - 2026-06-06

#### 新增

- **三款新配色方案**：护眼绿（Eye Green）、米黄（Cream）、深蓝（Deep Blue）三种全新配色方案，与主题完全独立。原 ColorScheme 类型从 `"light" | "dark" | "system"` 扩展为 6 种，`data-color-scheme` 属性驱动 CSS 变量覆盖。亮色变体（cream/green）复用 light 主题变体，深色变体（deepblue）复用 dark 主题变体，各配色独立覆盖背景/文字/图标色值。**v2 主题系统（composer / 新组件）+ 老主题系统（文件树/聊天/审查面板）双套令牌均覆盖**——后者在 `packages/ui/src/styles/theme.css` 内增加对应 `[data-color-scheme="..."]` 块，盖过 OS 自动 dark 切换，避免主面板仍是白底。设置页「外观→配色方案」下拉菜单可选用。涉及 5 个核心文件（`context.tsx` 类型 + resolveMode / 两份 `theme.css` 色值 / `theme-constants.ts` / `settings-general.tsx` 选项 / i18n 中文英文繁体翻译）

#### 优化

- **ResizeHandle 可见化**：拖拽分割条新增 `background: var(--border-weaker-base)`，hover 时不再透明不可见（`resize-handle.css`）
- **标题栏底部视觉分隔**：标题栏新增 `border-b border-border-weaker-base`，与内容区建立层次（`titlebar.tsx`）
- **消息轮次淡入动画**：`@keyframes turn-fade-in` 动画让每条消息从 `opacity: 0 translateY(4px)` 淡入（`session-turn.css`）

### [0.4.2] - 2026-06-06

#### 修复

- **bootstrapDirectory 未执行导致输入框卡死（#3）**：`child-store.ts` 的 `status` 硬编码 `"complete"`，`child()` 中 `status === "loading"` 的 bootstrap 触发条件永不为真；`"server.connected"` 事件路径可能在 GUI 启动时跳过（空 `children` 或 `recent` 守卫）。`agent_ready` 永远 `false` → 统一就绪 gate 卡死 → 输入框无法发送。修复：在 `ensureChild()` 新建 child store 后直接调用 `onBootstrap(directory)`，不依赖事件或 status 检查（`child-store.ts:274-277`）
- **"请选择智能体和模型" 误弹 toast（第 6 次复发 · 根治）**：彻底定位结构性病根并收敛。submit 依赖 providers / models / **agent** 三个异步信号，但 agent 列表由 `bootstrap.ts` 的 **slow 批次** fire-and-forget 填充、**从无就绪标志**（不像 provider 有 `provider_ready`），导致 `agent: []` 空窗期内 `agent.current()` 兜底失败返回 null → 弹 toast。历次修复（0.3.16 加 submit ready、0.3.17 加 child-store fallback、0.4.1 改 `||→&&`）都只补当时暴露的那条腿，agent 这条从未被挡，故每逢单数版本改 render 路径（扰动 SolidJS 挂载时序、放大 race window）必复发。**根治三步**：① `types.ts`/`child-store.ts` 新增 `agent_ready` 字段，`bootstrap.ts` 在 agent 加载完成的 `.then` 里置真；② `local.tsx` 新增统一就绪 gate `ready() = providers.ready() && model.ready() && sync.data.agent_ready`，三信号收敛到一处，将来新增异步依赖只在此补条件、不再散落漏挡；③ `submit.ts` 改用 `local.ready()`，加载中静默返回（该 toast 历次误弹的唯一根因），仅当 gate 通过仍为 null（真·无 provider 配置）才提示。删除 submit 中已无用的 `useProviders` 依赖

### [0.4.1] - 2026-06-05

#### 新增

- **用户/助手头像系统**：`settings.tsx` 新增 `userProfile` + `assistantProfile` 字段（各含 `avatar` + `displayName`），支持 base64 图片上传。用户消息气泡旁显示自定义头像（`message-part.tsx`），助手消息显示可配置头像（`message-timeline.tsx`）。`avatar.tsx` 新增 `medium` 尺寸（2.5rem），聊天头像统一使用
- **用户消息气泡美化**：气泡内边距 8px → 10px 上下/14px 左右，圆角 6px → 10px 10px 4px 10px（右下角更锐），新增 `body-row` 弹性容器 avatar 与内容并排（`message-part.css`）
- **设置页用户资料 + 助手头像区**：`settings-general.tsx` `ProfileSection` 包含显示名输入框、用户头像上传/预览/移除；新增 `Assistant Avatar` 区，支持助手头像独立上传
- **web-search Google 兜底**：DuckDuckGo + Yahoo 后新增 Google 搜索 fallback，系统代理自动补 `http://` 前缀

#### 修复

- **"请选择智能体和模型" 误弹 toast**（第 5 次复发）：`providers.ready()` 用 `||` 判断 `all.size > 0 || connected.length > 0`，数据加载初期 `all` 先到即返回 true，但 `connected` 还空时 `defaultModel()` 返回 null，导致 submit guard 误判并弹 toast。改为 `&&`，要求 `all` 和 `connected` 都加载完才算 ready。**规律**：单数版本（0.3.16→0.3.17→0.4.1）每次改 `submit.ts` / `message-timeline.tsx` 等渲染路径时触发，修改渲染/消息组件后必须走完整数据流验证（`use-providers.ts:36`）
- **思考中仓鼠浅色模式黑标**：`/hamster.png` 透明 PNG 在浅色主题下黑色锯齿边缘可见。包裹 `background: var(--surface-base)` 容器 + `mix-blend-mode: screen` 消除黑色边缘（`message-timeline.tsx:171-178`）

#### 优化

- **`session.tsx` 拆分**：1667 行 `Page()` 函数抽出 4 个独立模块——`session-history-loader.ts`（历史加载）、`session-review-diff.ts`（Review diff 滚动）、`session-message-nav.ts`（消息导航/光标）、`session-keyboard.ts`（键盘快捷键）。主文件 1623 行，各模块面向入参不耦合闭包
- **avatar 组件新增 medium 尺寸**：2.5rem（40px），聊天头像专用，小号 2 倍

### [0.4.0] - 2026-06-04

#### 新增

- **目标自动化（goal-automation）**：本版本立项，TUI/GUI 两端共享
  - **`/goal` 斜杠命令**（`.opencode/command/goal.md`，`sync-home.bat` 同步到 `~/.redcode/command/`）：用户在 TUI 或 GUI 里 `/goal <text>` 钉住当前会话目标，agent 围着目标转、不会跑题；`/goal clear` 清掉、`/goal done` 标完成。命令 YAML `model: kimi-k2.5` 轻量模型执行
  - **`goal-automation` skill**（`.opencode/skill/goal-automation/SKILL.md`）：agent 看到大任务时主动建议一次，**不自动钉**——主动权在用户手上。触发条件（3+ 轮、跨多文件、含修/实现/重构等词、出现 done 标志，三选二即建议），不刷屏、不在 flow 时打断
  - **`opencode.jsonc` 挂载**：instructions 数组新增 `./.opencode/skill/goal-automation/SKILL.md`，TUI/GUI 两端自动加载
  - **GUI 人格内化**：Gsoul.md 加协作模式段，承认 /goal /deepwork + goal-automation，主动权归用户
- **GUI 承认 ECC 启发三件套**：Gsoul.md 加"ECC 启发三件套"段——`memory-automation` / `guardrail-profiles` / `defensive-agent` 走自动挂载机制，GUI 同享，不需额外配置

#### 推迟到 0.4.1

- **GUI 端 `/goal` chip 顶部指示器**：原计划在 Titlebar 加 chip 让用户可见当前钉住的目标。砍掉原因：数据流未设计清楚（layout.tsx 跨层读 chat 状态、OpenCode command 系统不顺、IPC 改造成本大），为假想需求硬写不划算。0.4.1 补，先想清楚数据流（备选：command 系统改造 / 新建 cross-layer store / 走 plugin 通道）

#### 变更

- 版本号升级 0.3.17 → 0.4.0

### [0.3.17] - 2026-06-04

#### 修复

- **标题栏版本号写死漂移**：`index.html` 标题栏徽章原本硬编码 `v0.3.16`，每次升级要手动改、极易漏改 → 编译出的 exe 显示旧版本。改为占位符 `v__RC_VERSION__`，`electron.vite.config.ts` 新增 `redcode:inject-version` 插件（`transformIndexHtml`），build/dev 时从 `package.json` 自动注入。GUI 自此与 TUI 一致：`package.json` 为唯一版本来源
- **桌面通知图标请求死域名**：`index.tsx` `notify()` 的通知图标硬连 `https://redcode.dev/favicon-96x96-v3.png`，该域名未注册 → 每次弹通知 DNS 解析失败、控制台刷 `ERR_NAME_NOT_RESOLVED`。改为基于 `document.baseURI` 解析本地打包图标，不再发外网请求
- **思考中仓鼠 emoji 跨平台渲染**：Win10 渲染正常（Segoe UI Emoji 多色渐变），Win11 渲染为 Fluent 扁平纯色块。将 🐹 emoji 替换为本地仓鼠图片（`/hamster.png`），彻底消除系统 emoji 字体差异

#### 构建说明

- `check-version-consistency.ts` 标题栏徽章检测兼容 `__RC_VERSION__` 占位符（视为恒一致，因构建期自动同步）

### [0.3.16] - 2026-06-04

#### 修复

- **`build-and-package.bat` 同步目标遗留**：打包脚本仍往旧目录同步 souls/MEMORY/AGENTS，导致配置迁移到 C 盘后两处残留。改为 `%USERPROFILE%\.redcode`，与 TUI `build.bat` 对齐

#### 变更

- **同步全局配置目录迁移**：GUI 以 opencode 为 sidecar，随服务端一并吃到 `~/.redcode` 迁移与全局记忆机制化注入
- 版本号升级 0.3.15 → 0.3.16

### [0.3.15] - 2026-06-03

#### 新增

- **ECC 插件状态指示器**：标题栏版本号旁显示绿色 `ECC` 标签，一眼确认插件已加载
- **压缩策略优化**：`experimental.session.compacting` 扩展 prompt，保留任务进度、错误信息、测试结果等关键上下文

#### 修复

- **审视面板拖拽方向反了**：ResizeHandle 新增 `invert` 属性，左移审视变宽、右移变窄

#### 变更

- 版本号升级 0.3.14 → 0.3.15

### [0.3.14] - 2026-06-03

#### 新增

- **ECC Plugin 集成**：`.opencode/plugins/ecc-shell-stub.js` 自动加载，提供以下功能：
  - `shell.env` — 注入 ECC 环境变量
  - `tool.execute.after` — 自动跟踪文件变更
  - `experimental.session.compacting` — 上下文压缩时保留关键上下文
  - `permission.ask` — 自动放行读/格式化/测试等安全操作
  - `changed-files` tool — 查看当前会话改过的文件
  - `git-summary` tool — 一条命令返回分支/状态/log/diff

#### 变更

- 版本号升级 0.3.13 → 0.3.14

#### 修复

- **审视面板拖拽方向反了**：ResizeHandle `edge` 默认 `"end"` 导致拖拽方向与直觉相反。改为 `edge="start"`，左移变宽、右移变窄
- **browsermcp-server 端口冲突无法恢复**：ESM 模块内使用 `require("child_process")` 导致端口被占时 kill 逻辑报错。改为顶层 `import` 修复

#### 工作流

- **版本一致性自检脚本**：新增 `script/check-version-consistency.ts`，编译前自动扫描 package.json/README/CHANGELOG/标题栏版本号是否对齐
- **build-and-package.bat 自动检查**：编译前跑版本自检 + 自动同步灵魂文件到上级目录供其他项目使用
- **全局 workspace（`.redcode/`）**：AGENTS.md/MEMORY.md/USER.md/souls 移至全局目录，所有项目共享身份与记忆，build bat 自动同步

### [0.3.13] - 2026-06-02

#### 修复

- **仓鼠位置修复**：将 🐹 从 flex `ml-auto`（最右）移到 TextShimmer"思考中"之后。当 AI 产生 reasoning heading（如 markdown 标题）时，`TextReveal` 展开不再把仓鼠推到右侧角落

#### 重构

- **抽取 `UpdateAvailableToast`**：将文件末尾的 32 行子组件移到 `components/update-available-toast.tsx`，零行为变化
- **抽取主题常量**：`colorSchemeOrder` / `colorSchemeKey` 纯常量从 `layout.tsx` 抽到 `pages/layout/theme-constants.ts`

#### 布局调整

- **FileTree → 最左、Review → 最右**：新布局为三栏：`[FileTree] [Chat] [Review]`
  - `FileTreePanel` 从 `SessionSidePanel` 内部分离为独立组件 `pages/session/file-tree-panel.tsx`
  - `session.tsx` 主 flex 容器改为：`<FileTreePanel />` → `<ChatPanel />` → `<SessionSidePanel />`
- **删除 V1 sidebar fallback**：`layout.tsx` V1 旧设计（152 行无引用代码）移除，`USE_NEW_DESIGN` 常量删除
- **删除 `sidebar.toggle` 命令**：V2 设计下 Sidebar 永不显示，对应 Cmd+B 命令移除

### [0.3.12] - 2026-06-02

#### 新增

- **思考中仓鼠动画**：在 AI 思考状态行的右侧加 🐹 emoji，左右小跑 + 上下跳动，1.2s 循环（与左侧 Mona 猫猫 gif 配合，更可爱）
- **Sidebar 展开/折叠过渡动画**：`sidebar-shell.tsx` 的 panel 容器加 `transition-opacity duration-150`，展开/折叠时内容平滑淡入淡出
- **Cmd+1 ~ Cmd+9 切项目快捷键（V2 设计补全）**：`layout.tsx` 移除 `!USE_NEW_DESIGN` 条件限制，V2 设计也支持 `Cmd+1` ~ `Cmd+9` 切换项目；修复 title bug 用 i18n `command.project.index`
- **Cmd+T 切下一个会话 / Cmd+Shift+T 切上一个会话**：在 `use-session-commands.tsx` 添加 `session.next` / `session.previous` 命令，按当前 project 内的 root session 排序（recent 在前）切到下一个/上一个

#### 优化

- **Sidebar 列表 hover 体验**：原本 hover 时只显示 archive 按钮；现在 archive 按钮的 `transition-[width,opacity]` 过渡更平滑

---

### [0.3.11] - 2026-06-02

#### 新增

- **设计系统 token**：CSS 变量化同心圆角（`--radius-xs/sm/md/lg/xl/2xl`）、分层阴影 5 级（`--shadow-xs/sm/md/lg/xl`，每级双层偏移），全局统一
- **文字排版优化**：`h1-h4` 启用 `text-wrap: balance`，段落启用 `text-wrap: pretty`，标题更整齐，段落不孤字
- **统一 focus 指示器**：所有可聚焦元素通过 `:focus-visible` 显示 2px outline + 2px offset，键盘可访问性提升
- **Sidebar 折疉态项目指示器增强**：通知红点放大到 8px、加 ring 描边、permission/error 状态加 `animate-pulse` 脉冲动画；unseen 数量徽章（>1 显示数字，>9 显示 "9+"）；working spinner 加 ring 描边

---

### [0.3.10] - 2026-06-02

#### 新增

- **V2 Titlebar 全量启用**：Tab 式 session 管理上线，支持 `Cmd+W` 关闭 tab、`Cmd+Option+←/→` 切换 tab、项目头像 + 标题显示；右侧集成 StatusPopover（token 用量）和 Update pill
- **Loading 窗口动画**：Logo 呼吸脉冲动画、内容区域淡入、进度条平滑过渡，启动体验更流畅
- **Home 搜索快捷键**：`Cmd+K` / `Ctrl+K` 一键聚焦搜索框，搜索框右侧显示快捷键提示
- **Home 空状态优化**：无 session 时显示大图标 + 标题 + 描述 + "New Session" 按钮，替代原来的一行文字

#### 清理

- 移除 9 处 `VITE_REDCODE_CHANNEL` feature flags，所有 V2 功能（Titlebar、Layout、Session Design、Prompt Input）在生产环境统一启用
- 移除已废弃的 `DesktopTitlebarIconButton` 空组件
- 简化 session-side-panel、session-header、settings-general 中的 beta 门控逻辑

---

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
