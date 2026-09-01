# ⚡ RedCode

<p align="center">
  <img src="docs/assets/chi-portrait.webp" height="360" alt="RedCode 看板娘「赤」">
</p>

<p align="center"><sub><b>赤</b> — RedCode 的看板娘。两个 exe 的图标、GUI 的启动画面都是她。</sub></p>

> **中文母语的 AI 编程助手。** 终端（TUI）或桌面（GUI），说中文，插你喜欢的模型——DeepSeek、OpenAI、Anthropic、Ollama，国产优先。
>
> 基于 [opencode](https://github.com/anomalyco/opencode)（sst.dev）深度二次开发，侧重**前缀缓存优化、多模型适配、中文体验和稳定性**。

[![版本](https://badgen.net/badge/版本/0.10.1/blue)](CHANGELOG.md)
[![平台](https://badgen.net/badge/平台/Windows%2010%2F11/green)](https://github.com/JiaHuiRed/RedCode)
[![TypeScript](https://badgen.net/badge/TypeScript/7.x/3178c6)](https://typescriptlang.org)
[![Bun](https://badgen.net/badge/Bun/1.3.x/fb6e19)](https://bun.sh)
[![许可证](https://badgen.net/badge/许可证/MIT/grey)](LICENSE)

---

## ✨ 这是什么？

AI 编程助手。**两个入口、同一引擎**——同一个服务端、同一份会话库、同一套配置，TUI 里开的会话在 GUI 里接着聊。

<p align="center">
  <img src="docs/assets/screenshot.png" width="760" alt="RedCode TUI 截图">
</p>

| | |
| --- | --- |
| **TUI** `packages/opencode` | 终端界面，单文件 exe。无参数启动会先出工作区选择器（鼠标可点、滚轮可滚，也能手输任意目录）。侧边栏可插件化扩展。 |
| **GUI** `packages/desktop` | Electron 桌面窗口。首页带**用量看板**，会话内有 diff 审阅、文件预览（图片 / 音频 / PDF）、上下文用量页。Tauri 迁移中——`src-tauri/` 工程已就位，构建流程尚未接入。 |

读代码、写代码、改 bug、跑命令。你说中文，它干活。

---

## 🧠 核心能力

| 类别 | 内容 |
| --- | --- |
| **代码理解** | jCodeMunch / TypeGraph 索引，跨文件跳转与影响面分析 |
| **动手** | 文件读写编辑 · 终端执行 · Web 搜索 · 视觉分析（多模态模型直接识图，也可指定子代理代劳） |
| **多模型** | DeepSeek / OpenAI / Anthropic / GLM / Qwen / MiniMax / Ollama… 按角色分配不同模型 |
| **上下文** | 前缀缓存保鲜 · 自动压缩 · 上下文用量可视化 |
| **组织** | 会话管理 · 目标管理 · 自动化记忆系统 · Skill 技能系统 |
| **代理** | 四角色子代理（explore / architect / fixer / reviewer）· 自定义 AI 人格 |
| **安全** | 权限门控与防护环，三档姿态见下 |

### 三档权限姿态

输入框下拉那一栏就是权限轴，三档**只差权限**，不换提示词也不换模型：

| 姿态 | 能做什么 |
| --- | --- |
| **Plan** 🟦 | 只读、只建议。`edit: deny`，所以它给得出方案但落不了地。 |
| **RedMind** 🟥 | 默认档。动手，但破坏性操作、工作树之外的目录、`.env` 读取会先问你。 |
| **Auto** 🟧 | 不打断，上面那些全部自动放行。只适合你已经确认安全的任务。 |

---

## 🎯 相比上游做了什么

- **前缀缓存保鲜**：多层缓存（msgPin → modelMsgs → tools → system）压低输入成本
- **多模型计价适配**：支持 DeepSeek cache 计价阶梯，修复上游 `cacheReadInputTokens` 为 0 的漏报；套餐额度（ChatGPT / Codex 的 5 小时档、7 天档、储备池）在 TUI 侧边栏和 GUI 上下文页都有面板
- **用量看板**：首页直接看项目级总账——缓存命中环、会话/请求/产出 Token、活跃天数与连续天数、活动热力图、按模型分天的堆叠柱。数据走服务端聚合端点，不是前端把已加载的那批会话 reduce 一遍（那样只会得到「已加载部分」的和）
- **中文体验**：完整中文文档、中文 UI，三语 i18n（zh / en / ja）
- **国产模型优先**：零配置支持 DeepSeek、GLM、Qwen、MiniMax、Zhipu 等
- **多机同步**：机器本地覆盖层 `redcode.local.jsonc`，同步的配置只留机器无关内容
- **稳定性专项**：0.10.0 起做过一轮桌面端性能定案——「慢」的主因是主进程的同步 I/O 而非渲染，逐条实测修完后启动到渲染层连上 7.28s → 5.71s，首屏 chunk 累计减 1.26MB，流式渲染每 tick 的重算量降到 1/16。细节全部记在 [CHANGELOG.md](CHANGELOG.md)

---

## 🚀 快速开始

前置要求：[Bun](https://bun.sh) 1.3+

```bash
git clone https://github.com/JiaHuiRed/RedCode.git
cd RedCode
bun install

# 启动 TUI
bun dev

# 或启动桌面 GUI
cd packages/desktop && bun run dev
```

> 第一次启动自动创建 `~/.redcode/` 并播种默认模板，无需手动配置。

### 编译

> 也可直接双击一键 bat：TUI `packages/opencode/build.bat` / GUI `packages/desktop/build-and-package.bat`。

```bash
# TUI 单文件 exe
cd packages/opencode && bun run build

# 桌面 GUI
cd packages/desktop && bun run build && bun run package
```

> TUI 编译产物：`packages/opencode/dist/redcode-windows-x64/bin/redcode.exe`，可直接双击运行。

### 📱 在手机上用

```bash
redcode web --hostname 0.0.0.0
```

同一局域网内用手机浏览器开终端里打印的 `Network access` 地址即可。**绑定到局域网时必须设密码**——没设的话启动会被直接拦下，不是打印一行警告就放行。

---

## 📖 用户手册

全部操作指南在 **[MANUAL.md](MANUAL.md)**，涵盖：

1. 快速启动 · 2. 首次设置（模型 / 称呼 / AI 人格）· 3. 配置模型（适配器 / 切换 / 本地 Ollama）
4. MCP 服务器（预配置服务的启用）· 5. AI 人格系统 · 6. 记忆系统（自动日志 / 长期库 / 启动注入）
7. 配置详解（配置层次 / 权限门控 / 自定义 MCP）· 8. 内置命令 · 9. Skill 技能系统
10. 隐私与多机同步——含**机器本地覆盖层**，解决"同一份配置在两台机器上来回改"的死循环

---

## 📋 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

---

## 💙 致谢

- 原项目：[opencode](https://github.com/anomalyco/opencode)（sst.dev）
- 代码检索能力由 [jcodemunch-mcp](https://github.com/jgravelle/jcodemunch-mcp) 提供驱动
- 许可证：MIT
