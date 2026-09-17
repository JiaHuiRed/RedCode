# Studio 模式：独立的工作姿态与用户记忆层

状态：proposed

## 问题

**驱动问题。** RedCode 目前只有一个心智模型：改代码。但实际使用中大量非编码任务也走它——查电脑问题、清理磁盘、写文档、做调研。同类产品都在往这个方向倾斜：Claude Code 有 Agent Teams（多实例协作、共享任务、inter-agent 消息），OpenAI Codex 跨 ChatGPT/IDE/CLI/GitHub 并支持 scheduled continuing work，ZCode 与腾讯 WorkBuddy 主打「一句话下达任务、自动规划执行」。RedCode 缺的不是执行能力，是**一个不做代码的落点**。

**真正的诉求。** 用户要的不是 work 模式这个抽象概念，是把一个已经养成的智能体接进来：它自 2026-03 起在 OpenClaw（用户 fork 后为 RedClaw）上长期使用，用户希望它成为 Studio 模式的专属角色，与 TUI、GUI 侧的两个助手形成分工。用户明确不希望继续在 RedClaw 上改造——原话是「在别人的项目上怎么改都不太对味」，希望「吸收有用的东西接进来」。

所以本方案的交付物是**给这个智能体一个落脚点**，不是功能清单。功能层面 RedCode 大体已有（记忆、技能、MCP、子代理），不需要从 RedClaw 移植运行时。

**次生约束。** 用户指出两种记忆性质不同：「我们本身也有记忆、soul 这些，但主要是为了让你平时跟我交流的时候有一些语气词，以及方便记住经验教训」，而 Studio「需要做的就是真正的累积记忆，越来越了解我」。工程规则与个人画像不能混在同一注入面。

## 现状（实证）

### RedCode 侧

1. **姿态架构已是三分的。** `packages/opencode/src/agent/agent.ts` 的 `Agent.Info`（L74-96）由三个构造器结构性隔离（L227-254）：`posture()` 会话姿态（`mode:"primary"`，只有 permission + display）、`subagent()` 子代理工种（定义来自 `src/agent/definition/*.md`）、`machine()` 内部机件（hidden + 全 deny）。现有姿态：`plan` / `redmind`（默认）/ `auto`（`agent.ts:256-328`）。

2. **新增姿态只需改两处。** `agent.ts:256-328` 加一个 `posture({...})` 条目；`config/config.ts:238-257` 在 `agent` 块的命名键里加同名键。其余全部自动：UI 切换器（TUI `cli/cmd/tui/context/local.tsx:67-131`、App `app/src/context/local.tsx:68-256`，都按 `mode !== "subagent" && !hidden` 动态取列表）、会话创建（`Session.CreateInput.agent` 是可选字符串，DB 列 `session.sql.ts:44` 为 `text()`，**无需 migration**）、提示词组装（`session/llm/request.ts:58-66`）、工具过滤（`tool/registry.ts:390-466`）、技能可见性（`skill/index.ts:311-316`）、斜杠命令（`command/index.ts:29-42` 带 `agent` 覆写）。

3. **人格（soul）当前按客户端维度选取，不是按姿态。** `session/instruction.ts:184-189`：`flags.client === "desktop" ? "Gsoul.md" : "Tsoul.md"`，路径 `~/.redcode/souls/<file>`。这是接入该智能体人格的**唯一必须改动的核心位置**。

4. **记忆注入面是叠加的。** 同文件 L160-182：全局 `~/.redcode/MEMORY.md` 与项目 `<root>/.redcode/MEMORY.md` 两份**同时注入**，全局在前。两者的设计目的是工作规则与项目经验，不是用户画像。

5. **技能发现已原生支持 `.agents/skills/`。** `skill/index.ts:20-21` 定义 `CLAUDE_EXTERNAL_DIR = ".claude"`、`AGENTS_EXTERNAL_DIR = ".agents"`；L180-197 扫 `~/.claude`、`~/.agents` 与向上查找的项目目录；**L204-214 还支持 `cfg.skills.paths`（支持 `~/` 展开）**。形态要求是 `<skill-name>/SKILL.md`。

