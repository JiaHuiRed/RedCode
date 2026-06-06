# ⚡ RedCode

<p align="center">
  <img src="packages/app/public/mona-loading.gif" width="80">
</p>

> 开源 AI 编程助手 — 终端 TUI + 桌面 GUI 双端，同一能力。
> 基于 [opencode](https://github.com/anomalyco/opencode)（sst.dev）深度二次开发。

[![TUI](https://img.shields.io/badge/TUI-0.4.2-blue)](CHANGELOG.md)
[![Desktop](https://img.shields.io/badge/Desktop-0.4.2-0078d4)](CHANGELOG.md)
[![平台](https://img.shields.io/badge/平台-Windows%2010%2F11-0078d4)](https://github.com/JiaHuiRed/RedCode)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6)](https://typescriptlang.org)
[![Bun](https://img.shields.io/badge/Bun-1.3.x-fcf2d0)](https://bun.sh)
[![许可证](https://img.shields.io/badge/许可证-MIT-lightgrey)](LICENSE)

---

## ✨ 这是什么？

开源 AI 编程助手。两个入口、同一能力：

- **TUI** — 终端命令行界面，轻量快速（`packages/opencode`）
- **GUI** — 桌面窗口程序，Electron + SolidJS（`packages/desktop`）

读代码、写代码、改 bug、跑命令。你说中文，它干活。

### 核心能力一览

| 能力 | 说明 |
|------|------|
| **代码理解** | CodeGraph（知识图谱）、TypeGraph（TS 语义导航）、jCodeMunch（60+ 检索工具） |
| **多模型** | DeepSeek / OpenAI / Anthropic / Gemini / Ollama（本地模型）|
| **文件操作** | 读写、编辑、搜索、全局替换 |
| **终端执行** | 交互式命令运行，实时输出 |
| **Web 搜索** | DuckDuckGo + Yahoo 兜底，内置 MCP 服务，零 API Key |
| **浏览器自动化** | 导航、截图、点击、表单填写 |
| **视觉分析** | Qwen3-VL 本地识图，自动切 vision MCP |
| **会话管理** | 历史保存、恢复、分支续聊 |
| **权限门控** | 三档 guardrail（minimal / standard / strict），大操作先确认 |
| **上下文压缩** | 自动裁剪旧对话、去重、截长输出 |
| **记忆系统** | 启动注入历史教训、收工自动提取、日志自动写入 |
| **目标钉住** | `/goal` 锁定会话方向，不跑题 |
| **自定义 Agent** | 灵魂文件（人格） + skill 技能文件，低代码扩展 |

---

## 🚀 快速开始

前置要求：[Bun](https://bun.sh) 1.3+。

```bash
# 克隆
git clone https://github.com/JiaHuiRed/RedCode.git
cd RedCode

# 安装依赖
bun install

# 构建代码索引（首次需要，让 AI 理解你的代码库）
npx -y @colbymchenry/codegraph index

# 启动 TUI（终端界面）
bun dev

# 或启动桌面 GUI
cd packages/desktop && bun run dev
```

> **第一次启动时，系统会自动创建 `~/.redcode/` 目录并播种默认模板文件。**
> 你不需要手动做任何配置就能开始使用。

### 编译打包

```bash
# 编译 TUI 单文件 exe
cd packages/opencode && bun run build -- --single

# 编译桌面 GUI
cd packages/desktop && bun run build && bun run package
```

---

## 🎭 首次设置：配置你的 AI 搭档

RedCode 的灵魂、记忆、用户画像都是**你个人定制**的。仓库提供模板，启动时自动播种。

### 第一步：创建用户画像

告诉 AI 你是谁：

```bash
# 如果 ~/.redcode/USER.md 不存在，系统已自动从模板创建
# 直接编辑它：
$EDITOR ~/.redcode/USER.md
```

填写你的称呼、身份、语言偏好和工作习惯。AI 会在每次对话开始时读取这份文件。

### 第二步：自定义人格（灵魂文件）

灵魂文件定义了 AI 的性格、语气和边界。TUI 和 GUI 可以有不同的灵魂：

| 文件 | 对应界面 |
|------|---------|
| `~/.redcode/souls/Tsoul.md` | TUI 终端人格 |
| `~/.redcode/souls/Gsoul.md` | GUI 桌面人格 |

编辑它们，填入你想要的：

- AI 叫什么名字、什么身份？
- 怎么称呼你、语气怎么样？
- 重点帮你做什么？
- 不该碰什么话题？

### 第三步：建立工作记忆

`~/.redcode/MEMORY.md` 存放你的长期工作记忆，记录：

- 写作规范和代码风格
- 工作纪律和红线（什么操作需要先确认）
- 技术决策和踩坑笔记
- 从每日日志提炼的关键教训

AI 会在每次启动时自动读取记忆，不需要你手动提示。

### 第四步：加载人格

```bash
# 在 TUI 中加载终端人格
/tui-persona

# 在 TUI 中加载桌面人格（即使你在 TUI 里也能加载 GUI 人格）
/gui-persona
```

---

## 🧠 记忆系统（自动运作）

RedCode 内置自动化记忆系统（`memory-automation` skill），无需你手动维护。

### 每日日志

AI 在工作中发现错误被纠正、或走了弯路时，**自动写入一句到当天日志**：

```
~/.redcode/memory/260606.md
```

### 长期库

收工或 `/goal done` 时，AI 自动从当日日志中摘出**关键且需长期警惕**的教训，去重合入 `~/.redcode/MEMORY.md`。定期复审会清理过时条目。

### 启动注入

每次新对话启动时，AI 自动读取：
1. 最近 3 天日志 → 摘出关键教训
2. `~/.redcode/MEMORY.md` → 工作纪律和偏好
3. `~/.redcode/USER.md` → 你的画像

不需要你在对话里说"记住我之前的教训"。

---

## 🔌 MCP 服务器配置

MCP（Model Context Protocol）是 AI 获取外部能力的通道。RedCode 内置 4 个 + 可选 2 个。

### 内置（项目 `redcode.jsonc` 已配好，开箱即用）

| 服务器 | 用途 | 命令 |
|--------|------|------|
| **CodeGraph** | 代码知识图谱：符号定义、调用链、影响分析 | `npx @colbymchenry/codegraph serve --mcp` |
| **TypeGraph** | TypeScript 语义导航：类型解析、barrel 穿透、循环依赖检测 | `npx tsx ./plugins/typegraph-mcp/server.ts` |
| **jCodeMunch** | 结构化代码检索：死代码检测、AST 匹配、编辑安全预检 | `jcodemunch-mcp` |
| **Web Search** | 网页搜索：DuckDuckGo + Yahoo 兜底，零 API Key | `npx tsx ./.opencode/search-server/index.ts` |

### 可选（需额外安装）

#### Browser MCP — 浏览器自动化

让 AI 能操作浏览器（导航、截图、点击、填表）：

```bash
# 安装
git clone https://github.com/colbymchenry/browsermcp.git .opencode/browsermcp-server
cd .opencode/browsermcp-server
npm install
```

在 `redcode.jsonc` 中启用：

```jsonc
"browsermcp": {
  "type": "local",
  "command": ["node", "./browsermcp-server/index.js"],
  "enabled": true
}
```

#### Vision MCP — 多模态视觉分析

让 DeepSeek 等不支持图片的模型也能分析截图和图片（需安装 [Ollama](https://ollama.com)）：

```bash
# 安装 Ollama 并下载视觉模型
ollama pull qwen3-vl:8b

# 克隆 vision MCP server
git clone https://github.com/Loveacup/vision-mcp-server.git ../vision-mcp-server
cd ../vision-mcp-server
npm install
```

完成后在 `redcode.jsonc` 中把 vision 的 `enabled` 改为 `true`。

### 首次索引

代码理解类 MCP 需要先建立索引：

```bash
# CodeGraph 索引（覆盖整个项目）
npx -y @colbymchenry/codegraph index

# jCodeMunch 索引（可选，提供更精确的代码搜索）
jcodemunch-mcp index
```

---

## ⚙️ 配置指南

### 配置文件层次

| 文件 | 用途 | 谁创建 |
|------|------|--------|
| `~/.redcode/redcode.jsonc` | **全局配置**：provider、MCP、权限、instructions | 自动生成（从模板）|
| `项目根/redcode.jsonc` | **项目级配置**：覆盖全局 | 在项目中手动编辑 |
| `~/.redcode/MEMORY.md` | 长期记忆（自动写入） | 启动时自动播种 |
| `~/.redcode/USER.md` | 用户画像 | 启动时自动播种（从模板）|
| `~/.redcode/souls/Tsoul.md` | TUI 人格 | 启动时自动播种（从模板）|
| `~/.redcode/souls/Gsoul.md` | GUI 人格 | 启动时自动播种（从模板）|
| `~/.redcode/memory/` | 每日日志 | 运行时自动创建 |

> 全局配置 `~/.redcode/redcode.jsonc` 对所有项目生效。
> 项目根 `redcode.jsonc` 只对当前项目生效，且优先级更高。

### 配置模型 Provider

```jsonc
{
  "provider": {
    "my-deepseek": {
      "type": "openai",         // 兼容 OpenAI API 格式
      "apiKey": "sk-xxx",
      "baseURL": "https://api.deepseek.com/v1"
    },
    "my-ollama": {
      "type": "openai",
      "apiKey": "ollama",       // Ollama 不需要真实 key
      "baseURL": "http://localhost:11434/v1"
    },
    "my-claude": {
      "type": "anthropic",      // Anthropic 原生格式
      "apiKey": "sk-ant-xxx"
    }
  },
  "model": "my-deepseek/deepseek-chat"  // 默认模型
}
```

### 权限门控

通过环境变量 `ECC_PROFILE` 控制严格程度：

| 行为 | minimal | standard（默认） | strict |
|------|---------|-----------------|--------|
| 文件搜索/读取 | ✅ 直接放行 | ✅ 直接放行 | ✅ 直接放行 |
| 单文件编辑 | ✅ 直接放行 | ✅ 直接放行 | ❓ 先确认 |
| 跨文件编辑 | ✅ 直接放行 | ❓ 先确认 | ❓ 先确认 |
| Shell 命令 | ✅ 直接放行 | ❓ 白名单放行 | ❓ 逐个确认 |
| 不可逆操作 | ❓ 必须确认 | ❓ 必须确认 | ❓ 必须确认 |

```bash
# Windows
$env:ECC_PROFILE="minimal"

# macOS / Linux
export ECC_PROFILE=strict
```

---

## 📋 内置命令

| 命令 | 作用 |
|------|------|
| `/goal <目标>` | 钉住会话目标，防止跑题 |
| `/goal clear` | 清掉当前目标 |
| `/goal done` | 标记目标完成，自动归档 |
| `/tui-persona` | 加载 TUI 终端人格 |
| `/gui-persona` | 加载 GUI 桌面人格 |
| `/commit` | 按 conventional commit 格式提交 |
| `/changelog` | 生成 CHANGELOG 条目 |
| `/issues` | 查看/创建 GitHub issues |

命令文件在 `.opencode/command/` 和 `~/.redcode/command/` 中，你可以自己添加。

---

## 🧩 Skill 技能系统

Skill 是 RedCode 的扩展机制——告诉 AI 在特定场景下如何行事。仓库内置：

| Skill | 作用 |
|-------|------|
| **memory-automation** | 自动记忆系统：日志写入、长期库提取、启动注入 |
| **guardrail-profiles** | 三档权限控制：minimal / standard / strict |
| **defensive-agent** | AI 防御性设计：假阳性过滤、confidence gate、预编辑调查 |
| **goal-automation** | 检测大任务并建议使用 `/goal` |
| **vision-autoagent** | 自动调用 vision MCP 分析图片 |
| **simplify** | 检测过度工程并建议简化 |

### 添加自定义 Skill

新建 `.opencode/skill/<name>/SKILL.md`，格式不限，内容是给 AI 的指令。然后在 `redcode.jsonc` 中注册：

```jsonc
"instructions": [
  "./.opencode/skill/your-skill/SKILL.md"
]
```

Skill 文件支持 markdown，可以包含代码示例、规则列表、流程图等。

---

## 🔒 隐私与多机同步

### 隐私模型

```
仓库（公开）               用户目录（私有）
├── .opencode/              ~/.redcode/
│   ├── agents/             ├── souls/       ← 你的人格
│   │   ├── Tsoul.md  ← 模板 ├── Tsoul.md   ← 你的版本
│   │   └── Gsoul.md   ← 模板 ├── Gsoul.md   ← 你的版本
│   ├── skill/              ├── MEMORY.md    ← 你的记忆
│   ├── command/            ├── USER.md      ← 你的画像
│   └── MEMORY.md     ← 模板 └── memory/      ← 你的日志
```

- 仓库**只包含模板和技能**，没有你的个人数据
- `~/.redcode/` **不在仓库中**，不会被推送或分享
- 克隆此项目的其他人只会看到空白模板

### 多台电脑同步

如果你在多地工作（家里 + 公司），建议建一个**私有仓库**同步 `~/.redcode/`：

```bash
# 第一次：创建私有仓
cd ~/.redcode
echo "sessions/\nnode_modules/\n" > .gitignore
git init && git add -A && git commit -m "init"
# 在 GitHub 创建 private repo
git remote add origin https://github.com/you/redcode-private.git
git push -u origin main

# 另一台电脑上
cd ~
git clone https://github.com/you/redcode-private.git .redcode
git clone https://github.com/JiaHuiRed/RedCode.git
```

日常更新：

```bash
# 家里：改完推送
cd RedCode && git push
cd ~/.redcode && git push

# 公司：拉取
cd RedCode && git pull
cd ~/.redcode && git pull
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
| 搜索 | DuckDuckGo / Yahoo / Google |

---

## 📋 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

---

## 💙 致谢

- 原项目：[opencode](https://github.com/anomalyco/opencode)（sst.dev）
- 许可证：MIT
