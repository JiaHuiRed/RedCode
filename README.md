# ⚡ RedCode

<p align="center">
  <img src="packages/app/public/mona-loading.gif" width="80">
</p>

> 个人 AI 编程搭档 — 终端 `敏敏` + 桌面 `小宋`，双端同芯。  
> 基于 [opencode](https://github.com/anomalyco/opencode)（sst.dev）深度二次开发，由 Red 维护。

[![TUI](https://img.shields.io/badge/TUI-0.4.2-blue)](CHANGELOG.md)
[![Desktop](https://img.shields.io/badge/Desktop-0.4.2-0078d4)](CHANGELOG.md)
[![平台](https://img.shields.io/badge/平台-Windows%2010%2F11-0078d4)](https://github.com/JiaHuiRed/RedCode)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6)](https://typescriptlang.org)
[![Bun](https://img.shields.io/badge/Bun-1.3.x-fcf2d0)](https://bun.sh)
[![许可证](https://img.shields.io/badge/许可证-MIT-lightgrey)](LICENSE)

---

## ✨ 这是什么？

一个人用的 AI 编程助手。两个入口、同一能力：

- **敏敏（柳智敏）** — TUI 命令行界面，轻量快速，`packages/opencode`
- **小宋（宋雨琦）** — 桌面 GUI 窗口，Electron + SolidJS，`packages/desktop`

读代码、写代码、查 bug、跑命令。你说中文，她俩干活。

---

## 🧩 核心能力

| 能力 | 说明 |
|------|------|
| **代码理解** | CodeGraph（知识图谱）、TypeGraph（TS 语义导航）、jCodeMunch（60+ 检索工具）|
| **多模型** | DeepSeek / MiMo / OpenAI / Anthropic / Gemini / Ollama 本地模型 |
| **文件操作** | 读写、编辑、搜索、全局替换 |
| **终端执行** | 交互式命令运行，实时输出 |
| **Web 搜索** | DuckDuckGo + Yahoo 兜底，无 API Key |
| **浏览器自动化** | Browser MCP — 导航、截图、点击、表单填写 |
| **视觉分析** | Qwen3-VL 本地识图（OCR / 截图分析 / UI 对比），DeepSeek 不支持的自动切 vision MCP |
| **会话管理** | 历史保存、恢复、分支续聊 |
| **权限门控** | 三档 guardrail（minimal / standard / strict），大操作先确认 |
| **上下文压缩** | DCP 插件 — 自动裁剪旧对话、去重、截长输出 |
| **记忆系统** | 启动注入历史教训、收工自动提取、日志自动写入 |
| **目标钉住** | `/goal` 锁定会话方向，不跑题 |
| **自定义 Agent** | `Tsoul.md` / `Gsoul.md` 人格源，skill 技能文件，低代码扩展 |

### MCP 生态

| 服务器 | 用途 |
|--------|------|
| [CodeGraph](https://github.com/colbymchenry/codegraph) | 代码知识图谱：符号/调用链/影响分析 |
| [TypeGraph](https://github.com/guyowen/typegraph-mcp) | TypeScript 语义导航：类型解析/barrel 穿透/循环依赖 |
| [jCodeMunch](https://github.com/colbymchenry/jcodemunch) | 结构化代码检索：死代码/AST 匹配/编辑安全预检 |
| [Browser MCP](https://github.com/colbymchenry/browsermcp) | 浏览器自动化 |
| [Vision MCP](https://github.com/Loveacup/vision-mcp-server) | 多模态视觉分析（Ollama Qwen3-VL） |
| Web Search | 网页搜索（内置） |

---

## 🖥 桌面 GUI 概览

- **三栏布局**：文件树 | 聊天 | 审查面板，宽度可拖拽
- **V2 Titlebar**：Tab 会话管理、StatusPopover token 用量
- **视觉识别**：AI 思考时 Mona 猫猫 loading + 仓鼠动画
- **语义主题**：8 组色彩 token，深色/浅色主题
- **版本自动注入**：构建时从 package.json 注入

---

## 🚀 运行（源码）

```bash
git clone https://github.com/JiaHuiRed/RedCode.git
cd RedCode
bun install

# 构建 MCP 索引（首次需要）
npx -y @colbymchenry/codegraph index

# 启动 TUI（敏敏）
bun dev

# 或启动桌面 GUI（小宋）
cd packages/desktop && bun run dev
```

### 编译

```bash
# 编译 TUI 单文件 exe
cd packages/opencode && bun run build -- --single

# 编译桌面 GUI
cd packages/desktop && bun run build && bun run package
```

---

## ⚙️ 配置

| 文件 | 用途 |
|------|------|
| `~/.redcode/redcode.jsonc` | 全局配置（provider / MCP / 权限） |
| `项目根/redcode.jsonc` | 项目级配置 + instructions（skill 注册） |
| `~/.redcode/MEMORY.md` | 长期记忆：工作纪律、教训、偏好 |
| `~/.redcode/USER.md` | 用户画像 |
| `.opencode/skill/*/SKILL.md` | 技能文件（自动加载到指令） |
| `.opencode/agents/Tsoul.md` | 敏敏人格源 |
| `.opencode/agents/Gsoul.md` | 小宋人格源 |

### 添加模型 Provider

```jsonc
{
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
| 视觉 | Ollama + Qwen3-VL |
| 搜索 | DuckDuckGo / Yahoo |

---

## 📋 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

---

## 💙 致谢

- 原项目：[opencode](https://github.com/anomalyco/opencode)（sst.dev）
- 许可证：MIT
