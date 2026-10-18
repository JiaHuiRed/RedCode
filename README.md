# ⚡ RedCode

**RedCode 是一个支持多模型的 AI 编程 Agent，提供终端（TUI）与桌面（GUI）两种使用方式。**

它可以理解和修改代码、执行命令、调用开发工具，并通过自然语言与你协作完成实际开发任务。

基于 [OpenCode](https://github.com/anomalyco/opencode) 深度开发，面向中文使用习惯与个性化工作流持续优化。

[![版本](https://badgen.net/badge/版本/0.12.14/blue)](CHANGELOG.md)
[![平台](https://badgen.net/badge/平台/Windows%2010%2F11/green)](https://github.com/JiaHuiRed/RedCode)
[![TypeScript](https://badgen.net/badge/TypeScript/7.x/3178c6)](https://typescriptlang.org)
[![Bun](https://badgen.net/badge/Bun/1.3.x/fb6e19)](https://bun.sh)
[![许可证](https://badgen.net/badge/许可证/MIT/grey)](LICENSE)

<p align="center">
  <img src="docs/assets/chi-portrait.webp" height="300" alt="RedCode 看板娘「赤」">
</p>

<p align="center">
  <img src="docs/assets/screenshot.png" width="760" alt="RedCode TUI 界面">
</p>

## ❤️ Why RedCode?

**自由选择模型。** 接入不同供应商的 Coding Plan、兼容 API 或本地模型，根据任务选择适合的模型，而不受限于单一服务。

**让 AI 真正参与开发。** 文件编辑、终端执行、代码检索、MCP 工具和子代理共同组成完整的开发工作流。

**适合长期协作。** 通过会话管理、上下文压缩、前缀缓存管理和记忆系统，支持持续推进复杂任务。

**让每个 Token 更有价值。** 针对不同模型与服务商优化提示词前缀、缓存复用和上下文管理，减少重复开销，让长任务运行得更稳定、更经济。

**不只是一个没有个性的工具。** Soul 系统允许自定义 AI 伙伴的身份与交互风格，并在 TUI 和 GUI 中保持会话人格一致。

**把控制权留给使用者。** Plan、RedMind、Auto 三种权限模式，按任务需要控制 AI 的执行范围。

## 🚀 快速开始

需要 Windows 10/11、Git 和 Bun 1.3+。

```bash
git clone https://github.com/JiaHuiRed/RedCode.git
cd RedCode
bun install

# 终端
bun dev

# 桌面
bun run dev:desktop
```

首次启动后，配置你使用的模型供应商即可开始工作。

更多安装、模型接入、权限与 Soul 配置说明见 [MANUAL.md](MANUAL.md)。

## 📖 文档

- [用户手册](MANUAL.md) — 安装、配置与使用方法
- [更新日志](CHANGELOG.md) — 版本变化与修复记录

## 💙 致谢

RedCode 基于 [OpenCode](https://github.com/anomalyco/opencode) 开发，感谢原项目及相关开源社区的贡献。

本项目采用 [MIT License](LICENSE)。
