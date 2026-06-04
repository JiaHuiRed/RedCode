# ⚡ RedCode

<p align="center">
  <img src="packages/app/public/mona-loading.gif" width="80">
</p>
<pre align="center">
██████ ██████ ██████ ██████ ██████ ██████ ██████
█   █ █     █  ██  █     █   █ █  ██  █    
██████ ██████ █   █ █     █   █ █   █  ██████
█  ██ █     █   █ █     █   █ █   █  █    
█   █ ██████ ██████ ██████ ██████ ██████ ██████
</pre>

> **开源 AI 编程助手 — 终端 + 桌面双端智能编程代理，支持 DeepSeek / OpenAI / Anthropic / Ollama 等多模型。**
> 作者：Red · 基于 [opencode](https://github.com/anomalyco/opencode) (sst.dev) 二次开发。

[![TUI](https://img.shields.io/badge/TUI-0.3.17-blue)](CHANGELOG.md)
[![Desktop](https://img.shields.io/badge/Desktop-0.3.17-0078d4)](CHANGELOG.md)
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
- 🔌 **多模型支持**：DeepSeek、MiMo、OpenAI、Anthropic、Google Gemini、Ollama 本地模型等
- 🛠 **工具系统**：文件读写、代码搜索、终端命令、Web 搜索
- 🤖 **智能 Agent**：Build、Plan、General、Explore 等内置 Agent，支持自定义
- 📝 **会话管理**：历史对话保存、恢复、分支（fork）
- 🎨 **终端 UI**：语法高亮、流式输出、文件差异展示
- 🖥 **桌面 GUI**：Electron 独立窗口，完整图形界面
- 📊 **MCP 服务器**：
  - [CodeGraph](https://github.com/colbymchenry/codegraph) — 代码知识图谱，符号/调用链/影响分析
  - [TypeGraph](https://github.com/guyowen/typegraph-mcp) — TypeScript 语义导航（类型解析、barrel 文件穿透、循环依赖检测）
  - [jCodeMunch](https://github.com/colbymchenry/jcodemunch) — 结构化代码检索（60+ 工具：符号获取、死代码检测、AST 匹配）
  - [Browser MCP](https://github.com/colbymchenry/browsermcp) — 浏览器自动化（导航、截图、点击、输入、获取页面内容）
- 🔒 **权限系统**：工具调用前确认，支持自动批准
- 🌍 **多语言**：中文、英文、日文等 18 种语言
- 🗣 **TTS 朗读**：MiMo TTS 语音朗读 AI 回复

---

## 🖥 桌面 GUI 新特性

- **三栏布局**：文件树（左）+ 聊天窗口（中）+ 审查面板（右），可独立拖拽调整宽度
- **V2 Titlebar**：Tab 式会话管理，StatusPopover 显示 token 用量，`Cmd+T` / `Cmd+Shift+T` 切换会话
- **项目快捷键**：`Cmd+1` ~ `Cmd+9` 快速切换项目
- **语义色分层**：`theme.colors` 按 text/surface/border/status/diff/markdown/syntax 8 组分群，主题可定制
- **ECC 插件集成**：自动跟踪文件变更、上下文压缩优化、安全操作自动放行
- **版本号自动注入**：构建时从 `package.json` 自动注入标题栏版本号，杜绝手动遗漏
- **思考中仓鼠动画**：AI 思考时显示 🐹 小跑动画 + Mona 猫猫 loading
- **设计系统**：CSS 设计 token（圆角、阴影、排版）、文字排版优化（`text-wrap: balance/pretty`）

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
| `~/.redcode/redcode.jsonc` | 全局配置（跨项目共享） |
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
    },
    "jcodemunch": {
      "type": "local",
      "command": ["npx", "jcodemunch-mcp"],
      "enabled": true
    }
  }
}
```

---

## 🛠 技术栈

| 层 | 技术 |
|----|------|
| 运行时 | Bun |
| 语言 | TypeScript |
| 终端 UI | SolidJS (OpenTUI) |
| 桌面 GUI | Electron + SolidJS |
| AI SDK | Vercel AI SDK |
| 数据库 | SQLite (Drizzle ORM) |
| 构建 | Turborepo (monorepo) |
| MCP | CodeGraph + TypeGraph + jCodeMunch + Browser MCP |

---

## 📋 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

---

## 💙 致谢

- 原项目：[opencode](https://github.com/anomalyco/opencode)（sst.dev）
- 许可证：MIT
