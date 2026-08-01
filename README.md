# ⚡ RedCode

<p align="center">
  <img src="docs/assets/screenshot.png" width="720" alt="RedCode TUI 截图" style="border-radius: 8px;">
</p>

> **中文母语的 AI 编程助手。** 终端（TUI）或桌面（GUI），说中文，插你喜欢的模型——DeepSeek、OpenAI、Anthropic、Ollama，国产优先。
>
> 基于 [opencode](https://github.com/anomalyco/opencode)（sst.dev）深度二次开发，侧重**前缀缓存优化、多模型适配、中文体验和稳定性**。

[![TUI](https://badgen.net/badge/TUI/0.8.6/blue)](CHANGELOG.md)
[![Desktop](https://badgen.net/badge/Desktop/0.7.12/purple)](CHANGELOG.md)
[![平台](https://badgen.net/badge/平台/Windows%2010%2F11/green)](https://github.com/JiaHuiRed/RedCode)
[![TypeScript](https://badgen.net/badge/TypeScript/5.x/3178c6)](https://typescriptlang.org)
[![Bun](https://badgen.net/badge/Bun/1.3.x/fb6e19)](https://bun.sh)
[![许可证](https://badgen.net/badge/许可证/MIT/grey)](LICENSE)

---

## ✨ 这是什么？

AI 编程助手。两个入口、同一引擎：

- **TUI** — 终端命令行界面（`packages/opencode`）
- **GUI** — 桌面窗口程序，Electron（`packages/desktop`；Tauri 迁移进行中，尚未可构建）

读代码、写代码、改 bug、跑命令。你说中文，它干活。

### 核心能力

代码理解（jCodeMunch / TypeGraph）· 多模型（DeepSeek / OpenAI / Anthropic / Ollama）· 文件读写编辑 · 终端执行 · Web 搜索 · 视觉分析 · 会话管理 · 权限门控与防护环（guardrail/doom_loop 检测）· 上下文压缩 · 自动化记忆系统 · 目标管理 · Skill 技能系统 · 防重复循环检测 · 自定义 AI 人格

### 为什么是 RedCode？

| 对比上游 OpenCode | RedCode |
|---|---|
| 缓存命中率 | **97%+**（多层 prefix cache 保鲜：msgPin → modelMsgs cache → tools cache → system cache） |
| 模型计价 | 支持 DeepSeek cache 计价阶梯（cache miss/write/hit 独立计费），修复上游 `cacheReadInputTokens` 为 0 的计价漏报 |
| 中文体验 | 完整中文文档、中文 UI、中英文双语 README |
| 稳定性 | Event Loop 阻塞探测、sidecar 心跳独立监控、DCP 压缩后桶压避免双重 compaction |
| 国产模型优先 | 零配置支持 DeepSeek、GLM、Qwen、MiniMax、Zhipu，以及 NVIDIA 等第三方托管 |

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

> TUI 编译产物：`packages/opencode/dist/redcode-windows-x64/bin/redcode.exe`，可直接双击运行——无参数启动会先显示工作区选择器，支持从已注册项目中选择，或经"Open a different directory..."手输/粘贴任意目录路径（0.7.31 起）。

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
- 代码检索能力由 [jcodemunch-mcp](https://github.com/jgravelle/jcodemunch-mcp) 提供驱动
- 许可证：MIT
