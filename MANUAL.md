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
# 产物本来就是 Windows 单目标，无需额外开关
cd packages/opencode && bun run build

# 桌面 GUI
cd packages/desktop && bun run build && bun run package
```

### 启动后发生了什么

第一次启动时，系统自动：

1. 创建 `~/.redcode/` 目录（存放全局配置和记忆），以及 `souls/` 子目录（`memory/` 只作归档，不再写入）
2. 播种人格与记忆模板到 `souls/{T,G}soul.md`、`MEMORY.md`——这三份模板**编译时内嵌在二进制里**，所以无论 exe 装在哪儿都能播（已存在的文件不会被覆盖）
3. 若当前目录是 RedCode 仓库的克隆，额外把 `seed/skill/` 下的技能播种到 `~/.redcode/skill/`（同样只补不覆盖）；拿 release 二进制直接用的话这一步跳过，技能可自行放进 `~/.redcode/skill/`
4. 加载配置、MCP 服务器与 skill 技能
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
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "apiKey": "sk-xxxxxxxx",
        "baseURL": "https://api.deepseek.com/v1"
      }
    }
  },
  "model": "deepseek/deepseek-chat"
}
```

**注意两点**（写错了不会报错，只会静默失效）：

- **没有 `type` 字段**。决定用哪个协议适配器的是 `npm`。
- **`apiKey` / `baseURL` 必须嵌在 `options` 里**，不能放在 provider 顶层。多余的键会被静默丢弃，结果是一个没有凭据的 provider，且不产生任何报错。

provider 顶层可用的键只有：`npm`、`options`、`models`、`name`、`api`、`env`、`id`、`whitelist`、`blacklist`（定义见 `packages/opencode/src/config/provider.ts`）。

常用的 `npm` 适配器：

| 适配器 | 适用 |
|---|---|
| `@ai-sdk/openai-compatible` | 绝大多数第三方/自建服务（DeepSeek、GLM、MiniMax、各类中转、Ollama 的 `/v1`） |
| `@ai-sdk/anthropic` | Anthropic 官方 API |
| `@ai-sdk/google` | Google Gemini 官方 API |

参考配置示例（本地 Ollama，省略 `npm` 时默认按 OpenAI 兼容处理）：

```jsonc
{
  "provider": {
    "ollama": {
      "options": { "baseURL": "http://localhost:11434/v1" },
      "models": {
        "qwen3.5:9b-q8_0": { "name": "Qwen3.5 9B" }
      }
    }
  },
  "model": "ollama/qwen3.5:9b-q8_0"
}
```

> 仓库里的 `seed/redcode.home.jsonc` 是一份可直接参照的真实配置模板。

### 2.2 设置称呼

对话里 AI 怎么称呼你，由 `redcode.jsonc` 的 `username` 字段决定（不填则用系统用户名）：

```jsonc
{ "username": "哥哥" }
```

至于 AI 的性格、语气、怎么跟你协作，全部写在灵魂文件里（见 5.1）。0.8.2 之前这些散在
`~/.redcode/USER.md`，与灵魂文件大量重复，已下线；老用户那份文件留着不会再被加载，可以自行删除。

### 2.3 自定义 AI 人格

灵魂文件定义 AI 的性格设定。灵魂文件定义 AI 的性格、语气和行为边界。TUI 和 GUI 可以有不同的灵魂：

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

**人格自动加载**：每次启动对话时，引擎自动按客户端类型注入对应人格（TUI→Tsoul.md，GUI→Gsoul.md），无需手动命令。也可在对话中输入 `/tui-persona` 或 `/gui-persona` 手动切换。

---

## 3. 配置模型

### 3.1 选哪个适配器（`npm`）

配置里没有 "provider 类型" 这个概念——决定走哪套协议的是 `npm` 字段，填的是 AI SDK 适配器包名。

