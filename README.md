# ⚡ RedCode

<p align="center">
  <img src="packages/web/src/assets/lander/mona-loading.gif" width="80">
</p>
<pre align="center">
█████ █████ █████ █████ █████ █████ █████
█   █ █     █  ██ █     █   █ █  ██ █    
████  █████ █   █ █     █   █ █   █ █████
█  ██ █     █   █ █     █   █ █   █ █    
█   █ █████ █████ █████ █████ █████ █████
</pre>

> **开源 AI 编程助手 — 基于终端的智能编程代理，支持 DeepSeek / OpenAI / Anthropic / Ollama 等多模型。**
> 作者：Red · 基于 [opencode](https://github.com/anomalyco/opencode) (sst.dev) 二次开发。

[![TUI](https://img.shields.io/badge/TUI-0.3.1-blue)](CHANGELOG.md)
[![Desktop](https://img.shields.io/badge/Desktop-0.3.3-0078d4)](CHANGELOG.md)
[![平台](https://img.shields.io/badge/平台-Windows%2011-0078d4)](https://github.com/JiaHuiRed/RedCode)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6)](https://typescriptlang.org)
[![Bun](https://img.shields.io/badge/Bun-1.3.x-fcf2d0)](https://bun.sh)
[![AI支持](https://img.shields.io/badge/AI-DeepSeek%20%7C%20OpenAI%20%7C%20Anthropic%20%7C%20Ollama-ff6b35)](https://ollama.com)
[![许可证](https://img.shields.io/badge/许可证-MIT-lightgrey)](LICENSE)

---

## ✨ 这是什么？

基于终端的 AI 编程助手（Coding Agent）。能读取代码库、执行命令、编辑文件、搜索代码，通过自然语言对话完成编程任务。

---

## 🧩 核心功能

- 💬 **自然语言编程**：用中文描述需求，自动完成代码编写、重构、调试
- 🔌 **多模型支持**：DeepSeek、OpenAI、Anthropic、Google Gemini、Ollama 本地模型等
- 🛠 **工具系统**：文件读写、代码搜索、终端命令、Web 搜索、MCP 服务器
- 🤖 **自定义 Agent**：内置 Build、Plan、General 等 Agent，支持自定义
- 📝 **会话管理**：历史对话保存、恢复
- 🎨 **终端 UI**：语法高亮、流式输出、文件差异展示
- 🖥 **桌面端**：Electron 独立窗口（免安装版 `dist/win-unpacked`）

---

## 🚀 运行（源码方式）

```bash
git clone https://github.com/JiaHuiRed/RedCode.git
cd RedCode
bun install
bun dev
```

---

## ⚙️ 配置说明

配置文件：`~/.config/redcode/config.json`

### 添加自定义 Provider

```json
{
  "provider": {
    "my-provider": {
      "type": "openai",
      "apiKey": "sk-xxx",
      "baseURL": "https://api.example.com/v1"
    }
  },
  "model": {
    "my-model": {
      "provider": "my-provider",
      "model": "gpt-4o"
    }
  }
}
```

所有 OpenAI 兼容服务均可通过此方式接入。

---

## 🛠 技术栈

| 层 | 技术 |
|----|------|
| 运行时 | Bun |
| 语言 | TypeScript |
| 终端 UI | Ink (React for CLI) |
| AI SDK | Vercel AI SDK |
| 数据库 | SQLite (Drizzle ORM) |
| 桌面 | Electron |
| 构建 | Turborepo (monorepo) |

---

## 📋 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

---

## 💙 致谢

- 原项目：[opencode](https://github.com/anomalyco/opencode)（sst.dev）
- 许可证：MIT
