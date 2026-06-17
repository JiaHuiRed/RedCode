# ⚡ RedCode

<p align="center">
  <img src="packages/app/public/mona-loading.gif" width="80">
</p>

> **中文母语的桌面 AI 编程助手。** 独立窗口、说中文、接你喜欢的模型（DeepSeek / MiMo / 国产优先）。
> _A Chinese-native desktop AI coding agent — standalone GUI, speaks your language, plug in any model._
>
> 基于 [opencode](https://github.com/anomalyco/opencode)（sst.dev）深度二次开发。

[![TUI](https://badgen.net/badge/TUI/0.6.11/blue)](CHANGELOG.md)
[![Desktop](https://badgen.net/badge/Desktop/0.6.6/0078d4)](CHANGELOG.md)
[![平台](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%2010%2F11-0078d4)](https://github.com/JiaHuiRed/RedCode)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6)](https://typescriptlang.org)
[![Bun](https://img.shields.io/badge/Bun-1.3.x-fcf2d0)](https://bun.sh)
[![许可证](https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-MIT-lightgrey)](LICENSE)

---

## ✨ 这是什么？

AI 编程助手。两个入口、同一能力：

- **TUI** — 终端命令行界面（`packages/opencode`）
- **GUI** — 桌面窗口程序，Electron + SolidJS（`packages/desktop`）

读代码、写代码、改 bug、跑命令。你说中文，它干活。

### 核心能力

代码理解（TypeGraph / jCodeMunch）· 多模型（DeepSeek / OpenAI / Anthropic / Ollama）· 文件读写编辑 · 终端执行 · Web 搜索 · 浏览器自动化 · 视觉分析 · 会话管理 · 权限门控 · 上下文压缩 · 自动化记忆系统 · 目标管理 · 自定义 AI 人格

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
cd packages/opencode && bun run build -- --single

# 桌面 GUI
cd packages/desktop && bun run build && bun run package
```

---

## 📖 用户手册

全部操作指南在 **[MANUAL.md](MANUAL.md)**，涵盖：

1. 首次设置（配置模型 / AI 人格 / 用户画像 / 工作记忆）
2. 记忆系统（自动日志 / 长期库 / 启动注入）
3. MCP 服务器（预配置服务的安装与启用）
4. 配置详解（provider / 权限 / 项目级配置）
5. 内置命令列表
6. Skill 技能系统说明
7. 隐私模型与多机同步方案

---

## 📋 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

---

## 💙 致谢

- 原项目：[opencode](https://github.com/anomalyco/opencode)（sst.dev）
- 许可证：MIT