| `npm` | API 格式 | 适用 |
|------|---------|------|
| `@ai-sdk/openai-compatible` | OpenAI 兼容 | DeepSeek、Moonshot、Ollama、Groq、Step、GLM、MiniMax、各类中转 |
| `@ai-sdk/anthropic` | Anthropic 原生 | Claude 官方 API |
| `@ai-sdk/google` | Gemini 原生 | Google Gemini 官方 API |

绝大多数国内服务和自建服务都提供 OpenAI 兼容端点，用第一行即可——GLM、MiniMax 也在此列，它们不需要专门的适配器。省略 `npm` 时按 OpenAI 兼容处理。

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
    "ollama": {
      "options": { "baseURL": "http://localhost:11434/v1" },
      "models": {
        "qwen2.5-coder:7b": {
          "name": "Qwen2.5 Coder 7B",
          "temperature": true,
          "tool_call": true,
          "limit": { "context": 32768, "output": 8192 }
        }
      }
    }
  },
  "model": "ollama/qwen2.5-coder:7b"
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
| **jCodeMunch** | 结构化代码检索：60+ 工具（符号查找、死代码、AST 匹配、编辑安全预检）| `jcodemunch-mcp index`（本仓配置里 `JCODEMUNCH_USE_AI_SUMMARIES` 为 `false`，索引更快；需要 AI 摘要再自行打开）|

### 4.2 文件与文档

| 服务器 | 用途 | 首次使用前 |
|--------|------|-----------|
| **markitdown** | 二进制文档转 Markdown：`.docx`/`.xlsx`/`.pptx`/`.pdf` 等 read 读不了的文件用它提取文本 | — |
| **fff** | 高性能文件查找/grep（`fff_find_files`/`fff_grep`/`fff_multi_grep`）| — |
| **sqlite-query** | 结构化查询 SQLite 数据库，免 shell 转义 | — |

### 4.3 网络与视觉

| 服务器 | 用途 | 首次使用前 |
|--------|------|-----------|
| **Web Search** | 网页搜索：DuckDuckGo + Yahoo 兜底，内置服务，零 API Key | — |
| **webqa** | 浏览器自动化（Playwright）：截图、点击、填表、断言，做 Web 前端验证闭环 | — |

### 4.4 记忆与进程

| 服务器 | 用途 | 首次使用前 |
|--------|------|-----------|
| **su-prememory** | 本地语义记忆：SQLite+FTS5 全文搜索，纯离线 | — |
| **mcp-process-mgmt** | 管理交互式/长驻 shell 会话（REPL、dev server 等需要 stdin 的进程）| — |

> 曾预配置过的 **gbrain**（记忆）、**Exa Search**（语义搜索）、**Agent Reach**（B站/抖音/GitHub 统一搜索）已彻底移除（gbrain 元数据损坏且功能被 su-prememory 覆盖；Exa 与 Web Search 冗余；Agent Reach 实际使用率过低，插件源码已删除）。

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

**灵魂文件** (`~/.redcode/souls/*.md`) — AI 的性格设定，也包括它怎么称呼你、怎么跟你协作。每次对话启动时按客户端类型自动注入（TUI→Tsoul.md，GUI→Gsoul.md）；也可通过 `/tui-persona` `/gui-persona` 命令手动加载。

> 0.8.2 之前还有一层 `~/.redcode/USER.md`（用户画像），内容与灵魂文件大量重复，每轮白吃一道加载，已下线。

### 5.2 加载人格

在对话中输入：

```
/tui-persona  ← 加载 TUI 终端人格
/gui-persona  ← 加载 GUI 桌面人格
```

### 5.3 人格文件模板

灵魂文件由引擎首次启动时自动播种到 `~/.redcode/souls/`（模板已内嵌进二进制，装在哪儿都能播）。你可以随意修改。

如果不想要人格功能，不执行上述命令即可，AI 保持默认行为。

---

## 6. 记忆系统

### 6.1 概述

RedCode 内置自动化记忆系统（skill `memory-automation`），在启动/压缩/收工时自动运作。

RedCode 内置自动化记忆系统（skill `memory-automation`），在启动/收工时自动运作，分两层：

