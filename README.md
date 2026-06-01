# ⚡ RedCode

<p align="center">
  <img src="packages/app/public/mona-loading.gif" width="80">
</p>
<pre align="center">
██████ ██████ ██████ ██████ ██████ ██████ ██████
█   █ █     █  ██  █     █   █ █  ██  █    
█████  ██████ █   █ █     █   █ █   █  ██████
█  ██ █     █   █ █     █   █ █   █  █    
█   █ ██████ ██████ ██████ ██████ ██████ ██████
</pre>

> **开源 AI 编程助手 — 终端 + 桌面双端智能编程代理，支持 DeepSeek / OpenAI / Anthropic / Ollama 等多模型。**
> 作者：Red · 基于 [opencode](https://github.com/anomalyco/opencode) (sst.dev) 二次开发。

[![TUI](https://img.shields.io/badge/TUI-0.3.8-blue)](CHANGELOG.md)
[![Desktop](https://img.shields.io/badge/Desktop-0.3.8-0078d4)](CHANGELOG.md)
[![平台](https://img.shields.io/badge/平台-Windows%2010%2F11-0078d4)](https://github.com/JiaHuiRed/RedCode)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6)](https://typescriptlang.org)
[![Bun](https://img.shields.io/badge/Bun-1.3.x-fcf2d0)](https://bun.sh)
[![许可证](https://img.shields.io/badge/许可证-MIT-lightgrey)](LICENSE)

---

## ✨ 这是什么？

开源 AI 编程助手，提供**终端 TUI** 和**桌面 GUI** 两种交互方式。能读取代码库、执行命令、编辑文件、搜索代码，通过自然语言对话完成编程任务。

---

## 🧩 核心功能

- 💬 **自然语言编程**：用中文描述需求，自动完成代码编写、重构、调试
- 🔌 **多模型支持**：DeepSeek、OpenAI、Anthropic、Google Gemini、Ollama 本地模型等
- 🛠 **工具系统**：文件读写、代码搜索、终端命令、Web 搜索
- 🤖 **智能 Agent**：Build、Plan、General、Explore 等内置 Agent，支持自定义
- 📝 **会话管理**：历史对话保存、恢复、分支（fork）
- 🎨 **终端 UI**：语法高亮、流式输出、文件差异展示
- 🖥 **桌面 GUI**：Electron 独立窗口，完整图形界面
- 📊 **MCP 服务器**：
  - [CodeGraph](https://github.com/colbymchenry/codegraph) — 代码知识图谱，符号/调用链/影响分析
  - [TypeGraph](https://github.com/guyowen/typegraph-mcp) — TypeScript 语义导航（类型解析、barrel 文件穿透、循环依赖检测）
- 🔒 **权限系统**：工具调用前确认，支持自动批准
- 🌍 **多语言**：中文、英文、日文等 18 种语言
- 🗣 **TTS 朗读**：MiMo TTS 语音朗读 AI 回复

---

## 🚀 运行（源码方式）

```bash
git clone https://github.com/JiaHuiRed/RedCode.git
cd RedCode
bun install

# 构建 MCP 索引（首次需要）
npx -y @colbymchenry/codegraph index

# 启动 TUI（交互式终端）
bun dev

# 或启动桌面 GUI
cd packages/desktop && bun run dev
```

---

## ⚙️ 配置说明

### 配置文件位置

| 位置 | 用途 |
|------|------|
| `~/.config/redcode/redcode.json` | 全局配置 |
| `项目目录/redcode.jsonc` | 项目级配置 |
| `项目目录/.opencode/opencode.jsonc` | 兼容配置（旧格式） |

### 添加自定义 Provider

```jsonc
// redcode.jsonc
{
  "$schema": "https://redcode.dev/config.json",
  "provider": {
    "my-provider": {
      "type": "openai",
      "apiKey": "sk-xxx",
      "baseURL": "https://api.example.com/v1"
    }
  },
  "model": "my-provider/my-model"
}
```

### MCP 服务器配置

```jsonc
{
  "mcp": {
    "codegraph": {
      "type": "local",
      "command": ["npx", "-y", "@colbymchenry/codegraph", "serve", "--mcp"],
      "enabled": true
    },
    "typegraph": {
      "type": "local",
      "command": ["npx", "tsx", "path/to/typegraph-mcp/server.ts"],
      "environment": {
        "TYPEGRAPH_PROJECT_ROOT": ".",
        "TYPEGRAPH_TSCONFIG": "./tsconfig.json"
      },
      "enabled": true
    }
  }
}
```

---

## 🖥 桌面 GUI

独立 Electron 窗口，提供完整图形界面：

- 会话列表管理
- 侧边栏项目切换
- 模型/Agent 选择器
- 设置面板（Provider 配置、模型管理、TTS 设置）
- 文件差异展示
- 代码语法高亮
- MCP 服务器管理

### 打包

```bash
cd packages/desktop
bun run build      # 编译
bun run package:win  # 打包 Windows 免安装版
```

输出目录：`packages/desktop/dist/win/`

---

## 🛠 技术栈

| 层 | 技术 |
|----|------|
| 运行时 | Bun |
| 语言 | TypeScript |
| 终端 UI | SolidJS |
| 桌面 GUI | Electron + SolidJS |
| AI SDK | Vercel AI SDK |
| 数据库 | SQLite (Drizzle ORM) |
| 构建 | Turborepo (monorepo) |
| MCP | CodeGraph + TypeGraph |

---

## 📋 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

---

## 💙 致谢

- 原项目：[opencode](https://github.com/anomalyco/opencode)（sst.dev）
- 许可证：MIT