6. **记忆召回基础设施已存在。** `~/.redcode/supermemory.db`（`memories` 表 + FTS5 trigram，`project` 字段区分 global/项目）、`/recall` 命令、`memory-recall` 插件按用户消息自动检索注入。相关 note：`docs/notes/implemented/bug-fix/2026-09-10-recall-supermemory-db.md`、`2026-09-15-recall-token-packing.md`。

### 目标智能体的档案侧

档案源是它的 **OpenClaw home**（本机 C 盘配置目录，非 Git 仓库）。其目录结构、文件命名与 RedCode 的设计高度相似，只是没有仓库级版本管理。

- **workspace 目录自身是独立 git 仓库**，历史中包含人格文件的多次迭代与一次「合并重复记忆、删冗余身份文件」的自整理。也就是说档案**已有版本管理**，导入时应尊重这一点。
- 根文件：`SOUL.md`（人格，约 4.9KB）、`MEMORY.md`（关于用户的长期记忆，约 15KB）、`AGENTS.md`（约 11.9KB）、`TOOLS.md`（约 7.2KB）、`HEARTBEAT.md`（心跳规程，约 1.2KB）、`USER.md`（空模板）、一张头像。
- `memory/YYYY-MM-DD.md` 每日笔记：自 2026-03-09 起，约六个月，逐日累积。
- `.agents/skills/` 六个技能，覆盖 Windows 系统诊断、Windows 清理（含 `clean.ps1`）、每日巡检、代码库检视、GitHub 代码审查、工具创建。形态（`<name>/SKILL.md`）与 RedCode 完全一致。
- `.dreams/`、`.learnings/LEARNINGS.md`、`.clawhub/`。
- **运行态**：`cron/jobs.json`（每日巡检 + 梦境两个作业）、`agents/main/sessions/`、`identity/`、`devices/`、`openclaw.json`（含多份 `.bak`/`.last-good`/`.rejected` 滚动备份）。

**语义要点**：人格文件里有明确的工作铁律（先给方案等确认再动手、干完验证再汇报、最小改动、失败两次换路、外部动作先问、删东西留后路），心跳规程要求「每次至少做一件有价值的事，不要 HEARTBEAT_OK 混日子」。这些是可迁移的行为约束，不必绑定 OpenClaw 运行时。

## 决策（拟采用）

分五层，逐层独立可验证，**每层都不依赖 OpenClaw 运行时**。

### L1 姿态：`studio` 作为第四个 posture

在 `agent.ts` 的 `agents` 记录里加入 `studio`。要点：

- **权限取「半自动管家档」**：比 `redmind` 放开诊断类操作（读日志、查状态、看进程本就是只读，`defaults` 已 allow），比 `auto` 收紧——保留 `destructive: ask`，不开 `doom_loop`。理由是该智能体的行为准则本身就是「诊断放行，修改请示」，权限档应与人格一致。
- **必须用对象形式写 `read` / `external_directory`**。`Permission.merge` 是数组 concat、`evaluate` 是 findLast（`packages/core/src/permission.ts:33-35 / 21-31`），块首行一条扁平 `"*": deny` 会把 defaults 里对象型的 `.env` 护栏整段顶掉。
- **显式钉 `color`**。可见顺序取调色板会因新增条目而移索引撞色（`redmind` 已因此钉死 `color:"error"`）。
- 不改 `mode`：保持 `"primary"`，不设 `hidden`。

### L2 人格：soul 选取从「按客户端」扩展为「按姿态」

现状只有一维，且那一维是**进程级**的：`instruction.ts:186` 用 `flags.client`（来自 `REDCODE_CLIENT` 环境变量）在 `Tsoul.md` / `Gsoul.md` 之间选。同一个 TUI 进程内切换姿态时该值恒不变，所以姿态这一维只能从别处进来——不是环境，而是 `agent`：`prompt.ts:1500` 已经在用 `sys.skills(agent)`，调用点本来就能拿到它。

**选取模型（两级回落）**：

1. `config.soul[agent.name]` —— 显式声明，命中即用；
2. `flags.client` 维度 —— 未命中时维持现状，不改变既有行为。