- **项目级** `.redcode/MEMORY.md`——当前项目专有的进度、决策与踩坑
- **全局级** `~/.redcode/MEMORY.md`——跨项目通用的历史教训

两层同时注入（全局在前、项目在后），不是二选一。

> 早期版本还有一层当日日志（`~/.redcode/memory/YYMMDD.md`），260729 起退役——实测几乎无人主动读、写入质量也不稳定，历史文件保留可查，不再写入。

### 6.3 教训提炼

收工时，AI 自动：

1. 审视当前项目的 `.redcode/MEMORY.md`，删掉已完成、过时的进度段，保留经验教训
2. 把**跨项目通用**的教训摘入全局 `~/.redcode/MEMORY.md`
3. 每条过三道门禁（换项目仍成立？忘了会再踩且修复贵？未被 AGENTS.md/skill 覆盖？）

全局记忆每轮都要付 token，只留值得长期持有的条目。

每次新对话启动时，AI 自动注入两份记忆：

- **全局级** `~/.redcode/MEMORY.md`（通用教训，在前）
- **项目级** `.redcode/MEMORY.md`（项目专有，在后，覆盖一般）

### 6.5 关闭记忆

如果你不想要记忆功能，从 `redcode.jsonc` 的 `instructions` 中移除 `memory-automation` 条目即可。

---

## 7. 配置详解

### 7.1 配置文件层次

按加载顺序排列，**后加载的覆盖先加载的**：

