# RedCode 用户手册

> 从克隆到精通，一步步配置和使用 RedCode 的全部功能。

---

## 目录

1. [快速启动](#1-快速启动)
2. [首次设置](#2-首次设置)
3. [配置模型](#3-配置模型)
4. [MCP 服务器](#4-mcp-服务器)
5. [AI 人格系统](#5-ai-人格系统)
6. [记忆系统](#6-记忆系统)
7. [配置详解](#7-配置详解)
8. [内置命令](#8-内置命令)
9. [Skill 技能系统](#9-skill-技能系统)
10. [隐私与多机同步](#10-隐私与多机同步)

---

## 1. 快速启动

### 前置要求

- [Bun](https://bun.sh) 1.3+
- Windows 10/11（仅测试此平台，其他平台需自行适配）
- Git

### 克隆并运行

```bash
git clone https://github.com/JiaHuiRed/RedCode.git
cd RedCode
bun install

# 启动 TUI（终端界面）
bun dev

# 或启动桌面 GUI
cd packages/desktop && bun run dev
```

### 编译打包

> 嫌敲命令麻烦？直接双击两个一键 bat 即可：
> TUI → `packages/opencode/build.bat`；桌面 GUI → `packages/desktop/build-and-package.bat`。

```bash
# TUI 单文件 exe（可在无 Bun 环境的机器运行）
cd packages/opencode && bun run build -- --single

# 桌面 GUI
cd packages/desktop && bun run build && bun run package
```

### 启动后发生了什么

第一次启动时，系统自动：

1. 创建 `~/.redcode/` 目录（存放全局配置和记忆）
2. 创建 `~/.redcode/memory/` 和 `~/.redcode/souls/`
3. 从项目模板文件播种到上述目录（如果目标不存在）
4. 加载所有 MCP 服务器和 skill 技能
5. 启动 TUI/GUI 界面

**你已经可以开始聊天了。** 但要想发挥全部能力，继续往下看。

---

## 2. 首次设置

### 2.1 添加 AI 模型

RedCode 支持多种模型。首次启动后，你需要至少配置一个 provider 才能对话。

在 `~/.redcode/redcode.jsonc`（全局）或项目下的 `redcode.jsonc`（项目级）中添加：

```jsonc
{
  "provider": {
    "deepseek": {
      "type": "openai",
      "apiKey": "sk-xxxxxxxx",
      "baseURL": "https://api.deepseek.com/v1"
    }
  },
  "model": "deepseek/deepseek-chat"
}
```

支持的 provider type：`openai`（兼容 OpenAI 格式）、`anthropic`、`google`、`ollama` 等。

参考配置示例：

```jsonc
{
  "provider": {
    "my-openai": {
      "type": "openai",
      "apiKey": "sk-xxx"
    },
    "my-ollama": {
      "type": "openai",
      "apiKey": "ollama",
      "baseURL": "http://localhost:11434/v1"
    }
  },
  "model": "my-openai/gpt-4o"
}
```

### 2.2 创建用户画像

告诉 AI 你的基本信息和偏好：

```bash
$EDITOR ~/.redcode/USER.md
```

参考内容：

```markdown
# 关于我

- 称呼：叫我 Xiao
- 语言：中文（简体）
- 我是后端开发者，主要用 Go 和 TypeScript
- 偏好简洁的回答，先给结论
```

AI 每次启动对话时自动读取此文件。

### 2.3 自定义 AI 人格

灵魂文件定义 AI 的性格、语气和行为边界。TUI 和 GUI 可以有不同的灵魂：

```bash
$EDITOR ~/.redcode/souls/Tsoul.md   # TUI 终端人格
$EDITOR ~/.redcode/souls/Gsoul.md   # GUI 桌面人格
```

灵魂文件内容自由格式，但建议包括：

- AI 的身份和名字
- 怎么称呼你
- 语气风格（简洁/详细、正式/随意）
- 重点帮你做什么
- 不该碰的话题

写好之后，在对话中输入 `/tui-persona` 加载 TUI 人格，或 `/gui-persona` 加载 GUI 人格。

---

## 3. 配置模型

### 3.1 Provider 类型

| type | API 格式 | 适用 |
|------|---------|------|
| `openai` | OpenAI 兼容 | DeepSeek、Moonshot、Ollama、Groq 等 |
| `anthropic` | Anthropic 原生 | Claude |
| `google` | Gemini 原生 | Google Gemini |

### 3.2 切换模型

对话时点击模型选择器切换，或在 `redcode.jsonc` 中设置默认模型：

```jsonc
"model": "my-provider/my-model"
```

### 3.3 本地模型（Ollama）

```bash
# 安装 Ollama
# 下载模型
ollama pull qwen2.5-coder:7b

# 在 redcode.jsonc 中配置
{
  "provider": {
    "local": {
      "type": "openai",
      "apiKey": "ollama",
      "baseURL": "http://localhost:11434/v1"
    }
  },
  "model": "local/qwen2.5-coder:7b"
}
```

---

## 4. MCP 服务器

MCP（Model Context Protocol）让 AI 获得外部能力。安装越多 MCP，AI 能做到的事越多。

以下所有 MCP 服务器已在 `~/.redcode/redcode.jsonc` 中预配置好，无需手动编辑配置即可启用。

### 4.1 代码智能

| 服务器 | 用途 | 首次使用前 |
|--------|------|-----------|
| **TypeGraph** | TypeScript 语义导航：类型跳转、barrel 穿透、循环依赖检测 | — |
| **jCodeMunch** | 结构化代码检索：60+ 工具（符号查找、死代码、AST 匹配、编辑安全预检）| `jcodemunch-mcp index`（推荐，启用 AI 摘要）|

### 4.2 网络与浏览

| 服务器 | 用途 | 首次使用前 |
|--------|------|-----------|
| **Web Search** | 网页搜索：DuckDuckGo + Yahoo 兜底，内置服务，零 API Key | — |
| ~~Browser MCP~~ | 浏览器自动化（已禁用，稳定性不足） | — |
| **Vision MCP** | 多模态视觉分析：让不支持图片的模型也能看截图 | 安装 Ollama + 拉取 `qwen3-vl:8b` 模型 |
| **Exa Search** | 语义搜索引擎：AI 驱动的深度网络搜索 | 注册免费 API Key（`dashboard.exa.ai`）|

### 4.3 记忆与知识

| 服务器 | 用途 | 首次使用前 |
|--------|------|-----------|
| **gbrain** | 持久化记忆大脑（PGLite 本地存储）| — |
| **su-prememory** | 本地语义记忆：SQLite+FTS5 全文搜索，纯离线 | — |

### 4.4 平台搜索与发布

| 服务器 | 用途 | 首次使用前 |
|--------|------|-----------|
| **Agent Reach** | 统一搜索：GitHub 仓库/Issue、B站视频和字幕、抖音视频信息 | `gh auth login`（GitHub 功能）|


### 4.5 添加自己的 MCP

```jsonc
{
  "mcp": {
    "my-server": {
      "type": "local",           // local = 本地进程
      "command": ["node", "./path/to/server.js"],
      "environment": {
        "API_KEY": "xxx"
      },
      "timeout": 30000,          // 可选，默认 30s
      "enabled": true
    }
  }
}
```

本地 MCP 也可以用 `npx`、`uvx` 等工具启动，或在 `~/.redcode/redcode.jsonc` 中添加永久配置。

---

## 5. AI 人格系统

### 5.1 工作原理

人格系统分两层：

1. **用户画像** (`~/.redcode/USER.md`) — 关于你是谁，自动注入每次对话
2. **灵魂文件** (`~/.redcode/souls/*.md`) — AI 的性格设定，每次对话启动时按客户端类型自动注入（TUI→Tsoul.md，GUI→Gsoul.md）；也可通过 `/tui-persona` `/gui-persona` 命令手动加载

### 5.2 加载人格

在对话中输入：

```
/tui-persona  ← 加载 TUI 终端人格
/gui-persona  ← 加载 GUI 桌面人格
```

### 5.3 人格文件模板

灵魂文件从 `.opencode/agents/{T,G}soul.md` 自动播种到 `~/.redcode/souls/`。你可以随意修改。

如果不想要人格功能，不执行上述命令即可，AI 保持默认行为。

---

## 6. 记忆系统

### 6.1 概述

RedCode 内置自动化记忆系统（skill `memory-automation`），全程自动运作，无需手动操作。

### 6.2 每日日志

当 AI 在工作中发现错误被纠正、或走了弯路时，自动写入当天日志：

```
~/.redcode/memory/260606.md
```

日志格式自由，一句话即可。例如：

```markdown
## 260606
- 改了 redcode.jsonc 后忘记 typecheck，被 CI 拦截
```

### 6.3 长期库

收工或标记任务完成（`/goal done`）时，AI 自动：

1. 从当日日志中摘出关键教训
2. 去重合并到 `~/.redcode/MEMORY.md`
3. 删除日志中已移入长期库的条目
4. 定期复审清理过时条目

### 6.4 启动注入

每次新对话启动时，AI 自动读取：

- 最近 3 天的日志 → 了解近期工作
- `~/.redcode/MEMORY.md` → 遵守已总结的教训
- `~/.redcode/USER.md` → 按你的偏好交互

### 6.5 关闭记忆

如果你不想要记忆功能，从 `redcode.jsonc` 的 `instructions` 中移除 `memory-automation` 条目即可。

---

## 7. 配置详解

### 7.1 配置文件层次

| 文件 | 作用域 | 说明 |
|------|--------|------|
| `~/.redcode/redcode.jsonc` | **全局** — 所有项目 | 通用 provider、MCP、权限规则 |
| 项目根 `redcode.jsonc` | **项目级** | 覆盖或补充全局配置 |
| `~/.redcode/MEMORY.md` | 长期记忆 | AI 自动读写 |
| `~/.redcode/USER.md` | 用户画像 | AI 启动时自动读取 |
| `~/.redcode/souls/*.md` | 灵魂文件 | 通过 `/tui-persona` 等命令触发 |

> 配置合并规则：项目级覆盖全局级，instructions 数组拼接而非替换。

### 7.2 权限门控

通过环境变量 `ECC_PROFILE` 控制 AI 的自主程度：

```bash
# Windows (PowerShell)
$env:ECC_PROFILE="minimal"

# macOS / Linux
export ECC_PROFILE=strict
```

| 操作 | minimal | standard（默认） | strict |
|------|---------|-----------------|--------|
| 搜索/读取 | 自动 | 自动 | 自动 |
| 单文件编辑 | 自动 | 自动 | 确认 |
| 跨文件编辑 | 自动 | 确认 | 确认 |
| Shell 命令 | 自动 | 白名单确认 | 逐个确认 |
| 删文件 / push / 改名 | 确认 | 确认 | 确认 |

### 7.3 添加自定义 MCP

见 [第 4.3 节](#43-添加自己的-mcp)。

---

## 8. 内置命令

在对话框中输入（TUI 和 GUI 均支持）：

| 命令 | 作用 |
|------|------|
| `/goal <目标>` | 钉住会话目标，防止 AI 跑题 |
| `/goal clear` | 清掉当前目标 |
| `/goal done` | 标为完成，自动归档教训 |
| `/tui-persona` | 加载 TUI 灵魂人格 |
| `/gui-persona` | 加载 GUI 灵魂人格 |
| `/recall <关键词>` | 按关键词从 `MEMORY.md` 语义召回历史教训 |
| `/subtask <任务>` | 派后台子任务，上下文隔离不污染当前会话 |
| `/commit` | 按 conventional commit 格式提交代码 |
| `/changelog` | 生成 CHANGELOG.md 条目 |
| `/issues` | 查看或创建 GitHub issues |
| `/learn` | 从当前会话提取非显而易见的教训写入 AGENTS.md |
| `/translate` | 把改动的英文文档/UI 文案翻译成其他语言 |
| `/rmslop` | 清理本分支引入的 AI 代码痕迹（多余注释/防御性代码等）|
| `/spellcheck` | 检查改动的 Markdown 文件拼写和语法 |
| `/ai-deps` | 排查 AI SDK 依赖可升级的 minor/patch 版本 |

命令文件位于 `.opencode/command/` 和 `~/.redcode/command/`，纯文本，可以自己添加或修改。

---

## 9. Skill 技能系统

Skill 是扩展 AI 行为的机制——本质上是注入给 AI 的指令文件。

### 9.1 内置 Skill

| Skill | 作用 | 触发词 |
|-------|------|--------|
| **memory-automation** | 自动记忆系统（日志/长期库/启动注入）| "收工""保存记忆" |
| **bump-version** | 一键升版（package.json→徽章→CHANGELOG→commit）| "升版""bump""更新版本" |
| **ce-code-review** | 结构化多维度代码审查 | "帮我看看代码""review一下" |
| **diagnose** | 形式化 bug 诊断循环 | "查bug""排查一下""debug" |
| **guardrail-profiles** | 三档权限控制（minimal / standard / strict）| "快干""严格模式" |
| **defensive-agent** | 防止 AI 假阳性报告、无意义修改 | "小心点""别乱改" |
| **goal-automation** | 检测大任务并建议钉住目标 | 自动检测 |
| **vision-autoagent** | 收到图片时自动调 vision MCP 分析 | 自动触发 |
| **frontend-design** | 生成 macOS 风格的高质量前端界面，避免 AI 通用观感 | "做个页面""写个组件" |
| **simplify** | 检测过度工程，建议精简 | "太复杂了""精简一下" |
| **red-scribe** | 按 Red 的写作风格输出 | "按我的风格写""red风格" |
| **yuqi-slop** | 中文去 AI 味 | "去AI味""褪AI味" |
| **stop-slop** | 英文去 AI 味 | "英文去AI味" |

### 9.2 添加自定义 Skill

```bash
# 在 ~/.redcode/skill/ 下创建目录和 SKILL.md
mkdir -p ~/.redcode/skill/my-rules
$EDITOR ~/.redcode/skill/my-rules/SKILL.md
```

SKILL.md 需要 YAML frontmatter（`name` + `description`），引擎靠 description 语义匹配自动触发：

```markdown
---
name: my-rules
description: 我的编码规范。用户说"按规范来""检查规范"时触发。
---

# 我的编码规范

- 所有函数必须有 TypeScript 类型注解
- 使用 `const` 而非 `let`
- 避免 `any` 类型
- 行尾不要分号
```

**无需在 `redcode.jsonc` 中注册**——引擎自动扫描 `~/.redcode/skill/` 下所有 `SKILL.md`，重启对话即生效。

---

## 10. 隐私与多机同步

### 10.1 隐私模型

```
仓库（公开）                   用户本地（私有）
.opencode/                    ~/.redcode/
├── agents/Tsoul.md  ← 模板    ├── souls/Tsoul.md  ← 你的版本
├── agents/Gsoul.md   ← 模板   ├── souls/Gsoul.md  ← 你的版本
├── MEMORY.md         ← 模板   ├── MEMORY.md       ← 你的记忆
├── skill/                     ├── USER.md         ← 你的画像
├── command/                   ├── memory/         ← 你的日志
└── plugins/                   └── sessions/       ← 会话数据
```

- 仓库**仅包含模板和共享配置**，没有任何你的个人数据
- `~/.redcode/` **不在仓库中**，不会被推送
- 其他人克隆此项目只会看到空白模板

### 10.2 多机同步

如果你在多台电脑上使用，建议建一个私有 GitHub 仓库同步 `~/.redcode/`：

```bash
# 第一台电脑：初始化私有仓
cd ~/.redcode
# 创建 .gitignore 排除无需同步的目录
echo -e "sessions/\nnode_modules/\n" > .gitignore
git init && git add -A && git commit -m "init"
# 在 GitHub 创建一个 Private 仓库
git remote add origin https://github.com/你的用户名/redcode-private.git
git push -u origin main

# 第二台电脑：克隆
cd ~
git clone https://github.com/你的用户名/redcode-private.git .redcode
git clone https://github.com/JiaHuiRed/RedCode.git
```

日常同步：

```bash
# 在家：改完就推
cd RedCode && git push
cd ~/.redcode && git push

# 在公司：先拉
cd RedCode && git pull
cd ~/.redcode && git pull
```

### 10.3 跨平台注意事项

RedCode 目前主要在 Windows 10/11 上开发和测试。跨平台兼容性问题欢迎提交 PR。

---

> 如有其他问题，请查看 [CHANGELOG.md](CHANGELOG.md) 了解版本历史，或提交 GitHub Issue。