**为什么由配置驱动，而不是在 `posture({...})` 里写死**：引擎代码里写死人格文件名，等于把具体人格固化进仓库（名字会进 git 历史），与「soul 是人格的唯一权威、引擎不立法」相悖；何况该档案是私人数据。映射放用户级配置，进仓的只有字段定义：

```jsonc
// redcode.local.jsonc（不进主仓）
"soul": {
  "<posture-name>": "<filename>.md"   // 相对 ~/.redcode/souls/；以 ~/ 开头则按路径解析
}
```

键是姿态名，值是文件名或 `~/` 路径——与 `config.instructions` 的解析规则同构，不发明新约定。选顶层 `config.soul` 而非 `agent.<name>.soul`：后者要动 `Agent.Info` schema，会连带 SDK/OpenAPI 的 wire type。

**改动点四处**：

| # | 位置 | 改动 |
| --- | --- | --- |
| 1 | `config/config.ts` | 新增 `soul: Schema.optional(Schema.Record(Schema.String, Schema.String))` |
| 2 | `session/instruction.ts:135` | `systemPaths(agent?: Agent.Info)`，soul 选取加姿态分支 |
| 3 | `session/instruction.ts:211` | `system(agent?)` 透传至 `systemPaths()`；`prompt.ts:1502` 传入 `agent` |
| 4 | `session/prompt-caches.ts:7` + `prompt.ts:1490` | `SystemCache` 带 agent 标识，命中时校验 |

**第 4 处是必需的，并顺带修掉一个既有缺陷**：`SystemCache` 的键是 `Map<sessionID, Map<modelKey, ·>>`，不含 agent，而 `skills` 早已按 agent 变化（`prompt.ts:1500`）。也就是说**同一会话内切换姿态，技能可见性会沿用上一个姿态的缓存**。加 soul 只会让同一处再漏一份人格。做法是在缓存值里带 agent 名、命中时比对，未命中即重建并覆盖同槽位。代价只落在切换姿态那一轮，与切换本身必然引发的 skills/tools 变化同批，不算额外开销。

**三条不变量**：

- **位置不动**：soul 仍留在 `systemPaths()` 的原位（AGENTS/MEMORY 之后、`config.instructions` 之前），不新增段落、不调整顺序；未配置姿态的注入面前缀逐字节不变。
- **独立硬上限**：人格文件目前只受 `maxSourceBytes`（1MiB）约束，对人格文件过宽。单独立 `SOUL_MAX_BYTES = 32KiB`，超限不注入且 `log.warn`——本仓红线：任何进入模型上下文的内容都必须有确定上限。
- **显式声明解析不到要响**：现 L188 对读不到的路径静默跳过。应区分两种情形——配置里声明过的路径读不到 → 告警（误配置要响）；默认回落文件不存在 → 保持静默（首启未播种的正常态）。

**模型可见改动四问**：

1. *模型看到什么变了*：未配置时零变化；配置后，仅当会话 agent 命中该键，人格段内容被替换。
2. *token 影响*：未配置时固定前缀增减为 0；配置后等于该文件大小，上限 32KiB。
3. *KV cache 影响*：soul 位置不变，未配置则完全不动；配置后，该姿态下自 soul 段起的后缀重建一次，且与切换姿态必然引发的 skills/tools 变化同批。
4. *注入上限*：见「不变量」第二条。

**与 L3 及同步问题的关系**：配置指向的是 `~/.redcode/souls/` 下的**导入快照**，不是它的 OpenClaw home 活引用——保住「不运行时不依赖、不改写源目录」这条边界。

### L3 记忆：独立的用户记忆层

**不复用 `MEMORY.md`。** 新增独立存储（沿用 `supermemory.db` 的方案，以 `project` 或新字段区分「用户画像」与「工程教训」两类），每条记录带来源、时间、置信度与可撤回标记。

- 注入策略：**按相关性取少量摘要**，不整份注入。参考 `2026-09-15-recall-token-packing.md` 的打包方式。
- 上限纪律：进入模型上下文的任何内容必须有确定字节/token 上限（仓库既有红线，见根 `AGENTS.md`）。
- 迁移来源：其 `MEMORY.md`（约 15KB）+ `memory/*.md` 逐日笔记，经**显式导入**形成快照，而非运行时直读。