| 文件 | 作用域 | 说明 |
|------|--------|------|
| `~/.redcode/redcode.jsonc` | **全局** — 所有项目 | 通用 provider、MCP、权限规则 |
| `~/.redcode/redcode.local.jsonc` | **全局 · 仅本机** | 机器本地覆盖层，优先级高于上一行。放绝对路径、按显存挑的模型档位这类因机而异的值；多机同步时把它 gitignore 掉，见 [10.2](#102-多机同步) |
| 项目根 `redcode.jsonc` | **项目级** | 覆盖或补充全局配置 |
| 项目内 `.redcode/redcode.jsonc` | **项目级** | 同上；会从当前目录逐级向上查找到 worktree 根，适合放在子目录里做局部覆盖。同目录下的 `redcode.local.jsonc` 同样生效且优先级更高 |

其余全局资源（不是配置文件，但同样从 `~/.redcode/` 读）：

| 路径 | 内容 |
|------|------|
| `~/.redcode/MEMORY.md` | 长期记忆，AI 自动读写 |
| `~/.redcode/souls/*.md` | 灵魂文件（人格），启动时按 TUI/GUI 自动注入 |
| `~/.redcode/skill/` `command/` `agent/` | 全局技能、斜杠指令、子代理定义（`agent/` 与 `agents/` 两种目录名都认） |
| `~/.redcode/plugin/` `themes/` | 全局插件与自定义主题 |

> 配置合并规则：深合并，项目级覆盖全局级，`instructions` 数组拼接而非替换。
> 注意 `redcode.local.*` 只由人手写——引擎自身写回配置（例如在界面里切主题）落在 `redcode.jsonc`，不会污染本地层。

### 7.2 权限门控

权限门控由**代码强制层**（doom_loop 检测，服务端拦截）兜底，配合各 agent 的 PermissionV2 规则（见 `~/.redcode/agent/` 定义）工作。行为指令层（ECC_PROFILE guardrail）已于 260808 退役。

#### 代码强制层（防空转，软硬双层）

**软层——递进提醒**（`session/repeat-tool-reminder.ts`，0.8.17 起）：同一工具+同一参数连续调用 3 / 5 / 8 次时，把 `[System notice]` 提醒贴在该次结果尾部让模型自纠——不打扰你，纯建议。轮询类调用（每次输出在变）只会触发这层。`todowrite`/`todoread` 这类记账工具不计数也不打断计数。

**硬层——权限弹窗**（`processor.ts` doom_loop 检测），自动检测两种模式：

1. **精确重复**：同一工具+同一输入连续 3 次，且至少一次报错，或输出也完全相同（全成功的原地空转）
2. **周期循环**：6 步内形成 A→B→A→B 或 A→B→C→A→B→C 模式，且至少一次报错

检测触发时向用户提示确认，防止 AI 无意识空转。默认配置 `doom_loop: "ask"`。

### 7.3 繁忙时消息送达（busy_enter）

AI 正在干活时你发的消息怎么处理，`redcode.jsonc` 顶层 `busy_enter` 二选一：

```jsonc
{
  // "steer"（默认）：插话——消息在下一个工具调用结束后立刻送达模型，
  //   适合中途纠偏（"别改那个文件"），不用等本轮跑完
  // "queue"：排队——消息对当前轮完全隐藏，本轮结束后自动作为新一轮的输入，
  //   适合攒任务（"下一件事做 X"），不打断当前思路
  "busy_enter": "steer"
}
```

**TUI 和 GUI 都可以直接 `/busy-enter` 切换**（命令面板同样可搜"繁忙时消息"），**GUI 还可以在 设置 → 通用设置 → 繁忙时消息送达 下拉切换**。三个入口都走 API 写回 `redcode.jsonc` 并强制重载配置，**立即生效不用重启**；手改配置文件则需重启。TUI 消息列表里繁忙期发送的消息会带 `QUEUED` 徽标；注意 steer 模式下徽标虽在，消息其实很快就送达了（界面状态细化在计划中）。

### 7.4 归档会话（仅 GUI）

会话列表太长时，把做完的会话**归档**——它从首页列表消失，但**数据一个字节都不删**（只是打了个时间戳，列表查询默认过滤掉带时间戳的）。

| 操作 | 位置 |
|------|------|
| 归档 | 首页会话行/看板卡片 **右键 → 归档会话**；或命令面板 `session.archive`；或 `Ctrl+Shift+Backspace` |
| 查看已归档 | 首页搜索框右侧的**归档图标**按钮，切换后列表显示已归档会话 |
| 取消归档 | 在已归档视图里 **右键 → 取消归档**，会话立刻回到正常列表 |

> 归档不省磁盘（消息和历史都还在库里）。想真正释放空间只能删会话，那是不可逆的。

### 7.5 添加自定义 MCP

见 [第 4.5 节](#45-添加自己的-mcp)。

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
| `/busy-enter` | 切换繁忙时消息送达：插话 ↔ 排队（TUI/GUI 均内置，立即生效，见 [7.3](#73-繁忙时消息送达busy_enter)）|

命令文件位于 `seed/command/` 和 `~/.redcode/command/`，纯文本，可以自己添加或修改。

---

## 9. Skill 技能系统

Skill 是扩展 AI 行为的机制——本质上是注入给 AI 的指令文件。

### 9.1 内置 Skill

| Skill | 作用 | 触发词 |
|-------|------|--------|
| **memory-automation** | 自动记忆系统（日志/长期库/启动注入）| "收工""保存记忆" |
| **ce-code-review** | 结构化多维度代码审查 | "帮我看看代码""review一下" |
| **diagnose** | 形式化 bug 诊断循环 | "查bug""排查一下""debug" |
| **defensive-agent** | 防止 AI 假阳性报告、无意义修改 | "小心点""别乱改" |
| **goal-automation** | 检测大任务并建议钉住目标 | 自动检测 |
| **vision-autoagent** | 模型不支持图片时，派多模态子代理读图（260807 起取代本地 Vision MCP）| 自动触发 |
| **frontend-design** | 生成 macOS 风格的高质量前端界面，避免 AI 通用观感 | "做个页面""写个组件" |
| **simplify** | 检测过度工程，建议精简 | "太复杂了""精简一下" |
| **red-scribe** | 按 Red 的写作风格输出 | "按我的风格写""red风格" |
| **yuqi-slop** | 中文去 AI 味 | "去AI味""褪AI味" |
| **stop-slop** | 英文去 AI 味 | "英文去AI味" |

以上 11 个随仓库分发（`seed/skill/`），克隆即有，首次启动会播种到 `~/.redcode/skill/`。

下面这些只存在于维护者本机的 `~/.redcode/skill/`，**不在仓库里**，克隆的人不会有——列在这里是说明个人库可以怎么扩展：

| Skill | 作用 | 触发词 |
|-------|------|--------|
| new-project | 新项目脚手架 | "新项目""搭个项目" |
| species-design | RedMon 精灵设计 | "设计精灵""新精灵" |
| ai-daily | AI 热点日报 | "日报""今天ai新闻" |
| game-daily | 游戏热点日报 | "游戏日报""游戏新闻" |
| bump-version | 一键升版 | "升版""bump""放版" |
| tdd-flow | TDD 流程 | "tdd""先写测试" |

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
seed/                          ~/.redcode/
├── skill/           ← 种子     ├── souls/{T,G}soul.md ← 你的人格（首启由内嵌模板播种）
├── command/         ← 种子     ├── MEMORY.md       ← 你的记忆
├── agents/          ← 种子     ├── memory/         ← 日志归档（只读）
├── scripts/         ← 种子     ├── skill/ command/ agent/
└── redcode.home.jsonc ← 配置模板 └── data/           ← 会话 DB / 日志 / 快照

（seed/ 里的东西引擎不直接加载，由 script/sync-home.bat 播种到 ~/.redcode/ 才生效；
　人格与 MEMORY 模板已内嵌进二进制，见 packages/opencode/src/project/template/）
```

- 仓库**仅包含模板和共享配置**，没有任何你的个人数据
- `~/.redcode/` **不在仓库中**，不会被推送
- 其他人克隆此项目只会看到空白模板

### 10.2 多机同步

如果你在多台电脑上使用，建议建一个私有 GitHub 仓库同步 `~/.redcode/`：

```bash
# 第一台电脑：初始化私有仓
cd ~/.redcode
# 创建 .gitignore 排除机器本地数据
# 重要：data/ 里有 redcode.db（会话数据库）和 auth.json（各家 provider 的密钥），
# 必须排除，否则会连同密钥一起推到远端仓库
@'
data/
cache/
state/
locks/
node_modules/
'@ | Set-Content -Encoding utf8 .gitignore
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

#### 机器本地覆盖层（避免两台机器来回改）

同步 `~/.redcode/` 会遇到一个必然的问题：配置里有些值**天生因机而异**——某个 MCP 的绝对安装路径、按显存挑的本地模型档位、只有一台机器装了的服务。它们一旦写进被同步的 `redcode.jsonc`，就会进入死循环：这台机改好推上去，另一台拉下来直接报错（路径不存在，MCP 启动失败）；在另一台改回来，轮到这台报错。

解法是把这类值下沉到 `~/.redcode/redcode.local.jsonc`，它加载在 `redcode.jsonc` 之后、优先级更高，且不进版本库：

```jsonc
// ~/.redcode/redcode.local.jsonc —— 只在这台机器上生效
{
  "$schema": "https://redcode.dev/config.json",
  "mcp": {
    "indexgraph": {
      "type": "local",
      "command": ["node", "D:/AI/IndexGraph/mcp-server.js"], // 换台机器路径就不同
      "enabled": true
    }
  }
}
```

在 `~/.redcode/.gitignore` 里加上：

```
redcode.local.json
redcode.local.jsonc
```

判断标准很简单：**这个值换台机器还成立吗？** 不成立就放本地层。同步文件里只留机器无关的东西——provider、权限规则、以及用 `$REDCODE_ROOT` 表达的相对路径命令。

### 10.3 跨平台注意事项

RedCode 目前主要在 Windows 10/11 上开发和测试。跨平台兼容性问题欢迎提交 PR。

---

> 如有其他问题，请查看 [CHANGELOG.md](CHANGELOG.md) 了解版本历史，或提交 GitHub Issue。