### L4 技能：走 `skills.paths` 配置接入

在用户级配置（`redcode.local.jsonc`）把该智能体的技能目录加进 `skills.paths`（支持 `~/` 展开）即可让那六个技能可见——**零代码改动**。是否限定仅 `studio` 姿态可见需要再定（可用 `permission.skill` 控制）。

### L5 主动性：心跳与巡检（二期，不在本期）

其现有 cron 作业（每日巡检 + 梦境）与 `HEARTBEAT.md` 规程属于**持续性行为**，涉及调度器、静默时段、主动打扰的边界，风险显著高于前四层，留到 L1-L4 稳定后单独出方案。

## 备选与否决理由

- **把 RedClaw fork 继续改造成产品**：否决——重复造轮子，且继承 OpenClaw 的产品语义与运行时耦合；用户已明确「在别人的项目上怎么改都不太对味」。
- **运行时直接读它的 OpenClaw home**：否决——把该智能体绑回 OpenClaw，两套运行时互相牵制；用户希望的是「吸收有用的东西接进来」。
- **把该智能体的档案提交进 RedCode 仓库**：否决——私人内容不进仓（仓库会 push）。本方案因此只描述结构与边界，不抄录人格与画像内容，也不记录其身份标识。
- **用现有 `MEMORY.md` 承载 Studio 记忆**：否决——混淆工程规则与私人画像，且 `MEMORY.md` 每轮整份注入，会让固定前缀持续膨胀。
- **只在提示词里塞一段人设**：否决——无记忆、无来源、无撤回，且把私人内容固化进模型可见面。
- **照搬 RedClaw 的梦境三阶段（light/deep/REM）**：暂缓——该设计与其 cron + 隔离 agent + 记忆引擎三方耦合，且其本地 `.dreams/` 实际数据近乎为空（`events.jsonl` 0 字节），先不引入。

## 后果

- **收益**：该智能体有独立姿态与人格，coding 心智模型不被稀释；工程记忆与用户画像分层，各自可独立演进。
- **代价**：多一套 soul 选取分支与一个记忆存储域；`instruction.ts` 的 per-session soul 选取是本仓首次，因此缓存键必须带 agent 标识（见 L2），否则切换姿态会沿用旧人格与旧技能可见性。
- **需防复发**：权限块的 `read`/`external_directory` 必须对象形式（合并语义坑，已在上文点名）；新增姿态必须显式钉色。
- **隐私边界**：任何情况下不把人格、用户画像写入仓库、`MEMORY.md`、固定 system prompt 或公开文档。

## 分期路线

| 阶段 | 内容 | 验证方式 |
| --- | --- | --- |
| Phase 1 | `studio` posture + 权限档 + 测试 | `bun run typecheck`、`bun test test/agent/agent.test.ts` |
| Phase 2 | soul 按姿态选取 + 该人格文件落地（本机非仓） | 实际会话比对注入面（`PrefixShape` / `sysLen` 日志） |
| Phase 3 | 用户记忆层：schema + 导入脚本（预览/回滚）+ 相关注入 | 导入前后条数与字符数核对；注入上限断言 |
| Phase 4 | `skills.paths` 接入 + 姿态级可见性 | 会话内确认技能列表 |
| Phase 5（远） | 心跳/巡检/通道（微信等） | 另案 |

## 未决问题（需用户拍板）

1. **`studio` 的权限档**：诊断类完全放行、修改类请示（推荐），还是更宽松？
2. **姿态与模型的绑定**：Studio 是否绑定特定模型（姿态当前结构上不含 `model`，要绑需扩构造器）。
3. **soul 选取的维度**：已定——按姿态，映射走用户级配置（详见 L2）。
4. **记忆导入范围**：只导 `MEMORY.md` 摘要，还是连同六个月逐日笔记与 `.learnings/` 一并导入。
5. **技能可见性**：那六个技能是全局可见，还是仅 `studio` 姿态可见。
6. **两个世界的同步**：导入是单向快照，还是需要「RedCode 里的新记忆回流到 OpenClaw home」。倾向单向——回流会让两套运行时重新耦合。
