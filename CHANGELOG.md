# 更新日志

本文件记录 RedCode 的所有重要变更。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

0.3.0 起 TUI 与 GUI 独立维护版本号，各自独立记录。0.3.0 及之前为共同历史。

---

---

## TUI
### [0.8.9] - 2026-08-03

> DCP 元数据标签双防线（提示词禁止 + 输出剥离）堵住正文泄漏；子代理四角色体系上线（architect/fixer/reviewer 三个新角色，按角色路由模型与权限）；子代理权限放行 MCP 检索工具，四角色都能用 jCodeMunch/TypeGraph 查代码。

#### 新增

- **四角色子代理体系**（`.opencode/agents/architect.md`、`fixer.md`、`reviewer.md`）：在内置 explore（检索）基础上新增 architect（只读，出方案/架构设计）、fixer（读写，直接实现）、reviewer（只读，severity 分级审查报告，commit 永远用户拍板）。按角色路由模型：explore=opencode-go/mimo-v2.5（原生多模态识图）、architect/fixer=opencode-go/deepseek-v4-flash（聚合商额度多）、reviewer=step_plan/step-3.7-flash。
- **子代理放行 MCP 检索工具**（`agent/profile/types.ts` 权限体系）：markdown agent frontmatter 的 `"*": deny` 通配会把 MCP 工具（jcodemunch_*/typegraph_*/indexgraph_*/web-search_*/vision_*）一起禁用，三个新角色和内置 explore 均补 `: allow` 放行——子代理现在能用代码检索 MCP。

#### 修复

- **DCP 元数据标签正文泄漏双防线**（`session/instruction-echo.ts`、`session/prompt.ts`）：模型偶发把 `<dcp-message-id>`/`<dcp-system-reminder>` 元数据标签抄进可见正文（实测 `<m0364</m0364>`、整段压缩提醒）。提示词层明确禁止输出标签、遇压缩提醒继续任务；输出层 instruction-echo 快路径 + A 类整块剥离兜底。测试 +2 条。
---

### [0.8.8] - 2026-08-03

> Write 工具显示 .md 文件内容时改用渲染视图——`**文字**` 直接显示粗体、星号隐藏，不再是一眼 TXT。其余语言保持源码视图不动。

#### 变更

- **Write 工具 markdown 渲染视图**（`cli/cmd/tui/routes/session/index.tsx`、`cli/cmd/tui/feature-plugins/system/session-v2.tsx`）：Write 组件对 `filetype === "markdown"` 的文件内容改用 OpenTUI `<markdown>` 组件（MarkdownRenderable，marked 块级解析 + inline 渲染，conceal=true 隐藏 ** 显示粗体），其余文件保持 `<code conceal={false}>` 源码视图。Edit 的 diff 组件不支持 markdown 渲染视图，保持原样。
---

### [0.8.7] - 2026-08-03

> shell 工具的临时文件不再落 C 盘 `Temp\redcode`，改到每个工作区自己的 `.redcode/temp`——测试文件、下载物、临时脚本都在工作区里，系统盘垃圾不再累积。同批把 4 个 defaultAgent 测试对齐 fork 后的真实行为（05890af 默认 agent 改 redmind + 92ab606 引入 primary agent profile）。

#### 新增

- **shell 临时文件改工作区管理**（`tool/shell.ts`、`tool/shell/prompt.ts`、`agent/agent.ts`、`tool/shell/shell.md`）：提示词里的 `${tmp}` 从全局 `Global.Path.tmp`（Windows 上 = `C:\Users\...\AppData\Local\Temp\redcode`）改为 `<workspace>/.redcode/temp`——shell init 闭包里 `yield* InstanceState.context` 拿当前工作区 directory，`mkdirSync` 自动创建；权限白名单 `whitelistedDirs` 同步加 `path.join(ctx.directory, ".redcode", "temp", "*")`。`.redcode/` 已在 gitignore，temp 不进 git。全局 `Global.Path.tmp` 保留给进程内部临时文件（vision 图片、剪贴板 png、editor md、jdtls data），C 盘旧文件暂不清。

#### 修复

- **defaultAgent 4 个测试对齐 fork 行为**（`test/agent/agent.test.ts`）：05890af（260725）把默认 agent 从 build 改为 redmind 且 `list()` 将 redmind 排第一；92ab606（260712）YAML profile 功能引入了 primary "agent"（字母序最前）。无配置默认断言改为 redmind；"只禁 build+redmind 后默认 plan"改为需再禁 agent；"全禁抛错"补禁 agent。41 pass 0 fail。
---
### [0.8.6] - 2026-08-01

> Goal 功能从「半实装」补成完整闭环：钉目标 → 系统提示词注入 → 会话空闲自动续跑（防跑飞三闸门）→ token 记账收尾。同批把标题生成从本地小模型切回当前会话主模型——额度管够，不再受 small_model 掉线拖累。

#### 新增

- **Goal 自动续跑完整实装**（`config/config.ts`、`session/goal-continuation.ts`、`session/prompt.ts`、`effect/app-runtime.ts`、`.opencode/command/goal.md`）：此前 goal 只有数据层 + 工具层（goal_set/done/clear 已注册），接线全断——system 无注入、无开关、无续跑。本次补齐四件：① config 新增 `experimental.goal_auto_continue`（默认关）与 `goal_token_budget`（默认 20 万 tokens）两个开关；② `goal-continuation.ts` 新服务订阅 `SessionStatus.Event.Idle`（run-state onIdle 与 processor 错误路径都会发），`maybeContinue` 七步闸门——开关开、goal active、turn_count < 20、距上次 ≥30s、预算超限时注入收尾 prompt + `mark("budget_limited")`、用户插话即停（对比最新 user 消息 id 与上次 steering 记录）、通过则注入 synthetic steering 消息 + `tick` + `ops.loop` fork 续跑（仿 task.ts resumeWhenIdle 模式）；③ prompt.ts 三处——每步累计 `usageTokens`、runLoop 收尾 `goal.addUsage`（无 goal 行时 UPDATE no-op 零成本）、system 在 MEMORY 条款后 canary 前注入 `<goal>` 块（只 bust 尾部缓存不动前缀大块）；④ AppLayer mergeAll 挂 `GoalContinuation.defaultLayer`。`/goal` 命令同步升级：引导模型调 goal_set/goal_done/goal_clear 工具落库，不再"自己记着"。

#### 变更

- **标题生成改用当前会话主模型**（`session/prompt.ts` ensureTitle）：此前标题走 `small_model`（本地 ollama/qwen3.5）兜底主模型，qwen 掉线会失败重试。哥哥拍板"额度管够"——直接 `provider.getModel(input.providerID, input.modelID)` 主模型生成，删除 getSmallModel fallback 分支与 isMain 判断，失败直接 orDie。
---
### [0.8.5] - 2026-08-01

> DeepSeek V4 Flash 输出上限提到 64K——max_tokens 覆盖 reasoning_content + content 总和，思考链一长正文就被 32K 共享预算挤断，多次中断的根因。同批把 Windsurf 式主动记忆条款写进 system 尾部，遇持久事件不等收工立刻落盘。

#### 修复

- **DeepSeek V4 Flash 输出上限 32K → 64K**（`provider/transform.ts`）：`max_tokens` 覆盖思考链 + 正文总和，V4 Flash 开 max 档思考时（平均 311、长尾远超）正文被 32K 硬顶挤断，导致输出中断。新增常量 `DEEPSEEK_V4_FLASH_OUTPUT_TOKEN_MAX = 64_000`，`maxOutputTokens()` 三分支（MiMo 100K / v4Flash 64K / 其余 32K），新增 `isDeepSeekV4FlashModel()` 按 api.id 含 `deepseek-v4-flash` 判定，覆盖 `-free`/`-think`/`empiriolabs` 家族变体。模型自身 output 上限 384K，64K 是保守余量，后续再断可一行提到 100K。

#### 新增

- **Windsurf 式主动记忆条款**（`session/prompt.ts`）：上下文会被压缩，两层 MEMORY.md 是连接下一个会话的唯一桥梁——之前只靠 AGENTS.md 的记忆规则触发，遵守率低。在 system 尾部铁律之后、canary 之前插入静态条款：遇用户决策/项目坑/被纠正/架构选择立即写入、无需用户许可；`read + edit` 追加、禁用 `write` 覆盖；只有跨项目通用教训才进全局。纯静态文本插在 canary 之前，前缀缓存零影响。
---

> redmind 品牌名修正（Redmind → RedMind），destructive 授权门补全进程/系统级高危命令——此前只拦文件操作和 git 写操作，`taskkill`/`shutdown` 这类命令会静默执行。

#### 新增

- **redmind 显示名改驼峰式 RedMind**（`agent/agent.ts`、`cli/cmd/tui/component/prompt/index.tsx`、`cli/cmd/tui/component/dialog-agent.tsx`）：输入框和切换 agent 对话框原来走 `Locale.titlecase(name)`，`redmind` 被渲染成 "Redmind"。启用 schema 里本来就有的 `displayName` 字段（此前没有任何 agent 用过），redmind 声明 `displayName: "RedMind"`，显示层统一 `displayName ?? titlecase(name)`，build/plan 等其余 agent 显示不变。

- **火山引擎 Doubao 新增专属提示词**（`session/prompt/doubao.md`、`session/system.ts`）：Doubao-Seed 系列此前落 `default.md` 兜底，那句「不超过 4 行、单词回答最好」会把强模型的输出能力压扁，和 grok 是同款坑（0.8.3 已给 grok 补过）。新增 `doubao.md` 参照 `deepseek.md` 的精炼结构，补全五条铁律、Engineering judgment、Windows GBK 环境事实、Task management、并行工具调用等，且保留 soul 人格房规（语气/称呼/详略不双立法）。匹配走 `providerID` 包含 `"volcengine"` 判断，支持火山方舟所有 Doubao 模型。

- **attention 新增任务栏闪烁提醒**（`cli/cmd/tui/attention.ts`、`cli/cmd/tui/config/tui-schema.ts`、`cli/cmd/tui/config/tui.ts`）：打游戏/离开时不知道 agent 在等权限或任务已完成。Windows 下通知触发（失焦 + 非 subagent）时输出 BEL（`\x07`），配合 Windows Terminal `bellStyle: "taskbar"` 让任务栏图标像微信一样闪烁；BEL 是控制字符不占格子、不干扰 OpenTUI 渲染缓冲，console-hijack 不劫持 stdout 所以通道干净。新增 `attention.bell` 配置开关（默认开，`attention.enabled` 默认仍为关）。
#### 修复

- **destructive 授权门漏掉进程/系统级命令**（`tool/shell.ts`）：破坏性判定原先挂在 `FILES`（文件命令）分支里，只覆盖文件操作 + git 写操作（260730 白名单反向判定），`taskkill`、`Stop-Process`、`shutdown`、`Stop-Computer`、`Restart-Computer`、`Clear-Content`、`reg`、`format`、`format-volume`、`diskpart`、`sc`、`schtasks`、`vssadmin`、`bcdedit` 共 14 个进程/系统级高危命令在 redmind 下会静默执行。判定逻辑拆成独立行（`if (cmd && DESTRUCTIVE.has(cmd)) scan.destructive = true`，不再依赖 FILES 分支），DESTRUCTIVE 表补齐这些命令——`reg`/`sc`/`schtasks`/`vssadmin`/`bcdedit` 有只读用法（query/list/enum），但 agent 极少用它们做只读诊断，整命令进门宁可多问一次。PowerShell/cmd 的命令名已先行小写化，bash 分支不受影响。

- **所有 `.md` 提示词/工具描述在导入时被转成 HTML 送进模型**（`session/system.ts` 等 27 个文件、51 处导入）：Bun 的内置 `.md` loader 把 markdown 转成 HTML，编译产物里存的就是 `` var qI=`<p>You are RedCode, an interactive code agent…` ``。实测 `# Tone and style` → `<h1>Tone and style</h1>`、`- ctrl+p…` → `<li>ctrl+p…</li>`、`` `file_path:line_number` `` → `<code>…</code>`；`anthropic.md` 8197 字节进、8638 字节出。仓库里没注册任何 `.md` loader，是 Bun 默认行为，多半是某次升级后静默变的；`src/markdown.d.ts` 声明的是 `const content: string`，HTML 也是 string，类型检查从不报。**后果**：每份提示词多约 5% 体积的标签，精心调过的 markdown 结构落到模型眼里全是 HTML——之前调提示词排版的工作有一部分是白做的。**修法**：导入处加 `with { type: "text" }`，实测拿到一字节不差的原文。**执行**：按 0.8.3 待办的建议分两步走——先改 `system.ts` 里 15 个 per-model 提示词（anthropic/default/beast/deepseek/gemini/gpt/kimi/mimo/minimax/codex/trinity/glm/grok/step/ollama），验证 typecheck + bun build 产物均拿到原文（8197 字节、无 `<h1>`）后，再推平其余 35 处工具描述导入。全仓 51 处（含 skill/index.ts 原本就带 `with` 的 1 处）无一遗漏。typecheck exit=0，编译产物验证原文。


- **火山引擎 volcengine-ark 手动补 CNY 定价**（`provider/provider.ts`）：火山方舟是国产 provider 且不在 models.dev（纯 config 自定义 provider），`CNY_PRICING` 表里没它 → config 循环 cost 兜底全 0 → 费用恒显示 ¥0.00（stepfun-step-plan 同款坑，0.8.1 修过）。按官方定价补 Doubao-Seed-2.1-turbo（输入 ¥3.00、缓存读 ¥0.60、输出 ¥15.00）和 Doubao-Seed-2.1-pro（¥6.00/¥1.20/¥30.00），cache write 按惯例 = input。国产 provider checklist（历史教训 #62）：新增时必须同步 `CNY_PRICING`（服务端 cost 落库）和显示层币种判断——volcengine 走 `model.cost.currency`（`provider.ts` 设 `currency: "CNY"`），显示层读 cost.currency 不需要另加名单。
---
### [0.8.3] - 2026-07-31

> 0.8.0/0.8.2 为了治 step-3.7-flash 的通道纪律，往每一步注入了一条「可见思考的语言 + 称呼」约束。这一版把它整条撤了——实测它是「模型以为用户一直在催」「把答复写进思考链、不展开根本看不见」「无人发话时反复做无用功」三个现象的共同来源，比它要修的那个偶发 XML 泄漏严重得多。同批还有首页视觉调整。

#### 修复

- **每步注入的思考语言/称呼约束整条撤除**（`session/prompt.ts`）：这条注入是 0.8.0（`b26d09a` 语言约束、`4c5707b` 让它真正生效）和 0.8.2（`63cf56b` 称呼约束）加的，起因是想让 step-3.7-flash 别在思考通道里跑偏。查 `ses_04916ea36ffe`（step-3.7-flash，07-31）实测，三个用户可见的毛病都出自这一条：① 它以 `role: "user"` 注入，**且没有 step 门槛，每一步都注**——对模型来说对话永远停在"用户刚说完话"，于是每步都重新推导用户意图而不是继续干活。最后一条真实用户消息之后的 9 分钟里跑了 154 次工具调用，其中只有 62 个不同：同一个 `redcode.jsonc` 读了 16 次、改了 8 次，同样 4 个 `.md` 各读 4 次。② 称呼约束的原文是「在可见思考文本里同样称呼用户为「X」，**与正文保持一致**；……**从第一句思考开始就这么称呼**」——等于明确要求模型把思考写成正文。通道纪律弱的模型照做了：该会话 93 个 assistant 轮次里只有 5 轮有正文，却有 46 段思考在直接对用户说话，答案产出了、只是从思考通道出去了。③ **开关挂错了地方**：语言约束读 `config.reasoning_language`，称呼约束却只读 `config.username`，而 `username` 是 TUI 标签的显示设置——用户撤掉 `reasoning_language` 之后注入照常，根本关不掉。跨模型对照（同一份注入，07-29 至今）：step-3.7-flash 1075 轮里 11.3% 有正文，deepseek-v4-flash 60 轮里 36.7%（样本小，仅供参考）；而两者「在思考里直呼用户」的频率按每百轮算相当（13.3 vs 10）——说明两个模型都在执行这条指令，差别是 V4-Flash 照做的同时照样回话，step 是用思考代替了回话。**改动是通用的，伤害不是**：它需要一个通道纪律本来就弱的模型才会发作。`session/reasoning-language.ts` 与 `instruction-echo.ts` 的剥离逻辑都保留，历史会话里已经存了大量被复述的 `<reasoning-language>` 块还得继续管；要重新启用得先解决两件事——不占用户回合，且每回合最多注一次。
- **正文称呼接回 `config.username`**（`session/system.ts`）：0.8.2 下线 `USER.md` 时把称呼来源指定为 `config.username`，但当时唯一读它的就是上面那条每步注入。注入撤掉之后 `username` 就此悬空——配置项还在、文档还写着，实际不起任何作用。改为接进 env 块：跟着 `environment()` 走，随 `_caches.system` 一次性缓存，**不占用户回合、不每步重复**（被撤除的那条正是栽在这两点上）。措辞只约束正文并明确写出「不约束思考」——原来那句「与正文保持一致」是把模型推去在思考里回话的直接原因，不能再犯。soul 里其实已经规定了称呼，这里是正文层的兜底：实测 soul 写了「叫哥哥"哥哥"」，正文仍会冒出"确认后再给你结论"。

#### 待办（已定位，未修）

- **所有 `.md` 提示词在导入时被转成 HTML 送进模型**：~~Bun 的内置 `.md` loader 把 markdown 转成 HTML，编译产物里存的就是 `` var qI=`<p>You are RedCode, an interactive code agent…` ``；`anthropic.md` 8197 字节进、8638 字节出；`src/markdown.d.ts` 声明 `const content: string`，HTML 也是 string，类型检查从不报。修法已验证：导入处加 `with { type: "text" }` 拿到一字节不差的原文。当时未修：会让所有模型的系统提示词同时变形，血量太大。~~ **已于 0.8.4 修复**（`94bbd92`）：全仓 51 处导入全部加 `with { type: "text" }`，见 0.8.4 修复节。

#### 变更

- **DeepSeek 提示词从 GLM 共用的精炼档拆出来升档**（`session/prompt/deepseek.md`）：`deepseek.md` 此前与 `glm.md` **除标题外逐字节相同**，两个模型共用一份"准一线精炼档"（37 行），而那份是给 V4-Flash-Preview 那一代写的，通篇是给弱模型的补课式脚手架。V4-Flash 0731 正式版 07-31 上线，agentic 项相对 Preview 跃升很大——Terminal Bench 2.1 `61.8 → 82.7`、DeepSWE `7.3 → 54.4`（七倍）、Toolathlon-Verified `49.7 → 70.3`，多项已贴着 Opus-4.8（`82.7 vs 85.0`、`25.2 vs 25.7`），普遍高于 GLM-5.2，继续按精炼档喂它是低估。参照 `anthropic.md` 重写成 57 行：补上 professional objectivity、engineering judgment（欠明确的请求自己做常规判断并说明假设）、任务完整性、`todowrite` 的时机与粒度、探索类任务委派给 `task` 子代理、并行工具调用、RedCode 自身知识与反馈入口；去掉全大写威胁式的重复措辞。保留 Windows 代码页乱码那条环境事实（模型运行时推断不出来）和"语气/称呼交给 soul"的房规。`glm.md` 未动。
- **思考里的称呼改由稳定系统提示词承载**（`session/system.ts`）：本版撤除每步注入时，连带撤掉了"可见思考里也按设定称呼用户"这个效果。用户实测该效果本身有价值（V4-Flash 上「思考链中文也多了起来，也会叫我哥哥，工作流也很规范」），问题从来不在效果、在承载它的机制，所以加回来但三个致命点一个不留：① 不再占用户回合、不再每步注入，跟正文称呼一起进 env 块随 `_caches.system` 一次性缓存；② 措辞去掉「与正文保持一致」「从第一句思考开始就这么称呼」，改为明确写出「思考是你写给自己的推理过程，不是对他说的话，要说的写进正文回复」——保留称呼、切断"思考=正文"的暗示；③ 触发条件与开关同源，只看 `config.username`。**语言约束（强制中文思考）没有一并加回**：它原本靠"看用户这轮说什么语言"做 auto 判定，而稳定系统提示词的位置按定义不能随轮次变，要重新支持得先决定是只认显式配置还是换个位置。
- **首页视觉**（`cli/cmd/tui/routes/home.tsx`、`component/prompt/index.tsx`、`component/starfield-render.ts`）：logo 与输入框整体放大约 30%，宽屏下不再缩在一片留白里；上下留白从 1:1 改成 5:8，整块内容的视觉重心抬到屏幕约 43%（等分时 logo 正好压在几何中心，观感偏"沉"）；首页输入框空输入时文本区给 2 行而不是 1 行——做成 `Prompt` 的 props 而非改默认值，会话页的输入框该让位给对话内容，只有首页它是画面主体。星空原来全屏一律 3% 密度：宽屏下总量偏少，而且 logo 背后和四角一样密，等于在主体后面撒噪点；改成中心 2.5%、边缘 8.5%，按到中心的归一化距离做 smoothstep 爬升，归一化用相对半宽/半高，所以干净区是跟终端同比例的椭圆、宽屏下自然是扁的，正好贴合 logo + 输入框那一块宽而扁的形状。245×55 终端实测总量 425 → 836 颗，而中心 100×22 那块反而从 65 降到 56。

### [0.8.2] - 2026-07-30

> edit 的 hashline 模式对 CRLF 文件每编辑一次就把行数翻一倍——自 6-10 引入起一直存在，因为对工具自己完全隐形（read 看不见、文件指纹也洗得掉），只有拿外部工具数行才会暴露。同一批还修了 hashline 的另外两个 bug，以及读取侧的编码问题——PowerShell 的 `Get-Content` 和 RedCode 自己的 read/edit 此前都无条件假定 UTF-8。

#### 修复

- **edit hashline 对 CRLF 文件每编辑一次行数翻一倍**（`tool/edit.ts`）：`applyHashlineOps` 只按 `\n` 切行再按 `\n` 拼，CRLF 文件的 `\r` 原样留在行尾，紧接着 `convertToLineEnding` 又做一次 LF→CRLF 转换，行尾就成了 `\r\r\n`。裸 `\r` 在 .NET / `Get-Content` / 编辑器 / 浏览器眼里都算换行，于是每行后面凭空多一个空行。实测 `某项目的 templates/index.html` 三次成功的 hashline 编辑后，6905 行变成 27707 行（≈ 4×6905）。这个损坏对工具自己完全隐形：`read` 和 `applyHashlineOps` 都只按 `\n` 切行，看到的还是 6905 行；`Hash.fileTag` 的 `/[ \t\r]+(?=\n|$)/` 又把多出来的 `\r` 洗掉，tag 也不变，所以 edit 既不报错也不失配。修法是交给 `applyHashlineOps` 前先 `normalizeLineEndings` —— 经典 `oldString/newString` 路径一直是先归一化再转的，只有 hashline 这条漏了。hashline 此前**零测试覆盖**，本次补 7 条（CRLF 单次/连续三次、LF、insert/delete、hash 失配不写盘）。
- **edit hashline 给写入的每一行多加一个前导空格**（`tool/edit.ts`）：`edit.md` 明写 body 行前缀是 `+ `（加号 + 一个空格），但 `readBody` 只 `slice(1)` 切掉加号，那个分隔用的空格被当成内容写进了文件。在有格式化器的语言里被 format 抹平了，所以一直没暴露；`index.html` 里则留下实证——hashline 写过的行是 3 空格缩进，邻居是 2 空格。改为 `/^\+ ?/`，`+foo`（不带空格）也照样接受。
- **edit hashline 同锚点时 insert 会被 delete 吃掉**（`tool/edit.ts`）：op 排序的比较器写成 `a.type === "delete" ? 0 : 1`，对 `(delete, insert)` 和 `(insert, delete)` 不返回相反符号，不满足反对称性，实际顺序全看 `sort` 的实现。`insert after 2` + `delete 3..3` 两条都锚在 idx 3，先插后删删掉的正是刚插进去的那行。改成 `deleteFirst(a) - deleteFirst(b)`。
- **写入侧新增行尾回车膨胀护栏**（`util/bom.ts`、`tool/edit.ts`、`tool/write.ts`）：上面那个 bug 能潜伏一个多月，就因为它绕过了所有既有检查。新增 `Bom.detectCrBloat()`，与 `detectGarbled` 并列接在 edit 三个写入点 + write 一个写入点上，发现新增的 `\r\r\n` 就拒绝写入。只在"新内容比原文多"时拦——否则已经损坏的文件连用 edit 修都修不了。8 条测试。
- **PowerShell 读文件仍按系统代码页解码**（`tool/shell.ts`）：0.7.x 加的 `PS_UTF8` 只把**输出**编码钉成了 UTF-8，读侧一直漏着——Windows PowerShell 5.1 的 `Get-Content` 默认按系统 ANSI 代码页解码，中文 Windows 上读 UTF-8 文件直接读成乱码（本机实测 "中文测试" 读成 "涓枃娴嬭瘯"）。内容在读的那一步就已经毁了，之后不管怎么写回都是在写乱码，写入侧的 `detectGarbled` 护栏也拦不住（PUA/FFFD 占比够不上阈值）。给 `Get-Content`/`Import-Csv`/`Select-String` 补上 `$PSDefaultParameterValues` 的 UTF-8 默认值；实测 `Env:`/`Function:` 等非文件系统 provider 不报错、`-Raw` 正常、显式 `-Encoding` 仍然优先。**写侧故意没动**：5.1 里给 `Set-Content`/`Out-File` 指定 utf8 会强制写 BOM，给 .py/.json/.html 加 BOM 是拿一个 bug 换另一个；写文件本来就该走 write/edit 工具。
- **读取侧编码检测：真 GBK 文件不再读成满屏 `�`**（`util/bom.ts`、`tool/read.ts`）：`Bom.readFile` 此前无条件按 UTF-8 非 fatal 解码，非 UTF-8 的文件读进来全是替换符，模型根本没法干活（靠写入侧 `detectGarbled` 兜住不写回，不算数据丢失，但确实读不了）。新增 `Bom.sniff()`：BOM → 严格 UTF-8 → 才退系统代码页。**检测只能单向做** —— 「严格 UTF-8 解得通 → 就是 UTF-8」可靠，UTF-8 有自校验结构，实测 20000 样本里 5 个汉字往上、GBK 字节凑成合法 UTF-8 的次数为 0；反过来「GBK 解得通 → 是 GBK」毫无价值，GBK 太宽松，8 个汉字的 UTF-8 字节流有 31% 能被它照单全收。判定只看开头 4096 字节，且 `read` 与 `edit` **必须共用同一条规则、同一段采样**：read 产 `[path#TAG]`、edit 用 `Bom.decode` 算 currentHash 校验陈旧度，两边解码方式不一致就会在该类文件上次次 hash mismatch（read 是流式的、拿不到全文，所以规则就定成只看头部）。只看头部同时也更稳：一个 99.99% 是 UTF-8、末尾混进一个坏字节的文件，全文校验会判成 GBK 然后整个解花，头部校验则判 UTF-8、只有那个坏字节退化成 `�`。顺带认了 UTF-16LE/BE 的 BOM——PowerShell 5.1 的 `Out-File`/`>` 默认就写 UTF-16LE，Windows 上并不罕见。
- **配套的转编码护栏**（`util/bom.ts`、`tool/edit.ts`、`tool/write.ts`、`tool/ast_grep.ts`、`tool/apply_patch.ts`）：检测之前，"不许把 GBK 文件写回成 UTF-8"这件事是由 `detectGarbled` 顺带挡着的（GBK 读成 UTF-8 满屏 FFFD、占比 83% 远超阈值，直接拒写）；检测之后文本干净了，那道墙自动失效，不补就成了"悄悄把用户的 GBK 文件转成 UTF-8"。新增 `Bom.detectEncodingChange()`，接在 edit 三个 + write 一个写入点上明确拒绝，ast_grep 的 rewrite 跳过该类文件（与它已有的"超大/语言不认识/解析失败"跳过同一处理方式），apply_patch 的 update 直接报错。**不做反向转换**：`TextEncoder` 只出 UTF-8，仓库里也没有 iconv，我们只有解码能力没有编码能力，所以拒绝而不是假装能转。顺带说明：`ast_grep`/`apply_patch` 此前连 `detectGarbled` 都没接，改之前它们在 GBK 文件上会直接写一堆 FFFD 把文件毁掉，现在至少不动它。
- **提示词/工具说明文字漏进可见正文**（新增 `session/instruction-echo.ts`、`session/processor.ts`）：DCP compress 工具的说明整段进了正文（`Rules:` / `- Do not invent IDs.` / `BATCHING` / `THE FORMAT OF COMPRESS` 加一段 JSON schema）。`xml-tool-call.ts` 管不住它——那边靠 `<function=` 子串触发，这里一个尖括号标签都没有。分两类处理：A 类是我们自己注入的包装块（`<system-reminder>`、`<reasoning-language>`、`[System notice]`），有明确起止、模型复述永远是错的，整块剥掉；B 类是工具说明/JSON schema，没有闭合标签、边界靠猜，只做行级判定，要求连续 3 行以上像 schema 且命中强特征标题才切。宁可漏切不可错切——错切会吃掉真正的回答，比留着泄漏更糟。11 条测试。
- **「刚才用户让我做 xx」——用户其实一个字都没发**（`session/prompt.ts`）：`userReminderText` 的边界写成 `m.info.id > lastFinished.id`，而 `lastFinished` 来自 `MessageV2.latest()`、当前这条 assistant 消息整轮都不算 finished，于是它一直钉在上一轮。结果"开启本轮的那条用户消息"永远满足条件，被当成"中途新到的"每一步重新注入一次——20 步的回合模型会被告知 19 次「用户发话了，请处理」。本意只是捕捉回合**中途**新到的消息，边界改为本轮起点，并对已提醒过的消息去重。与此前查到的 DCP 以 user 角色注入消息是两个独立来源，叠在一起才让现象那么明显。

#### 变更

- **`USER.md` 下线**（`.opencode/redcode.home.jsonc`、`project/bootstrap.ts`、`cli/cmd/tui/context/local.tsx`、删除 `.opencode/agents/USER.template.md`）：这份"用户画像"由 `redcode.jsonc` 的 `instructions` 每轮注入，但内容基本被 `souls/Tsoul.md`、`souls/Gsoul.md` 覆盖了——称呼"哥哥"、语气要求、根因优先、连败两次停手、诚实说做不到，soul 里都写着，等于同一件事说两遍、每轮白吃一道加载。唯一真正只有它有的是 TUI 对话标签上的称呼（`local.tsx` 去解析 `**称呼：**` 这个粗体字段），改读 config 已有的 `username` 字段（缺省退到系统用户名），比解析 markdown 稳。shipped 模板与 live 配置**同时**改——只改 live 的话同步时会被模板反向覆盖回来（0.7.25 vision-mcp、本版 anthropic 块都栽过这个坑）。老用户的 `~/.redcode/USER.md` 不会被删除，只是不再加载。

- **从 `redcode` 命令启动时 provider 全挂**（`packages/core/src/models-dev.ts`）：报的是 `2 of 5 requests failed: Unexpected server error… config.providers, provider.list`，日志里只有一句 `Failed to fetch models.dev`，而双击 exe 却完全正常。根因是取数的三级回落——磁盘缓存 → 编译期内嵌快照 `REDCODE_MODELS_DEV` → 网络：exe 里烤了快照（构建时走代理取的），而 `~/.bun/bin/redcode.cmd` 从源码跑没有快照，磁盘也没缓存，只能落到网络取数；这台机器的代理**只配在 git 里**（`http.proxy`），环境变量一个都没有，于是 `git push` 通、运行时取数直连超时。构建脚本 0.8.1 已经修过同一个问题（`634af25` 配了 git 代理就优先走代理），运行时没跟上。两处改动：① 环境变量没设代理但 git 里配了时，**只给 models.dev 这一个请求**带上该代理（只读 git 配置不修改；不改全局 env，否则会把 Ollama 这类本地 provider 也一起代理掉；Bun 的 fetch 认 `init.proxy`，Node 忽略未知字段等于不生效，行为与改前一致；超时按代理路径的实测放宽到 90 秒）。② 取数失败**不再 `orDie`**——模型目录取不到只降级成空目录，已配好的 provider 照常可用，并打一条说清怎么办的 warning（是否走了代理、怎么设、怎么手动刷缓存）。原先 `orDie` 把网络超时变成 defect，顶层只剩一句无信息的 `Unexpected server error`，跟本版另一条 `ConfigInvalidError` 是同一类毛病：**底层失败被包装成无信息的顶层错误**。

- **`ConfigInvalidError` 不说是哪个键错了**（`packages/core/src/util/error.ts`、`config/parse.ts`）：`NamedError` 的构造函数无条件 `super(name)`，于是 `Error.message` 永远等于错误类名，`data` 里拼好的 message 一个字都到不了日志。实测踩过一次：往两端共用的 `~/.redcode/redcode.jsonc` 里加了一个本端 schema 不认识的键，配置校验失败导致整个 server 起不来（表现是 GUI 上"无法加载会话/列出文件失败/无法重新加载"三连的 `Unexpected server error`），而日志里只有 `ConfigInvalidError: ConfigInvalidError`——文件路径和键名全躺在 `data.issues` 里没人看得见，只能靠"知道自己刚改了什么"才定位到。改为：带了 `message` 字段的 `NamedError` 用它当 `Error.message`（没带的行为不变），`config/parse.ts` 两个抛出点补上 message，未知键的提示里点明"这个键可能来自更新版本的客户端，两端读的是同一份配置"。现在报的是 `~/.redcode/redcode.jsonc: Unrecognized key: xxx. …` 和 `~/.redcode/redcode.jsonc: share: Expected "manual" | "auto" | "disabled", got "nope"`。**背景**：TUI 与 GUI 版本号独立演进却共用同一份全局配置，新版加的键会直接打死旧版的另一端。

- **自动压缩后的续跑提示被模型当成用户发言**（`session/compaction.ts`）：自动压缩结束时会插一条 `role: "user"` 的消息（正文只有 `Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.`），part 上虽然标了 `synthetic`，但**模型看不到这个标记**，读到的就是用户在说"继续"。线上实测（会话 `ses_04e354872ffe…`，07-30 08:44:45 那条注入）之后连着四步思考写的是：「用户说"继续"」→「用户要求继续做下一步」→「用户要求"继续"，说明他认可前面的改动方向」→「用户说"先commit再测"」——最后一句用户一个字都没发过，它先把注入当成用户发言，再顺着编出后续指令。`role` 保持 `user` 不动（对话必须以 user 轮结尾才能续跑，中途插 system 消息各家 provider 支持度不一），改的是文案：① 开头声明"这不是用户发言，用户此刻没有说话"（`[System notice]` 前缀与 `xml-tool-call`/`text-loop-detection` 的注入一致，`instruction-echo` 也按这个前缀剥离复述）；② 带上本轮用户的原始请求做锚点——压缩会把"用户到底要什么"摘没，只剩一句含糊的 continue，模型就从摘要里最显眼的旧状态接着跑；③ 明确"已完成的工作在摘要里，别重头再来"，且默认倾向汇报而非继续。这个现象在 0.8.2 里变明显是因为本版同时修掉了"每步重复注入用户提醒"——那个 bug 过度注入的同时，顺带每步把"用户到底要什么"重新钉了一遍，拿掉之后压缩后的失忆就没有东西兜着了。

- **人民币金额被当美元又乘了一次汇率**（`cli/cmd/tui/feature-plugins/home/footer.tsx`、`packages/app/src/components/session/session-context-metrics.ts`）：显示层用一份硬编码的 `CNY_PROVIDERS` 精确匹配集合判断币种，而 `provider.ts` 的 `CNY_PRICING` 是另一份名单——同一件事在两处各存一份，加 provider 必漏。漏的正是 0.8.1 刚补过定价的 `stepfun-step-plan`：它的 cost 落库时已经是人民币，却因为不在这个集合里被当美元乘了 6.76，库里 `¥7.504382` 显示成 `¥50.73`（实测与截图分毫不差；按阶跃官方定价 1.35/0.27/8.1 独立验算，落库值倍数 1.00，**存的一直是对的，错的只是显示**）。TUI 侧改为直接读 `model.cost.currency`——`provider.ts` 套 `CNY_PRICING` 时本来就写了 `currency: "CNY"`，读它就不会再漏；`currency` 是可选字段，models.dev 来的报价没有它，所以判定是 `=== "CNY"` 才不折算。GUI 侧 `home-stats.tsx` 只拿得到 session、拿不到 model 报价，暂时仍用名单，补上缺的条目并注明 `CNY_PRICING` 增删时必须同步。

- **文本态工具调用的第二种形状没被打捞**（`session/xml-tool-call.ts`）：打捞逻辑的快路径第一行是 `if (!text.includes("<function=")) return`，只认 Qwen/Hermes 式的 `<function=name>` + `<parameter=name>`。07-30 实测 step-3.7-flash 吐的是另一种形状——`<edit><args><filePath>…</filePath></args></edit>`，于是既没打捞也没摘除：原始 XML 原样留在正文里给用户看，本轮零个 tool part 却是 `finish: stop`，表现成"它自己停下来了"（那轮的 part 构成是 `step-start reasoning(778) text(261) step-finish`）。新增第二个识别器，误判防线是双重的——标签名必须是**真实注册的工具名**，且紧跟着必须是 `<args>`；只靠其中一个条件会误伤正文里讨论 XML、粘贴 HTML 片段的情况。参数解析用反向引用 `<(name)>…</>`，因为实测参数值里就带着 `</tr></thead>` 这类标签，靠"闭合标签必须同名"才切得准。两种形状各自扫全文，摘除前排序并跳过重叠区间。6 条测试。

- **`git` 的写操作此前完全不过授权门**（`tool/shell.ts`）：`DESTRUCTIVE` 那张表只收文件操作命令（`rm`/`cp`/`mv`/`chmod` + PowerShell/cmd 的对应项），**`git` 一个字都没有**——于是 `cp` 会弹授权，`git push --force`、`git reset --hard`、`git clean -fd`、`git commit` 反而一路静默执行。07-30 实测：agent 在用户一句话没说的情况下自己 `git commit` 了。这不是"谁点过 always allow"——全局配置没有 `permission` 段、DB 的 permission 表 0 行、该会话的 permission 列为空；根因是 07-25（`05890af`）把 redmind 的 blanket `bash: "ask"` 去掉、改走 `destructive: "ask"` 之后，git 就从这个口子整个漏了出去。改为**白名单反向判定**：只读子命令（`status`/`log`/`diff`/`show`/`rev-parse`/`fetch` 等，`branch` 不带 `-d/-D/-m/-f` 时也算）放行，其余一律进 destructive 门。不用黑名单是因为黑名单漏一个就是静默执行，白名单漏一个只是多问一次。
- **解析不出的命令会绕过整个授权门**（`tool/shell.ts`）：`ask()` 里 `patterns.size === 0` 直接 return，本意是给 `cd` 这类纯导航命令留口子，但 tree-sitter 解析失败时 patterns 同样是空的——于是**任何解析不了的写法都不需要任何授权**。实测 PowerShell 下 `git checkout -- .` 就解析不出命令节点，一路直接执行。改为解析不出命令节点时回退成拿整条原始命令去要授权，并按空白切一遍跑同样的破坏性判定（否则真该拦的命令会因为"解析失败"反而降级成最轻的授权）。

- **可见思考里的称呼**（`session/reasoning-language.ts`、`session/prompt.ts`）：soul 和 per-model 提示词只管住了正文——模型把"人格"理解成输出风格，一进思考通道就退回默认的第三人称，正文喊"哥哥"、思考里写 `The user wants me to...`。修法与 0.8.0 那条语言约束同源：必须显式点明"这条同样约束可见思考文本"，且用命令式措辞。称呼取 `config.username`，与两条语言约束合在同一个 `<reasoning-language>` 块里注入，不多占 user turn。触发条件比语言那条宽——`auto`（判不出用户在说什么语言）时不注入语言约束，但称呼照样注入。`username` 缺省会被 config 填成系统用户名，等于系统用户名时视作没设过，否则会注入"称呼用户为 Administrator"，比不注入更糟。7 条测试。

- **语气交还 soul；新增 `grok.md`**（`session/prompt/*.md`、`session/system.ts`）：语气/称呼/详略本该是 soul 独占的领域，per-model 提示词也立法会让调 soul 时被莫名拽回。从实际在用的 6 份里删掉 `Match the user's language` 与 `Be concise: …` 两类规定，各自保留机制性条款（诚实报告失败、`<system-reminder>` 权威、准确优先于附和）。真正的问题在 `default.md`——第 19 行强制「回答不超过 4 行、单词回答最好」，那才是会碾平人格的规定；但它是所有未匹配模型的兜底，不宜为 grok 单独改，故新增 `grok.md` 并在 `system.ts` 里前置匹配。内容按 xAI **API 文档**核实到的真实特性写（grok-4.5 无法禁用推理、effort 默认 high），没有硬塞泄漏的消费级产品提示词。
- **shipped 模板里也删掉 anthropic 块**（`.opencode/redcode.home.jsonc`）：`~/.redcode/redcode.jsonc` 里删过一次，当天就又出现——根因是这份 shipped 模板还留着同一个块，同步时反向覆盖 live 配置。与 0.7.25 vision-mcp 是同类坑：配置改动往往要同时落在 live 文件和 shipped 模板两处。该块三重无效：apiKey 是占位符、`ANTHROPIC_API_KEY` 未设、唯一模型 `gpt-5-chat-latest` 实测请求 404。

---

### [0.8.1] - 2026-07-29

> 0.8.0 构建产物之后落的一批修复。其中「reasoning 语言约束被 DCP 注入消息挡掉」是 0.8.0 自己引入的功能当天就被证伪——功能在二进制里，但从未生效。

#### 修复

- **reasoning 语言约束整条静默失效**（`session/reasoning-language.ts`、`session/prompt.ts`）：线上实测（会话 `ses_0536c…`）用户说的是「怎么了敏敏」，模型思考却整段英文 `"The user asked 怎么了敏敏…"`，而运行的二进制确实包含 0.8.0 的语言约束。根因是取语言判定来源时直接用了「最后一条 `role==="user"` 的消息」——但 DCP 的压缩通知（`▣ DCP | -148.1K removed…`）同样是 user 角色，只是文本 part 标了 `ignored`。于是流程变成「取到通知 → 过滤掉 ignored 的 part → 只剩空串 → 判为 auto → 不注入」。过滤本身没错，错在选消息。改为从后往前找第一条真的含用户自撰文本的消息，跳过纯注入消息；判定逻辑一并从 `prompt.ts` 的循环体里提到模块中，原先既没测试也没法测，现补 6 条（含照着线上真实消息序列构造的那条）。
- **`stepfun-step-plan` 费用恒为 ¥0.00**（`provider/provider.ts`）：models.dev 里 `step-3.7-flash` 有四个 provider 条目，两个 "Step Plan" 的 `cost` 字段直接是 `null`，而 `CNY_PRICING` 只覆盖了 `stepfun` 一个键。实测近 30 天 `stepfun` 6596 轮累计 ¥286.29、`stepfun-step-plan` 1882 轮累计 ¥0.00，而最近 400 条消息里 351 条走的正是后者——当前全部开销都没被记账。按阶跃官方定价补上（1M tokens：输入未命中 1.35 元、命中 0.27 元、输出 8.1 元）。未补 `stepfun-ai-step-plan`（Global）：海外站按美元计价，套人民币表会把币种搞错，比不显示更糟。

#### 变更

- **`step.md` 补上三条针对实测毛病的约束**（`session/prompt/step.md`）：此前该提示词规则齐整但完全没有覆盖 step 自己的两个高发问题，等于"能用提示词管住却没管"。新增：① 只用原生 tool-call 通道，禁止把 `<tool_call>`/`<function=…>`/`<parameter=…>` 当正文写出来（实测 14 次 XML 泄漏 100% 出自 step）；② 不许把答案留在思考通道里——思考默认折叠，只有思考没有正文的一轮跟崩溃无法区分（step 此类轮次 0.6%，是 deepseek 的 4 倍）；③ "简洁"不等于"不说话"，一句也比零句强（实测 step 平均思考 3553 字、正文仅 144 字）。是代码层兜底（`xml-tool-call.ts` 的打捞与 reasoning-only 纠正）之外的第一道防线，互补而非替代。

#### 性能

- **构建取数配了代理就优先走代理**（`script/generate.ts`）：0.8.0 的做法是先试直连、失败再退代理。但"git 里配了代理"本身就是"这台机器要靠代理出网"的强信号，先试直连只是白等一次超时（本机直连 12 秒无响应，且这是常态）。改为有代理配置就先走代理、不通再退直连；没配代理的机器行为不变。实测构建取数从 24.0 秒降到 4.8 秒，省下的全是等直连超时的时间。

---

### [0.8.0] - 2026-07-29

> 围绕前缀缓存的一批改造，外加可见思考语言约束。设计取自 [DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix) 的 `compact.go` / `reasoning_language.go` / `cache_shape.go`（该项目同为面向 DeepSeek 的 agent，`prefix-shape.ts` 早前也借鉴过它）。

#### 新增

- **可见思考文本的语言约束**（新增 `session/reasoning-language.ts`）：DeepSeek / step 等模型即使面对纯中文提问，`reasoning_content` 也常整段用英文写，界面上"已思考"是英文、正文是中文，割裂得厉害。新增配置 `reasoning_language: "auto" | "zh" | "en"`，默认 `auto`。三处设计都不是随手定的：
  - **命令式措辞**，不是"偏好/建议"。软措辞在"中文提问里嵌了英文日志/代码"时会丢掉**第一个** reasoning 段，而第一段会锚定整轮——provider 会把先前的 reasoning 回传给模型，第一段丢了整轮就回不来。
  - **注入 user turn，不进 system prompt**。这是用户可随时切换的偏好，放进稳定前缀等于每次改设置都打掉整个 prefix cache。
  - **auto 模式保守**：剥掉代码块与 RedCode 自己注入的包装块后再数汉字，英文和拿不准的一律不注入，保持旧行为。
- **逐工具 schema token 成本诊断**（`session/prefix-shape.ts`）：工具 schema 每轮都在前缀里付费，某个 MCP server 挂上来就可能悄悄吃掉几千 token，此前完全不可见。`prefix cache changed` 的日志现在带上 `toolCount` / `toolSchemaTokens`，并在 tools 确实变化时列出最贵的 5 个工具。逐工具成本只在 tools 变了时才算，不是每轮都序列化。

#### 变更

- **压缩改为分级，廉价手段先上**（`session/overflow.ts`、`session/compaction.ts`、`session/prompt.ts`）：原先是单一二值判定——没溢出什么都不做，一溢出就直接摘要压缩。但摘要压缩是**前缀缓存重置点**：重写历史、打掉整个 prefix cache，还要付一次模型调用，单阈值意味着它总是来得突然且已无便宜手段可用。现在分三档（比例相对 `usable()`，即扣掉输出预留之后的可用窗口）：
  - `soft`(0.6) — 只记一条提示，**刻意不做任何重写**，在这里动前缀是白白炸掉缓存
  - `prune`(0.8) — 裁剪陈旧工具输出，纯本地改写，不花钱不调模型
  - `compact` — 真正的摘要压缩，**触发点与改造前完全一致**（`count >= usable`），刻意不动，避免改变既有压缩时机
- **prune 先于 summarize**（`session/prompt.ts`、`session/compaction.ts`）：压缩触发时先裁剪陈旧工具输出，若光这一步就把用量压回阈值以下，则**跳过这一轮付费的 summarize 调用**——省一次模型调用，也少一次缓存重置。溢出（模型被上下文顶断）时不做此判断，那种情况必须真压。`compaction.prune` 相应从返回 `void` 改为返回 `{ tokens, parts }`。

#### 修复

- **GLM-5.2 支持推理强度却看不到档位**（`provider/transform.ts`）：`variants()` 里有一张硬编码排除表，整个 `glm` 家族无差别返回空变体，页脚因此没有任何档位可选。按智谱官方「核心参数说明」，`thinking.type` 是 GLM-4.5 及以上都有的二值开关，而 `reasoning_effort` **自 GLM-5.2 起支持**——排除对 5.1 及以下成立，对 5.2 已经过时。现在按版本号判定（`glm-5-turbo`/`glm-5v-turbo` 都是 5.0，不算；`glm-5.3`/`glm-6` 自动跟上）。档位只暴露 `none`/`high`/`max` 三档：官方 7 个取值里 `none`+`minimal`、`low`+`medium`→`high`、`xhigh`→`max` 互为别名，全摆出来等于骗人——用户选 `low` 实际吃到的是 `high`。`max` 是官方默认值，因此不选变体时的行为即等于 `max`。
- **grok-4.5 / kimi-k3 同样支持推理强度却没有档位**（`provider/transform.ts`）：与 GLM 同一张排除表的问题。依据两家官方文档——xAI：grok-4.5 支持 `reasoning_effort`，取值 `low`/`medium`/`high`，默认 `high`，**无法禁用推理**（故不提供 `none` 档）；Moonshot：K3 始终开启思考，取值 `low`/`high`/`max`，默认 `max`。两者档位集合不同（一个有 `medium`、一个有 `max`），各用各的表。均按版本号判定：`grok-3-mini` 保持原有分支不受影响，`grok-4`/`4.2`/`4.3` 与 `kimi-k2` 系列继续无档位，更高版本自动跟上。
  经会话库验证聚合层确实转发该参数：`opencode-go/deepseek-v4-flash` 三档的平均 reasoning token 为 default 133 / high 202 / max 311，单调递增，样本 4608 轮——同一条聚合路径上参数生效，不是摆设。
- **GLM 挂在聚合供应商下时拿不到 `thinking` 参数**（`provider/transform.ts`）：注入条件原先只认 `providerID` 含 `zai`/`zhipuai`，但同一个 GLM 也可能挂在别的聚合商下（如 `opencode-go/glm-5.2`），那条路径既无档位又无 `thinking`，完全靠上游默认值。判据改为按模型本身识别，原有 zai/zhipuai 路径不变。
- **构建时 models.dev 拉不动，每次都退到过期缓存**（`script/generate.ts`）：0.7.39 加的缓存回退虽然让构建不再直接失败，但每次都刷一屏 stale 警告，治标不治本。根因是 git 有自己的 `http.proxy` 配置而 bun 的 `fetch` 只认 `HTTPS_PROXY` 环境变量——同一台机器上 push 能通、build 不通，而指望每次构建都记得 `set HTTPS_PROXY` 并不现实。现在直连失败后自动读取 `git config --get https.proxy`（回退 `http.proxy`）并用 bun fetch 的 `proxy` 选项重试；只读不写，不碰用户的 git 配置。同时给两次请求都加了 90 秒超时——代理路径实测拉这 1.2MB 要 20 秒上下，超时太短会半路断掉又白白退回缓存。缓存回退与那三个不回退的条件（自定义源 / CI / 无缓存）保持不变，作为最后一道防线。
- **`isMimoModel` 裸取 `model.api.id` 会抛**（`provider/transform.ts`）：`model.api` 并非在所有构造路径上都存在，而它经由 `maxOutputTokens` → `overflow.usable` → `isOverflow` 位于压缩判定的主路径上，抛在这里等于整条压缩链断掉。加空值保护并回退到 `model.id`。`compaction.test.ts` 里 8 条 `isOverflow` 用例长期失败的原因就是这个，不是断言写错——该文件从 23 pass / 28 fail 变为 31 pass / 20 fail。

---

### [0.7.39] - 2026-07-28

> 两处授权绕过 + PowerShell 中文乱码 + 三处性能热点；CI 自 fork 起从未真正运行，本次修复并收敛到 Windows。

#### 安全

- **跨盘路径被判成"在项目内"**（`core/filesystem.ts`、`opencode/util/filesystem.ts`）：Windows 上 `path.relative` 在两侧不同盘时返回的是目标的绝对路径，而绝对路径不以 `..` 开头，于是 `contains("E:\proj", "C:\Windows\win.ini")` 返回 true。项目只要不在系统盘，另一个盘上的任何路径都被当成项目内部，`external_directory` 授权永远不会触发。`contains`/`overlaps` 改为先比较盘符根（大小写不敏感），不同直接判否。自 fork 点从上游继承，单盘机器上不会暴露。
- **无条件信任项目父目录**（`project/instance-context.ts`）：`containsPath` 除 directory/worktree 外还信任 `dirname(worktree)`，等于把整个父目录划进项目内——repo 在 `C:\Users\you\project` 就静默信任整个 `C:\Users\you`（`.ssh`/`.aws` 都在里面），且因判定为"项目内"而完全不触发授权提示。改为显式白名单，用现成的 `permission.external_directory` 规则表配置。

#### 修复

- **PowerShell 5.1 输出被按 UTF-8 解码**（`tool/shell.ts`）：子进程输出用 `Stream.decodeText`（UTF-8）解，而 Windows PowerShell 默认按系统 ANSI 代码页写 stdout/stderr——中文 Windows 上是 GBK(936)。任何带中文的命令输出和 PowerShell 自身报错进到工具输出全是乱码。`-Command` 前置 `[Console]::OutputEncoding` 与 `$OutputEncoding` 赋值。
- **JSON 解析失败变成 defect 打死会话**（`core/filesystem.ts`）：`readJson` 用裸 `JSON.parse`，语法错误抛出的是 defect 而非 typed error，调用方的 `Effect.catch` 兜不住——`models-dev.ts` 的降级路径形同虚设，defect 一路炸到 HTTP 中间件变成 `UnknownError`。用户的 `~/.redcode/cache/models.json` 坏一个字节就会每次对话直接死。改用 `Effect.try` 包装。
- **`cd`/`cat`/`dir` 被当成破坏性命令**（`tool/shell.ts`）：`FILES`/`CMD_FILES` 回答的是"命令带不带路径参数"（驱动 external_directory 扫描），被直接复用为破坏性判定，导致纯导航和只读命令弹最重的那档授权。拆出独立的 `DESTRUCTIVE` 表。
- **输出被 token 上限截断时无提示**（TUI 消息页脚、`cli/cmd/run`）：`finish="length"` 与 `"stop"` 走同一条路，被砍断的回复在界面上和正常说完完全一样。页脚加 warning 色标记，`redcode run` 发 system 提示。
- **工具调用被写成 XML 文本，整轮白跑**（新增 `session/xml-tool-call.ts`，接在 `session/processor.ts`、`session/prompt.ts`）：模型偶发不走原生 tool_calls 通道，改把 `<tool_call><function=名字><parameter=键>值</parameter></function></tool_call>` 当普通正文吐出来。这种调用永远不会被执行，用户只看到一坨标签，本轮无任何效果。现在在 part 收尾时认出并从可见正文里摘掉，把解析结果回灌给模型强制续跑一轮，让它用原生通道重发；最多纠正 2 次，仍不改则留一句可见说明收尾。只认本 step 真实注册的工具名，避免把讨论/日志里出现的同款标签误摘。不直接执行打捞出的调用——默认 ai-sdk 运行时里工具由 `streamText` 内部执行，凭空合成 tool-call 事件会造出永不 settle 的 running part 并绕过 `permission.ask`。
- **整轮只产出思考、正文为空**（`session/prompt.ts`）：同一个根因的另一面——模型该切正文通道时继续往 `reasoning_content` 里吐，界面上表现为空回复，和被打断/卡死完全无法区分（内容其实在折叠的"已思考"里）。现在检测到"有思考、无正文、无工具调用"时先纠正一次，仍然为空则把思考内容提升成可见正文，不再让用户对着空白猜。

  以上两条以 `~/.redcode/data/redcode.db` 近 14 天实测定位（运行时日志不含原始流内容，只能查 DB）：XML 泄漏 14 次 100% 出自 `step-3.7-flash`，同期 `deepseek-v4-flash`(4608 条)、`gpt-5.6-luna`(902 条)、`kimi-k3`(103 条) 均为 0；泄漏落 reasoning part 还是 text part 纯看模型断在哪个通道（6/14 vs 8/14）。"只有思考"轮次 step 约 0.6%、deepseek 0.15%、luna 0%。两条修复都不依赖对成因的假设，因此不限定模型生效。

  一并评估过给 step 系压低采样温度（`provider/transform.ts` 的 `temperature()` 原本返回 `undefined`，用服务端默认），**已放弃**：模型吐 Hermes 式 XML 是回退到另一套训练分布，那个模式在部分上下文里本身就是高概率，降温未必压得住；而 0.3 对 code agent 足够激进，会推高退化重复的风险——拿一个没验证的缓解手段去换一个已有 n-gram 检测器在对付的风险，不划算。

#### 性能

- **`@` 文件补全每敲一个键全仓扫描一次**（`file/index.ts`）：`ensure()` 在 await 完 `Effect.cached` 后立刻重建它，缓存只能命中一次，等于每次按键都跑完整 `rg --files`（无 maxDepth/无条数上限）再重建祖先目录表。改为按实例的 TTL 缓存 + 信号量串行化。
- **`read` 为 4 个字符的 tag 把整个文件读进内存**（`tool/read.ts`）：流式读取刚做完 50KB 截断，紧接着又全量读一遍算 `fileTag`。改为流式增量哈希，摘要不变、内存有界。
- **`grep` 把全部命中收进内存后才截断到 100 条**（`tool/grep.ts`、`file/ripgrep.ts`）：无 limit 全量 `runCollect`，且在截断前先对所有命中路径 stat 排序。加上限并在超限时提示收窄 pattern。

#### 构建

- **CI 自 fork 起从未真正运行**：`runs-on` 指向上游的第三方 runner 服务 blacksmith，本仓无对应账号，job 一直排队到 24 小时上限被掐；07-20 加入的 gitleaks 因 action commit 不存在而 3 秒失败，才让整个 run 开始显红。换成 GitHub 托管 runner 并重钉 gitleaks。
- **CI 收敛到 Windows**：本 fork 只面向 Windows 10/11，`test`/`typecheck` 砍掉 Linux 半边；清掉 23 个上游遗留 workflow（发行渠道、文档站、社区机器人、beta 频道、自动生成提交）。其中 `publish.yml` 的构建 job 全带 `if: github.repository == 'anomalyco/opencode'`，在本仓恒为 false，本仓至今 0 个 release。
- **models.dev 连不上就整个构建失败**（`script/generate.ts`）：build 时裸 `fetch("https://models.dev/api.json")`，把快照烤进二进制。国内直连该域名无响应（实测 12s 超时），而 git 的 `http.proxy` 配置对 bun 的 `fetch` 无效——它只认 `HTTPS_PROXY`/`HTTP_PROXY` 环境变量，于是只给 git 配过代理的机器上 push 能通、build 必挂，报错 `ConnectionRefused` 完全看不出是代理问题。现在 fetch 失败时回退到本地缓存 `~/.redcode/cache/models.json`，**并打显眼 warning**（含缓存年龄）——悄悄用过期快照等于悄悄发布带旧定价/旧上下文上限/旧能力位的版本。回退只在「默认源 + 非 CI + 缓存存在」三条同时成立时发生：设了 `REDCODE_MODELS_URL` 不回退（缓存属于另一个源），CI 里不回退（发版构建不许静默用陈旧数据），无缓存则报错并提示 `HTTPS_PROXY` 与 `MODELS_DEV_API_JSON` 两条出路。

#### 诊断

- **Windows 上的命令超时从未被测到**（`test/tool/shell.test.ts`）：三个 abort 用例写的是 `echo started && sleep 60`，`&&` 在 Windows PowerShell 5.1 里是语法错误，命令直接解析失败，超时机制零覆盖。改用 `;` 后确认机制本身正常。
- **测试基线**：`test/tool`+`test/file`+`test/util` 失败数 38 → 3。除上述修复外，重录了停在 fork 点的 tool parameters 快照（4 次有意变更未跟进），并让 `apply_patch`/`skill` 用例跟上两处 fork 行为改动。

---

### [0.7.38] - 2026-07-27

> LLM 延迟排查结案 + 清理 TEMP 诊断代码 + profile 权限合并修复。

#### 新增

- **`llm.setup` 计时日志**（`session/llm.ts`）：每次 LLM 请求记录 resolve 和 prep 阶段耗时到 `~/.redcode/data/log/*.log`，用于区分本地管线延迟与服务端延迟。实测 resolve 1-35ms、prep 1-11ms，瓶颈确认在 provider 服务端。

#### 修复

- **Profile 覆盖时权限重复合并**（`agent/agent.ts`）：YAML profile 覆盖已有 agent 时，旧代码把 `defaults` 和 `user` 重复 merge 而非在 `existing.permission` 上叠加，导致权限规则顺序错乱。改为 `Permission.merge(existing.permission, profilePerms)`。

#### 变更

- **清理 TEMP 诊断代码**：删除 `session/diag.ts`，移除 `prompt.ts` 的 evloop 漂移探针、`message-v2.ts` 的 toModelMessagesEffect 耗时探针、`tools.ts` 的 Diag.toolStart/End 调用——LLM 延迟排查已结案，不再需要。

---

### [0.7.37] - 2026-07-25

> 中文 IME 括号自动跳入内部 + doom_loop 放宽到仅报错触发 + guardrail 工具分类与工作流规范更新。

#### 修复

- **中文 IME 自动闭合括号光标定位**（`prompt/index.tsx`）：onKeyDown 记录预期闭括号，onContentChange 检测 `value.endsWith(expectedClose)` 后 `moveCursorLeft()`，不额外插入字符。覆盖 `（）【】《》「」「"”’`。
- **doom_loop 放宽到仅工具报错触发**（`processor.ts`）：exactLoop 和 cycleLoop 均加 `.some()` 要求至少一个工具 `status === "error"` 才触发，正常完成的工具不再误拦。

#### 其他

- **guardrail 工具分类更新**（`guardrail-profiles/SKILL.md`）：明确"连续失败=工具 status error"不是连续工具调用；read/glob/grep/env 调高风险感知；各类工具放行。

---

### [0.7.36] - 2026-07-24

> 0.7.35 修完 edit.ts 那批之后，同一份 RedMon 文件又在完全不同的地方卡死——这次没有 evloop drift 报警，因为卡的不是 CPU，是一个没设超时的子进程 spawn。

#### 修复

- **格式化子进程加超时**（`format/index.ts`）：编辑后调用外部格式化程序（prettier/biome 等）的 `appProcess.run()` 之前完全没有超时,格式化程序在超大文件上卡住/异常慢时整个回合无限期挂起,且不会触发 evloop drift 诊断（事件循环本身没被占用,只是 await 永远不 resolve,这是跟 0.7.35 那批 CPU 型卡死不一样的信号）。加了 30 秒超时,复用已有的 `Effect.catch` 容错路径。`git/index.ts`/`worktree/index.ts`/`snapshot/index.ts`/`installation/index.ts` 有同样的缺口,这次只修了实际撞上的这一个。

### [0.7.35] - 2026-07-24

> 补上 0.7.34 那批修复漏掉的 5 个 replacer + 一个 pid 校验加固,顺带输入框括号自动补全。

#### 修复

- **`edit.ts` 剩余 5 个 replacer 补行数上限**（`LineTrimmedReplacer`/`WhitespaceNormalizedReplacer`/`IndentationFlexibleReplacer`/`EscapeNormalizedReplacer`/`TrimmedBoundaryReplacer`）：跟 0.7.34 修的 `fuzzyFindBestMatch`/`BlockAnchorReplacer` 同一类风险（不调用 levenshtein，风险更低，但对大文件仍是无上限的逐行扫描），统一按 3000 行封顶,不等第四次真出事故再补。
- **`ContextAwareReplacer` 补行数上限**：0.7.34 那批修复漏掉的兄弟函数,结构跟 `BlockAnchorReplacer` 一样但没上限——同一份 RedMon `data/species.json` 又把事件循环卡死了 18.7 分钟（`blockedMs=1123864`）,现已按同样模式加 `CONTEXT_AWARE_MAX_CONTENT_LINES=3000` 修复。
- **杀进程前拒绝退化 pid**（`core/cross-spawn-spawner.ts`、`desktop/main/server.ts`）：`taskkill`/`process.kill` 之前加校验,拒绝 `undefined`/`≤1`/调用者自己的 pid——Unix 侧原本把 `-pid` 传给 `process.kill` 做进程组广播,pid≤1 时会变成"杀自己的组"或"广播给调用者有权限信号的所有进程"。

#### 新增

- **输入框内 `(` 自动补全**（`cli/cmd/tui/component/prompt/index.tsx`）：光标处输入 `(` 自动补全成 `()` 并把光标留在括号中间。

### [0.7.34] - 2026-07-22

> 两处修复:大文件编辑时精确匹配失败会掉进不设上限的模糊匹配兜底,阻塞单线程事件循环数分钟、键盘UI全无响应;canary 防注入标记措辞太像"给你用的信息",导致模型往自己的 memory 日志写会话总结时引用它而被误杀会话。

#### 修复

- **大文件编辑触发模糊匹配无限放大,冻结整个进程**(`tool/edit.ts`):`fuzzyFindBestMatch`(exact match 失败时的诊断兜底,用来提示"最相似的位置在哪")对文件大小没有任何上限,对目标文件的每一行都跑一次滑动窗口 + Levenshtein 编辑距离计算,复杂度约 `文件行数 × 搜索块大小²`。真机复现:Build 模式对 RedMon `data/species.json`(24666 行、506KB)做一次编辑,exact match 未命中掉进这条兜底,把单线程事件循环锁死约 6.5 分钟(日志里消息流在某一刻停止,下一条日志时间戳相差 391257ms,期间无任何输出,esc/输入全无响应)。定位靠已有的 `TEMP DIAG evloop drift` 探针 + 这段日志时间差,不是靠猜。`BlockAnchorReplacer`(真正参与匹配、非仅诊断)有同类风险:JSON 文件里 `},` 这类锚点行过于常见时,候选块能炸到几百个,每个还要逐行跑 Levenshtein。修法:两处都加了熔断上限——文件超过 3000 行跳过模糊匹配兜底(退化为普通"未找到"报错),候选块超过 50 个直接放弃打分,两个兜底都只是"锦上添花"的诊断辅助、不影响匹配正确性,牺牲提示精度换来不锁死整个进程完全值得。真机对着实际的 `species.json` 验证过:原本会挂的路径现在 0.8ms 返回;另外测过小文件场景确认模糊匹配没有回归。
- **canary 防注入标记措辞太像正常信息,导致会话被误杀**(`session/prompt.ts`、`session/canary.ts`):注入系统提示词的那行写的是 `Session marker: RC-<hex>`,紧挨着上一行 `Today's date: <date>`,措辞、格式跟"给你用的信息"一模一样。真机复现两次:RedMind 往自己的 memory 日志写会话总结时,很自然地把这个"Session marker"当成合理的会话标识拿来当标题引用,撞上了纯字符串匹配的泄露检测,会话被强制终止——不是真的泄露了什么,只是模型把一句"看起来像信息"的话当信息用了。修法:改成明确的"绝不能展示/记录/复述/以任何方式包含这个值"指令,检测机制本身(纯子串匹配)未变。这样应该能大幅减少误伤,而且如果真有内容"无视了这条明确指令"还是复述出来,反而是比之前更强的信号。

### [0.7.33] - 2026-07-22

> 两处根因修复：`bun run dev` 下本地 MCP 的 `$REDCODE_ROOT` 会展开成当前打开的项目目录而不是 RedCode 自身安装根，导致依赖它的本地 MCP 全部连接失败；项目 id 解析失败时全部共享同一个 `global` sentinel 行，导致工作区列表里的项目会被后打开的另一个项目静默挤掉。

#### 修复

- **本地 MCP 因 `$REDCODE_ROOT` 解析错误而连接失败**（`mcp/index.ts`）：`findRedcodeRoot()` 只从 `process.execPath` 向上找安装根，`bun run dev` 下 execPath 是 `bun.exe`，永远找不到，于是静默回退到 `InstanceState.directory`（当前打开的目标项目，而非 RedCode 自身）。配了 `cwd: "$REDCODE_ROOT"` + 相对路径命令的本地 MCP（如内置的进程管理、SQLite 查询等）因此在错误目录里找不到脚本文件，报 `Module not found` / `MCP error -32000`。之前配置整体解析不了（见下条）时这个 bug 一直被掩盖，配置修好后才第一次暴露。修法：找不到时追加一次基于 `import.meta.dirname`（源码文件自身位置）的向上查找，编译产物场景下这是虚拟 bunfs 路径、安全地查不到、不影响原有分支。
- **项目 id 解析失败时共享同一个 `global` 行，工作区列表互相挤掉**（`project/project.ts`）：`Project.fromDirectory` 在"找到 git 仓库但算不出内容哈希 id"的几种情况下（没有 git 二进制、`git rev-parse --git-common-dir` 失败、还没有根提交——比如 rollback/reset 过程中）统一落到 `ProjectID.global` 这个唯一 sentinel。`ProjectTable` upsert 以 id 为冲突键，所有命中这个兜底的目录共享一行，谁最后打开谁的 `worktree` 就把上一个目录挤没了，表现为"项目从工作区选择器里消失"。真机复现：给该函数临时加调试日志（已撤销）定位到具体分支，并在测试过程中亲眼抓到共享行被另一个无关目录实时覆写。修法：改成按目录绝对路径算一个稳定的 fallback id，让每个解析失败的目录有自己独立的行，不再互相踢；同时把已有的"global → 真实 id 时迁移会话"逻辑，扩展到覆盖新的 path-fallback id，避免会话散落。真正意义上"完全没有 `.git`"的分支不变，继续用字面量 `global`（`file/index.ts` 里 HOME 目录的专属语义依赖这个）。

### [0.7.32] - 2026-07-21

> 新增 RedMind agent 模式——心有 Red 行前先问（bash 操作弹框确认），日常读写自动放行。README 中英文版重构：替换 hero 图为启动截图，新增与上游 OpenCode 的对照表。权限审计完成，bash 列为高危权限。

#### 新功能

- **RedMind agent 模式**（`agent/agent.ts`）：介于 build（权限全放）与 plan（只能写计划）之间的折中模式。常规操作（read/edit/grep/glob/webfetch/websearch）自动执行，bash 等系统命令弹框征询同意后再执行。
- **`default_agent` 配置生效**：用户 `~/.redcode/redcode.jsonc` 设 `default_agent: "redmind"` 后新会话默认使用 RedMind。

#### 文档

- **README 重构**（`README.md` / `README.en.md`）：替换启动截图为 hero 大图（`docs/assets/screenshot.png`），新增"为什么是 RedCode？"对照表突出 97%+ 缓存命中率、DeepSeek 计价修复、中文体验、稳定性、国产模型适配。
- **权限审计**：审查全部 16 个权限项，`bash` 列为唯一高危全放权限，`external_directory` / `repo_clone` 已有封锁无需额外处理。

### [0.7.31] - 2026-07-20

> 永久移除 FreeLLMAPI 供应商 + Anthropic URL 修正 + workspace selector 支持外部新目录 + 模板安全加固。（发布次日修复：selector 重构引入的冷启动渲染回归、路径输入不支持粘贴，见下方修复条目。）

#### 新功能

- **Workspace selector 支持打开新项目目录**（`cli/project-selector.ts`）：列表底部新增"Open a different directory..."选项，选中后进入路径输入模式，Enter 确认 Esc 返回，支持启动 RedCode 于任意未注册的工作目录。
- **RedCode 注册到 PATH**：创建 `~/.bun/bin/redcode.cmd` 批处理入口，任意终端输入 `redcode` 即从当前目录启动。

#### 修复

- **FreeLLMAPI 反复重现**（`.opencode/redcode.home.jsonc`、`~/.redcode/redcode.jsonc`）：根因是 `merge-home-config.ts`（`sync-home.bat` → `build.bat` 调用链）每次合并模板时，因 FreeLLMAPI 曾在 `redcode.home.jsonc` 模板中存在，用户手动删除后模板又会补回（`deepMergeUserWins` 的"用户没有的键就加"逻辑）。修法：从模板彻底移除 `opencode` provider 段，用户配置中删除并加入 `disabled_providers` 双重保险。
- **Anthropic 供应商 URL 缺 `/v1`**（`.opencode/redcode.home.jsonc`、`~/.redcode/redcode.jsonc`）：`baseURL` 从 `https://api.chhlink.xyz` 补为 `https://api.chhlink.xyz/v1`，模型从 `claude-sonnet-4-20250514` 更正为 `gpt-5-chat-latest`（实为 Codex GPT 模型代理）。
- **编译版 exe 冷启动（Explorer 双击 / 全新终端窗口）下文字不可见，中文尤甚**（`cli/project-selector.ts`）：根因是 workspace selector 这次改动里，`render()` 把手动拼接的 `content += ... + "\n"` 换成了 `buf: string[]` 数组 + `buf.join("\n")`——`join` 不会在最后一个元素后面补分隔符，导致新版本比旧版本**少了一个末尾换行**。这直接影响紧接着的 `renderedLines = content.split("\n").length`：每次少算一行，选择器每次重绘、以及退出时用 `"\x1b[" + renderedLines + "A\x1b[J"` 收尾的光标回退量都跟着错位一格，把一个位置错误的光标状态交给了紧接着启动的主 TUI，赶上它自己的终端能力探测（`capabilities.unicode`/`rgb`/`explicit_width`）跟这个错位的光标产生冲突，导致探测失败、宽字符/默认色文字整体画不出来——中文首当其冲，因为宽字符对光标列位置最敏感。通过逐段二分（0.7.30 baseline 上只叠加本文件改动 → 复现；只叠 stdin 排空 → 不解决；再叠这个末尾换行 → 问题消失）精确定位，非猜测。修法：`const content = buf.join("\n") + "\n"`，一个字符。用已开着的终端敲 `redcode` 命令不受影响，因为那条路径从不冷启动。`cleanup()` 里的 stdin 排空作为防御性加固保留，但确认不是本问题根因。**同时移除**之前基于"能力协商随机失败"这个错误猜测加的三个强制开关（`win32ForceTerminalCapabilities()`：`OPENTUI_FORCE_WCWIDTH`/`OPENTUI_FORCE_EXPLICIT_WIDTH`/`COLORTERM`）——对照测试证明它们不是中性兜底而是有害：同样带换行修复的构建，无强制开关正常、带强制开关复现渲染损坏；且手动单测 `OPENTUI_FORCE_EXPLICIT_WIDTH=1` 时 logo 整个消失，强制 CPR 显式宽度测量在冷启动控制台上本身就是不可靠路径，强制开启反而制造了它想防的问题。教训记录在案：症状驱动的"修复"在真根因找到后必须重新验证是否该保留，而不是默认叠着。opentui 本身与此问题无关（已验证），跟下面的版本升级是两件独立的事。
- **Workspace 路径输入模式不支持粘贴**（`cli/project-selector.ts`）：新增的"Open a different directory..."路径输入框，`stdin` 的 `data` 事件里粘贴内容是作为一整块（`key.length > 1`）到达的，而输入判断写的是 `key.length === 1`，导致粘贴的路径被原样丢弃、只能逐字手敲。修法：改成只要不是转义序列开头就按可打印内容处理（过滤掉控制字符），单字符键入和整段粘贴统一走这条路径。修复后已用 ConPTY 驱动编译版 exe 做过端到端验证：冷启动 → 列表导航 → 进入路径输入 → 整段粘贴回显 → 确认后主 TUI 于目标目录启动，全链路通过。

#### 已评估、延后

- **opentui 0.2.15 → 0.4.3 升级**：`@opencode-ai/plugin`（第三方 auth 插件带入的传递依赖）已经要求 `@opentui/core >= 0.4.3`，版本长期不对齐有重演 [0.7.8] 那次"同一个包不同 content-addressable hash 导致 TS `#private` 字段类型不兼容"的风险，值得做。也顺带评估了把 `build.ts` 里 tree-sitter worker 的嵌入方式改成跟上游 anomalyco/opencode 一致的做法（不把 `parser.worker.js` 真实路径塞进 `Bun.build` 的 `entrypoints`，改成 `Bun.file(...).text()` 读成字符串后以虚拟文件名通过 `files` 选项嵌入——原写法在 opentui >=0.4.5 上会撞见一个已知未修复的编译产物崩溃，[anomalyco/opentui#1275](https://github.com/anomalyco/opentui/issues/1275)）。**这次没有落地**：当时升级后重测冷启动仍复现渲染问题，一度归因为"无法排除 0.4.3 重新引入时序敏感性"——事后查明那次测试构建里还带着后来被证明有害并已移除的三个强制环境变量（见上方冷启动修复条目），失败大概率是它们造成的，与 0.4.3 本身无关。但 0.4.3 至今没有在"无强制开关"的干净状态下重测过，因此维持 0.2.15 不动，留待有完整测试窗口时单独升级验证；升级路径、`build.ts` 改造方案、#1275 规避方法均已调研完毕，下次可直接执行。

#### 安全

- **模板凭证清理**（`.opencode/redcode.home.jsonc`）：移除公仓模板中的真实 API key，替换为占位符 `sk-your-key-here`。私有配置 `~/.redcode/redcode.jsonc` 保留真实 key，sync 机制不受影响。
- **Gitleaks 秘密扫描接入 CI**（`.github/workflows/test.yml`）：新增 `gitleaks` job，每次 push/PR 自动检测密钥泄露，避免凭证误提交公仓。

#### 优化

- **模型能力标记**（`session/system.ts`）：DeepSeek V4 Flash/Pro 补充 `tool_call+reasoning+temperature` 标记、上下文窗口对齐 1M；Step 3.7 Flash 补充 `tool_call+temperature`、上下文窗口对齐 256K。
- **Compaction 阈值提升**：`compaction.threshold` 从 150000 → 400000，适配 1M 上下文窗口，减少不必要的压缩。
- **Today's date 位置优化**（`session/prompt.ts`、`session/system.ts`）：date 从缓存的 `<env>` 头部移至每次刷新的小段尾部，减少 provider prefix cache 每日失效开销。

---
### [0.7.30] - 2026-07-17

> GUI session list 跨 project 显示——不传 scope 时有 directory 就走 listGlobal，不限 project_id。

#### 修复

- **GUI 其他项目会话显示为空**（`session/session.ts`）：`Session.list()` 在不传 scope 时强制加 `project_id` 条件，GUI 的 `loadSessions` 只传 directory 不传 scope，其他项目的 session 被 project_id 过滤排掉。修法：scope 未指定且有 directory 时走 `listGlobal`，直接按 directory 过滤，不限制 project_id。
- **ai-sdk.ts raw cache tokens 累积保护**（`session/llm/ai-sdk.ts`）：DeepSeek 返回的 `prompt_cache_hit_tokens` 可能是累积 KV-cache 大小而非单次请求值，加 `safeDeepSeekCacheRead` 兜底过滤。`prompt_cache_miss_tokens` 同理。
- **transform.ts mistral typo**（`provider/transform.ts`）：`toLocaleLowerCase` → `toLowerCase`。
- **v2 session handler middleware**（`server/routes/.../v2/session.ts`）：添加 `InstanceContextMiddleware` + `WorkspaceRoutingMiddleware`，directory fallback 从路由上下文读取。

---
### [0.7.29] - 2026-07-17

> 事件钩子系统类型修复——stash 中的钩子代码（compact.post、session.start/end、user.prompt.submit、session.stop、tool.execute 三阶段）通过 typecheck。

#### 修复

- **`Effect.catchAll` → `Effect.catch`**（`session/compaction.ts`、`session/prompt.ts`、`session/session.ts`、`session/tools.ts`）：Effect v4 beta 移除了 `catchAll`，统一改用 `Effect.catch`，涉及 8 个调用点。
- **钩子函数泄漏 Plugin.Service**（`session/prompt.ts`、`session/session.ts`）：`cancel()`/`prompt()`/`createNext()`/`remove()` 内直接 `yield* Plugin.Service` 向 `Interface` 类型函数的 requirements 中泄漏了 Plugin 依赖。已改为闭包捕获或 `Effect.serviceOption` 模式，与 `permission/index.ts:181` 一致。
- **Model schema 字段名**（`session/session.ts`）：`modelID` → `id`，对齐 Model 类型定义。
- **task.test.ts 类型适配**（`test/tool/task.test.ts`）：no-op Plugin 层加入 `Layer.mergeAll`，测试 Effect 能获取 Plugin.Service。

### [0.7.28] - 2026-07-17

> 0.7.27 长会话压测通过——1000 万+ token 会话验证后台子代理默认开启改动，缓存命中率、DCP 触发时机、子代理后台交互均未发现问题。

#### 功能

- **PreToolUse 阻塞钩子系统**（`packages/core/src/plugin.ts`、`packages/opencode/src/session/tools.ts`、`packages/plugin/src/index.ts`）：新增 `"tool.use.pre"` 挂载点，在 AI SDK 执行 `execute` 回调之前拦截。钩子可以设置 `output.denied = true` 阻断工具调用，工具永不执行。内部 `HookSpec` 和外部插件 SDK `Hooks` 接口同步对齐。fail-open 设计：钩子崩溃不影响工具执行，无钩子注册时行为零变化。
- **内置 safe-shell 守卫插件**（`packages/opencode/src/plugin/safe-shell.ts`）：自动注册 `"tool.use.pre"` 钩子，拦截 `bash` 工具的危险命令。覆盖：根文件系统删除（`rm -rf /`）、直接磁盘写入（`dd`/`mkfs`/`fdisk`/`mkswap`）、fork 炸弹（`:(){`）、系统命令（`shutdown`/`reboot`/`poweroff`/`halt`）。无配置、无需主动触发，默认全量生效。模型尝试危险命令时直接返回 blocked 结果。

#### 诊断

- **0.7.27 压测确认**：针对 0.7.27 的 `experimentalBackgroundSubagents` 默认开启、`task.ts` 后台模式提示词强化、以及此前的 DCP/原生 compaction 双重触发修复，用户实测跑了一轮 1000 万+ token 的长会话。三个此前重点关注的方面——上下文缓存命中率、DCP compress 触发时机是否仍会与原生 compaction 打架、子代理后台派发后主界面交互是否顺畅——均未复现问题。无代码改动，仅记录验证结果。

### [0.7.27] - 2026-07-17

> 后台子代理默认开启——派发子代理不再冻住主界面；配套修好模型不知道该用它的提示词缺口；顺手根治了 registry/task 测试套件的间歇性超时。

#### 功能

- **`experimentalBackgroundSubagents` 默认开启**（`effect/runtime-flags.ts`）：非后台模式下 `task` 工具会同步等子代理跑完整个 session 才返回，而 `session/prompt.ts` 的主循环在此期间一直把 session 标记 busy——主界面全程没法交互，等于白设计了后台派发这条路。现在默认打开（`background: true` 参数和配套的 `task_status` 轮询工具默认就在模型可见的工具 schema 里），设 `REDCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=false` 可退回旧的全阻塞行为。

#### 修复

- **模型不知道该用后台模式**（`tool/task.ts`）：开关打开后实测（RedMon 项目，DeepSeek V4 Flash）连续派发两个 explore 子代理，主 session 分别被冻住约 54 秒和 100 秒——查日志（`~/.redcode/data/log/dev.log`）确认 `task_status` 工具确实已注册、开关是真的生效了，但模型从没传 `background: true`。根因是 `BACKGROUND_DESCRIPTION` 只讲了"怎么用"，没讲"什么时候该用"，而 `task.md` 唯一相关的指引（单条消息并发起多个 agent）跟"陆续派、派完还想接着聊"这种场景对不上。改写 `BACKGROUND_DESCRIPTION`，明确告诉模型：只要下一步动作不直接依赖这次结果，默认优先 `background=true`。改完实测生效。

#### 测试

- **`registry.test.ts`/`task.test.ts` 间歇性超时根治**：原怀疑是 LSP/git/ripgrep 二进制发现拖慢（实际都在 `InstanceState.make()` 后惰性触发，测不到），真正原因是 `Plugin.defaultLayer` 每个测试都重建一遍，会真的动态 import server 模块、跑全部内置 auth 插件，且只要 config 里 `plugin_origins` 非空就调 `config.waitForDependencies()`——这是真实的 npm 依赖校验，读的是机器上真实的 `~/.redcode/redcode.json`，内部超时 15 秒，实测每个测试白白卡 3.5-4.2 秒，正好卡在 bun test 默认 5 秒超时边缘，导致每次挂的测试都不一样。9 个内置 auth 插件都不注册 `tool` hook，用一个 no-op `Plugin.Service` 换掉即可，测试关心的注册/过滤逻辑不受影响。`registry.test.ts` 单文件耗时从 44-63 秒（常伴超时）降到稳定 5-8 秒。`task.test.ts` 因为用的是打包好的 `ToolRegistry.defaultLayer` 没法单独换其中一个依赖，照着 `tool/registry.ts` 源码原样重建了一份组合、只换 Plugin，需要留意：以后 `defaultLayer` 的真实组合变了，这份手抄副本得跟着手动同步。
- 同时补了几个原本隐式依赖旧默认值（`experimentalBackgroundSubagents: false`）的测试断言，改成显式传 `noBackground` 测试层，不再依赖环境默认值。

### [0.7.26] - 2026-07-17

> DCP 压缩与原生 compaction 双重触发修复；依赖漏洞排查（87→65，critical 清零）；新增每日依赖审计 + npm provenance + 容器化隔离指南。

#### 修复

- **DCP compress 与原生 compaction 双重触发**（`session/prompt.ts`）：DCP 的 `compress-range`/`compress-message` 工具调用要等下一次请求发出才真正生效地缩减上下文，但那一轮刚结束时 `lastFinished.tokens` 报的还是压缩前的用量——下一步循环立刻拿这个旧数字判断 `isOverflow`，原生阈值 compaction 跟着又触发一次。两套系统本是分工（DCP 在 50k-100k 区间做任务边界感知的主动压缩，原生 150k 阈值只是兜底），不是要合并成一个。加了 `EXTERNAL_COMPRESS_TOOLS` 检查：刚结束那一轮如果有已完成的 DCP compress 工具调用，这一轮跳过阈值检查，等下一次真实请求体现出压缩效果后再评估。

#### 安全

- **`dompurify` XSS 系列漏洞修复**（`packages/ui/package.json`）：`3.3.1 → 3.4.12`。排查确认 `markdown.tsx` 里 LLM 回复/reasoning/glob-grep 工具输出统统经 `DOMPurify.sanitize()` 渲染进 app/desktop 聊天界面，且代码用到了 `addHook`/`USE_PROFILES`，正好踩中这批漏洞点名的两种用法——是真实可达路径，不是理论风险。
- **清理两个死依赖**：`packages/opencode` 里从未被任何源码引用的孤儿 `minimatch` pin（装的是漏洞版本 10.0.3，排查确认没有代码路径真正用到它），以及自 v0.1.0 起从未被 import 过的 `@aws-sdk/client-s3`（critical 级 `fast-xml-parser` 漏洞正是靠它才"存在"于依赖树里，实际零可达路径）。两个都直接删除。
- **`bun audit` 复查**：87 → 65 个漏洞，critical 1 → 0。剩余的集中在自建官网/企业后端（`packages/web`/`packages/enterprise`，不随产品分发）和 dev-only 工具链，按正常节奏处理即可。

#### 构建 / 文档

- **每日依赖审计**（新增 `.github/workflows/audit.yml`）：daily cron 跑 `bun audit --audit-level=moderate`，之前完全没有自动化在盯这个。
- **npm 发布重新启用 provenance**（`publish.yml`）：`NPM_CONFIG_PROVENANCE` 一直是 `false`，workflow 早就有 `id-token: write` 权限，基础设施齐了只是没打开。
- **容器化隔离指南**（新增 `packages/opencode/docs/containerization.md`）：`SECURITY.md` 原来那句"自己找 Docker/VM"扩成两个今天就能用的方案（用仓库自带 `packages/opencode/Dockerfile` 打镜像跑、VM 隔离要点），外加一个"只把工具调用路进沙箱"的设计方向说明（未实现，只是把形状写清楚）。

#### 诊断

- **evloop drift 排查修正**（`session/prompt.ts`、`session/diag.ts`）：之前怀疑 DCP `buildPriorityMap` 每轮全量重新分词是长会话卡顿的元凶——查证后发现不成立，该函数被 `compress.mode !== "message"` gate 挡住，当前配置（`mode: "range"`）下根本不会执行这条路径。翻了 `~/.redcode/data/log/` 里现存的全部 16 条 `TEMP DIAG evloop drift` 记录，`heapMB` 全部在 70-155 区间，均出现在进程启动阶段，与多个 MCP server（尤其远程的）连接、插件加载、后台 npm install 超时强相关——跟 DCP、跟长会话都对不上。是否与 0.7.25 描述的 2000 万+ token 长会话卡顿是同一个问题，还是那批日志已经轮转清掉、这是另一个独立问题，尚未确认。

### [0.7.25] - 2026-07-16

> 长会话卡顿排查收尾：漂移探针坐实"没坐实"（>2000万 token 会话跑下来未复现明显卡顿），顺手清了几处一直在刷屏的日志噪音 + 一个装错的本地 MCP。

#### 修复

- **`@opencode-ai/plugin` 后台安装失败无限重试刷屏**（`config/config.ts`）：每次 `Config.load()` 都会对同一个必然失败（网络/registry 问题）的目录重新触发一次安装并打 warn，长会话里每隔几分钟到二十几分钟复发一次。按目录记住上次失败时间，10 分钟冷却期内跳过重试，冷却期外照常重试——网络恢复后仍能自愈，不是一次性拉黑。
- **MCP 工具调用重试无退避、吞掉真实报错**（`mcp/index.ts`）：3 次重试间隔固定 1 秒，对瞬时网络抖动太急；且失败日志只打了 `attempt` 序号，没打实际错误信息，完全没法诊断。改成指数退避（1s/2s）+ 补上 `err.message`。
- **MCP `prompts`/`resources` 未实现被当 ERROR 打**（`mcp/index.ts`）：不少小型 MCP server（typegraph/sqlite-query/su-prememory/mcp-process-mgmt 等）本来就没实现这几个可选 capability，服务器如实回了 `MethodNotFound`（-32601），代码却无脑当故障打 `log.error`，每次连接/重连都刷一遍。识别该错误码后降级为 debug，真错误照常 error。
- **vision MCP 装错了本地 server**（`.opencode/redcode.home.jsonc`）：`command` 是裸命令 `"vision-mcp-server"`，PATH 解析到全局 npm 装的旧版本，硬要求 `MODELSCOPE_TOKEN`、没有本地 Ollama 兜底，启动直接报错退出。上次 0.7.23 之前切到 `minicpm-v4.6:f16` 时其实已经新建了 `plugins/vision-mcp-local/index.js`（默认走本地 Ollama），只是撞名了没把 `command` 改过去，一直在调错的那个。改成显式指向新脚本。

#### 诊断

- **事件循环阻塞探针（TEMP，保留）**（`session/message-v2.ts`、`session/prompt.ts`、`session/tools.ts`、新增 `session/diag.ts`）：0.7.24 加的漂移探针补上了工具归因（`active` 字段——阻塞发生时若有内置工具/MCP 工具/DCP compress 正在跑会标出来）和 `heapMB`/`rssMB`，用来交叉验证是不是 DCP 同步 tokenizer 或缓存膨胀在捣鬼。实测 2000+ 万 token 的长会话里探针触发的漂移都在 300~950ms 量级，且从未抓到 DCP compress 处于 `active` 状态，`toModelMessagesEffect` 侧探针也从未触发——本次没能坐实一个具体阻塞源，但也没再复现 0.7.19/0.7.24 描述的那种明显卡顿。探针**故意保留**，不是忘了删，方便下次直接看日志复诊：
  - **看哪**：`~/.redcode/data/log/` 下当次会话的时间戳日志（或 `dev.log`），搜 `TEMP DIAG evloop drift` 和 `toModelMessagesEffect slow`。
  - **字段怎么看**：`blockedMs` 是这次事件循环阻塞了多久（>300ms 才会打）；`active` 是阻塞时正在跑的工具+已耗时（如 `compress:2481ms`），空着说明阻塞时没有工具在跑，嫌疑转向 GC/缓存；`heapMB`/`rssMB` 是当时的堆/常驻内存，持续走高要怀疑 `msgPin`/`modelMsgs` 缓存膨胀（见 `session/prompt.ts` 里 `_caches`）。
  - **复发了怎么办**：把 `blockedMs`、`active`、`heapMB` 三者按时间对齐看——`active` 有值就是那个工具的问题；`active` 空但 `heapMB` 持续走高就是缓存/GC；两者都不像就再加埋点。
  - **确认没事了想删**：三个源文件里搜 `260716 Red TEMP diag` 逐处删掉，再删 `session/diag.ts`，跟 6f7e7f2 那次删法一样。

### [0.7.24] - 2026-07-15

> 修复 YAML agent profile 的 subagent 权限通配符误伤 MCP 工具和 DCP compress——子代理静默失去 MCP 访问，压缩权限被误判 deny 导致卡住不压缩也不继续。

#### 修复

- **[核心] subagent `"*": deny` 误伤 MCP/插件权限**（`agent/profile/types.ts`）：0.7.23 引入的 `toolsToPermissionConfig()` 给所有 `mode: subagent` 的 profile 加了裸通配符 `config["*"] = "deny"`，但 `toolPermissionMap` 只登记内置工具名，jCodeMunch/TypeGraph 等 MCP 工具、DCP 插件自己的 `compress` 工具永远不可能出现在 YAML `tools:` 白名单里被重新 allow 回来，导致所有 subagent 静默失去 MCP 访问；DCP 侧 `resolveEffectiveCompressPermission` 复用同一条通配规则，把 compress 权限误判为 deny——上下文超限时 nudge 仍会提示"必须立即压缩"，但工具本身不可用，表现为卡住不压缩也不继续干活。改为只对 `toolPermissionMap` 已登记的内置工具类别做默认拒绝，其余权限键落回原有 defaults/user 判定。

#### 诊断

- **事件循环阻塞探针（TEMP，待删）**（`session/message-v2.ts`、`session/prompt.ts`）：0.7.19 修的 snapshot `structuredPatch` 冻主线程问题疑似以另一种形式复发（长会话侧出现阻塞），重新加了独立漂移探针（不预设阻塞点）+ `toModelMessagesEffect` 拆分计时排查。目前 `toModelMessagesEffect` 侧探针从未触发，说明这次瓶颈不在 message 转换链路，定位到具体源头后随手删除。

### [0.7.23] - 2026-07-12

> YAML agent profiles——声明式子代理定义，支持 `extends` 继承 + `tools` 白名单自动转 Permission。

#### 新增

- **YAML agent profiles**（`agent/profile/` + `agent.ts`）：新增 `src/agent/profile/` 模块，支持用 YAML 文件声明式定义 agent。内置默认 profiles（`agent.yaml`/`general.yaml`/`explore.yaml`），用户可在项目 `.opencode/profiles/` 下自定义。支持 `extends` 继承链避免重复定义，`tools` 字段白名单自动映射为 Permission 规则集（子代理自动 deny 未列出工具）。零 system prompt 缓存影响——所有缓存键基于 sessionID，agent.prompt 不在任何缓存键中，扩展来源不同但同一文本的 LLM 请求字节序列完全相同。
- **`js-yaml` 依赖**：新增 `js-yaml` + `@types/js-yaml`。

### [0.7.22] - 2026-07-11

> `opencode-go` provider 补全官方 CNY 定价——DeepSeek/MiMo 通过 `opencode-go` 接入时价格用 ¥1/M 而非 models.dev USD 价目。

#### 修复

- **`opencode-go` provider CNY 定价缺失**（`provider.ts`）：数据库分析发现 11 个 session 的 `providerID` 为 `opencode-go`（通过 `auth login` 自动发现配置），此 ID 不在 `CNY_PRICING` map 中（仅含 `deepseek`/`xiaomi`/`stepfun`），计算成本回退到 models.dev 的 USD 默认价。在 `CNY_PRICING` 新增 `opencode-go` 条目，deepseek-v4-flash / pro 共享官方 CNY 价目（¥1/M input, ¥2/M output）。同步补全 `CNY_PROVIDERS`（`sidebar/context.tsx`、`home/footer.tsx`、GUI `session-context-metrics.ts`），确保 UI 正确识别成本币种。

### [0.7.21] - 2026-07-10

> Todo 层级子任务——`id`/`parent_id` 可选字段，模型可表达子任务嵌套，TUI/GUI 侧栏与 composer 均按层级缩进渲染。

#### 新增

- **Todo 层级子任务**（`session/todo.ts`、`tool/todo.ts`、`session.sql.ts`、迁移 `20260710070135_add_todo_hierarchy`）：Todo 结构新增可选 `id`/`parent_id` 字段，模型可给任务标 id（如 `"2"`）并让子任务用 `parent_id` 指向它（如 `"2.1"`）表达层级；不填则完全等同旧的纯扁平列表，向后兼容。TUI 侧栏（`sidebar/todo.tsx`）、GUI composer（`session-todo-dock.tsx`）均按 `parent_id` 链条计算缩进层级渲染，防环/防越界兜底深度上限 5 层。
- **`TodoItem` 组件支持 `depth`**（`component/todo-item.tsx`）：新增可选 `depth` prop 控制缩进。
- **plugin SDK `TuiSidebarTodoItem` 补字段**（`plugin/src/tui.ts`）：追加 `id`/`parent_id`，插件可读取层级信息。

### [0.7.20] - 2026-07-09

> Snippet 系统接入——read 工具自动提取符号并注册 snippet，支持按 snippet ID 精准重读代码片段。

#### 新增

- **Snippet 系统完整接入**（`read.ts`、`session/snippet.ts`、`tool/snippet.ts`）：read 工具读取 TS/JS/Python/Go/Rust 文件时，用正则提取顶层符号（函数/类/接口/类型等），注册为 snippet 并在输出末尾附 `<snippets>` 索引。模型可用 `snippet` 工具按 ID 精准重读某个函数/类，不必重读整个文件，省上下文窗口。灵感来自 deepcode-cli 的 snippet 编辑系统。
- **snippet 工具增强**：去掉无用的 `filePath` 参数；输出带行号前缀和 `[path#TAG]` header，可直接配合 edit hashline 格式使用。
- **snippet service 修复**：`get()` 改为跨所有 messageID 搜索（原按 messageID 分桶，read 和 snippet 工具的 messageID 不同导致永远查不到）。

### [0.7.19] - 2026-07-09

> 修复 snapshot Myers diff 冻死事件循环（采样分析器实测 59s），清理排查探针。

#### 修复

- **[核心] snapshot structuredPatch 冻死事件循环**（`snapshot/index.ts`）：`patch()` 调用 diff 库的 `structuredPatch`（Myers O(ND) 差分），对大文件或病态编辑距离无护栏，采样分析器实测单次调用卡 59s（6274/6278 samples）冻死主线程，流式 delta 在冻结期间缓冲、解冻后 burst 涌出——即敏敏"等几十秒→整段话一瞬间刷出"的根因。加 256KB 大小护栏（超限跳过全量 patch）+ 2s timeout 兜底，验证 blockedMs 从 49398~70962ms → 消失。
- **清理 TEMP 诊断探针**（`provider.ts`、`llm.ts`、`message-v2.ts`）：删除 260709 排查用的事件循环卡顿探针、JSC 采样分析器、fetch 计时、transformParams 计时、toModelMessages 计时。

### [0.7.18] - 2026-07-08

> TUI 消息列表 windowing——长会话（400+ 消息）输入不再卡顿，清理 DIAG 探针。

#### 修复

- **[核心] TUI 消息列表无虚拟化，长会话输入卡顿**（`routes/session/index.tsx`）：`<For each={messages()}>` 全量挂载全部消息（如 422 条），每条内含 tool/reasoning/text part 全部建成 opentui renderable，opentui 每次按键触发 yoga `calculateLayout` O(总节点) 全树布局，数百节点时每次敲字重算→输入回显延迟 1 秒+。改为消息级 windowing：默认只渲染最近 50 条消息（`MSG_WINDOW_DEFAULT=50`），滚动到顶部自动加载更多（`MSG_WINDOW_STEP=50`），Ctrl+Home 展开全部。屏外消息不进 yoga 树、不建组件——同时省下布局+组件+绘制开销。所有导航（Page Up/Half Page Up/Previous Message/Timeline/Fork/Jump to Last User Message）均适配 windowing，自动展开窗口定位目标消息。切换会话时重置窗口大小。
- **清理 DIAG 探针**（`provider.ts`、`llm.ts`）：删除 260708 排查用的临时 fetch begin/headers 计时日志和 transformParams 计时日志。

### [0.7.16] - 2026-07-07

> 修复 LSP 的 tsserver 无内存上限、大 TS monorepo 下涨到 2.5G+ 吃掉 GUI 绝大部分内存。

#### 修复

- **[核心] TypeScript LSP 的 tsserver 无内存上限**（`lsp/server.ts`）：排查"小宋跑任务吃 2.5G 内存"时按父进程树实测，真凶既不是 Electron（renderer 仅 ~530MB）也不是 sidecar 本体（仅 ~276MB），而是 RedCode 内置 LSP 启动的 `typescript-language-server` 再 fork 出的 `tsserver.js`——它默认没有 `--max-old-space-size` 上限，在本仓这种大 TS monorepo 上把整个类型图加载进内存后一路涨到 2508MB，被任务管理器显示成一个"独立"的 Node.js JavaScript Runtime，之前一直被误判为 sidecar/消息缓存。给 `Typescript.spawn` 的 `initializationOptions` 加 `maxTsServerMemory: 2048`，typescript-language-server 会将其转成 tsserver 的 `--max-old-space-size` 并在超限时自动重启 tsserver，内存不再无限增长。

### [0.7.17] - 2026-07-07

> 修复 `redcode doctor` 一次性命令在 Windows 下无法退出 + StepFun `step-3.7-flash` 价格显示为 USD 而非官方 CNY。

#### 修复

- **`redcode doctor` 因 `InstanceRef` 缺失而 die**（`instance-state.ts`）：`doctor` 命令使用 `instance: false` 避免 full bootstrap，但 `Config.Service` 内部走 `InstanceState.make` 时需要 `InstanceRef`，没有时直接 die 导致进程挂起。新增 `fallbackContext()` 函数在 `InstanceRef` 缺失时合成 minimal `InstanceContext`，`doctor` 现在无需 project instance 即可正常运行。
- **StepFun `step-3.7-flash` 价格显示为 USD 数值而非官方 CNY**（`provider.ts`）：models.dev 返回的是 USD 价格（input $0.2/M, output $1.15/M），但 UI 侧对 `stepfun` provider 未做 CNY 转换，导致价格被当成人民币显示。给 `CNY_PRICING` 添加 StepFun 官方 CNY 定价（input ¥1.35/M, output ¥8.1/M, cache_read ¥0.27/M），同时在 sidebar `CNY_PROVIDERS` 中加入 `stepfun`。

### [0.7.15] - 2026-07-07

> 新增 `redcode doctor` 诊断命令 + 修复 Windows 下 MCP stdio 子进程导致进程无法退出。

#### 新增

- **`redcode doctor` 诊断命令**（`src/cli/cmd/doctor.ts`、`src/index.ts`）：新增 `doctor` 子命令，对 TUI 运行环境做 6 项快速自检（version / config / providers / plugins / mcp / database），`--json` 可输出机器可读结果。命令注册在 CLI 入口，`instance: false` 已移除，走正常 project instance 上下文。

#### 修复

- **Windows 下 MCP stdio 子进程阻塞进程退出**（`src/mcp/index.ts`）：Windows 上 `StdioClientTransport.close()` 等待的 `close` 事件在 console 子进程场景下可能永远不触发，导致 `redcode doctor` 等一次性命令执行后进程挂起不退出。在 `win32` 平台对 `StdioClientTransport` 的 `close()` 做 override，先 `killProcessTree(pid)` 强制清理子进程树，再调用原始 close。
- **dispose 无超时保护可无限挂起**（`src/effect/instance-registry.ts`）：`disposeInstance()` 原来直接 `Promise.allSettled` 跑完所有 disposers，任一个卡住就会让整个命令 hang 住。新增 5 秒 `Promise.race` 超时，超时后直接返回，防止单点 disposer 拖垮整个退出流程。

### [0.7.14] - 2026-07-07

> 修复 DeepSeek 计费金额偏低 + 缓存命中率虚高（99% 显示 vs 官方结算 ~96%）。

#### 修复

- **[核心] DeepSeek/Xiaomi 官方 CNY 定价只在 `config.provider` 声明时才生效**（`provider.ts`）：CNY 价格表 patch 原来写在"用 config 扩展 models.dev 数据库"的循环里，只对 `redcode.jsonc` 里手写声明过的 provider 生效——纯靠 `auth login` 自动发现（不在 config 声明）的 DeepSeek 完全没打上官方 CNY 价目，直接落回 models.dev 的默认 USD 量级价格（`cache.write:0`），而 UI 侧一直假设"deepseek/xiaomi 的 cost 已经是 CNY"直接显示，导致实际花费被严重低估。改为对 models.dev 数据库无条件 patch，不再依赖用户是否在 config 里声明该 provider。
- **缓存命中率公式 `sumMiss || sumWrite || sumInput` 的"三选一"掩盖了实际未命中量**（`prompt/index.tsx`、`sidebar/context.tsx`）：DeepSeek 的真实 miss/新鲜 token 有时会因为 SDK 响应用的是哪个原始 metadata 字段，被 `session.ts` 的缓存上限兜底逻辑错记进 `cache.write` 而非 `cache.miss`（`tokens.cache.miss` 按构造恒等于 `tokens.input`，与 `write` 从不重叠计数），旧公式用 `||` 优先取 `sumMiss`，正好选中了被"抽空"的那个残缺值，命中率虚高到 99%。改为 `sumRead + sumMiss + sumWrite` 直接求和，不再二选一漏记。

### [0.7.13] - 2026-07-07

> 补全 sidecar Event Loop 阻塞的最后一个死角：`toUIMessages` 循环内部本身没有让出点。

#### 修复

- **`toUIMessages()` 同步遍历全部历史消息、循环内部零让出**（`message-v2.ts`）：0.7.12 的 `yieldNow` 只加在循环外（`toModelMessagesEffect` 调用前后、msgPin 里），拦不住 `toUIMessages` 这个 `for (const msg of input)` 循环本身——长会话下它一次性同步跑完（含 `truncateToolOutput` 等重活），Event Loop 仍被这一段独占，心跳/健康检查照样被堵。将 `toUIMessages` 从普通同步函数改为 `Effect.fn` 生成器，循环内每处理 10 条消息 `yield* Effect.yieldNow`，让批处理中途也能喘气；同步更新唯一调用点 `toModelMessagesEffect` 改为 `yield*`。

### [0.7.12] - 2026-07-06

> Sidecar Event Loop 阻塞导致 GUI 断连 + 状态灯误报 Healthy + 输出一阵一阵慢。

#### 修复

- **Sidecar Event Loop 被同步操作长时间阻塞**（`message-v2.ts`、`prompt.ts`）：Agent 每步之间，`toModelMessagesEffect` 同步遍历历史消息、`structuredClone(msg.parts)` 深拷贝、`JSON.stringify(msgs)` token 估算连续执行，Event Loop 被阻塞 2–10s。期间 `Stream.tick("10 seconds")` 心跳发不出 → SSE 超时 abort（30s→90s 后仍可被堵超 30s 的步打断）、`/global/health` 健康检查 3s 超时→粉红 dot、AI 输出事件堆积→输出卡顿。在 `toUIMessages()` 后和 msgPin 循环每 10 条消息加 `yield* Effect.yieldNow`，让 Event Loop 在同步批处理间喘口气，处理积压的心跳和健康检查。

### [0.7.11] - 2026-07-06

> 修复 GUI 成本显示偏低（tokens 覆盖 + 子代理成本未汇总）+ 前缀缓存命中率无法收敛到 97%+。

#### 修复

- **message tokens 覆盖 bug**（`processor.ts`）：多 step assistant 消息的 `tokens` 字段用 `=` 覆盖而非 `+=` 累加，导致只保留最后一个 step 的数据。GUI 上下文面板据此汇总的缓存命中率被严重低估。改为与 `cost` 一致的逐字段累加。
- **子代理成本未汇总**（`session-context-tab.tsx`、`session-context-usage.tsx`）：Task 工具创建的子 session LLM 成本未纳入父 session 面板"总成本"显示，导致金额偏低数倍。新增 `childCost` memo 遍历子 session 消息汇总。
- **MCP 工具描述缓存/连接不一致**（`mcp/index.ts`）：`convertMcpToolCached` 曾追加 `[cached — not connected]` 后缀，MCP 服务器重连时描述变化打断前缀缓存。改为与 `convertMcpTool` 字节级一致，断线提示挪到 `execute()` 抛错。
- **工具定义未缓存致前缀缓存命中率上不去**（`prompt.ts`）：`describeSkill()` 每步调 `Glob.scan()` 扫磁盘、`describeTask()` 每步读 agent 列表，是 system/messages/tools 三大前缀组件中唯一未做 per-session 缓存的。build agent 创建文件匹配 skill path 模式时 Skill 工具描述变化 → 工具 schema JSON 变化 → 整个前缀缓存失效。新增 `_caches.tools` 第一步缓存所有工具 description + inputSchema，后续步骤用缓存覆盖。

### [0.7.10] - 2026-07-05

> 修复 DeepSeek 成本少报（miss 部分按 cache_hit 计费）。

#### 修复

- **DeepSeek cache miss 计费少报**：`ai-sdk.ts` 未从 `raw` 提取 `prompt_cache_miss_tokens`，`cacheWriteInputTokens` 始终为 0。同时 `getUsage` 的 cap 未考虑 cache write 部分，当 `prompt_cache_hit_tokens > prompt_tokens` 时多余部分被 cap 吃掉，本应按 ¥1/M 计费的 miss 部分被按 ¥0.02/M 计费。双修：ai-sdk.ts 补充 miss tokens 提取（`deepSeekCacheWrite`）；session.ts cap 改用 `inputTokens - cacheWriteInputTokens` 为基准。

### [0.7.9] - 2026-07-05

> 修复 DeepSeek V4 Flash 成本少报（~7x 低估）。

#### 修复

- **DeepSeek V4 Flash 成本计算少报**：`getUsage()` 中 `adjustedInputTokens = inputTokens - cacheReadInputTokens`，DeepSeek 返回 `cached_tokens > prompt_tokens`（比例 1.5x–20x），导致非缓存 input 未被计费，仅输出计费。将 `cacheReadInputTokens` cap 在 `inputTokens` 范围内（`session.ts:418`），同时修正 `ai-sdk.ts` 中 DeepSeek `prompt_cache_hit_tokens` 解析。

---
### [0.7.8] - 2026-07-05

> 修复 `@opentui/keymap` 双份类型冲突 + 首页项目分区选择器。

#### 修复

- **`@opentui/keymap` PKG 重复导致 TS 类型错误**：`@opencode-ai/plugin` 内置的 `@opentui/keymap` 与 TUI 依赖的版本虽文件全等，但 Bun content-addressable 存储为不同 hash（`0d7da94b` vs `77dde1de`），TypeScript 视为不同类型，`#private` 字段不兼容报错。将两个 junction 统一指向 `77dde1de`（`node_modules/.bun/`）。

#### 新增

- **首页项目分区选择器**：TUI 首页新增交互式 workspace 选择器，展示项目/分区列表，支持快速切换工作区（`project-selector.ts`、`api.tsx`、`command-shim.ts`、`thread.ts`）。

#### 移除

- **NVIDIA BILLING-INVOKE-ORIGIN header**：去掉 `provider.ts` 中发送给 NVIDIA 的 `X-BILLING-INVOKE-ORIGIN: RedCode` 头，该头导致第三方托管模型（如 `z-ai/glm-5.2`）返回 404。

### [0.7.7] - 2026-07-04

> 提示词文件 .txt→.md 格式升级 + 新增 ollama 本地模型专属提示词。

#### 重构

- **提示词外置格式升级**：全部 50 个 `.txt` 提示词文件重命名为 `.md`（Bun 原生支持），提升可读性与 diff 体验，26 个 `.ts` 导入路径同步更新。

#### 新增

- **ollama 本地模型提示词**：新增 `prompt/ollama.md`，针对 GLM-4.7-Flash / Qwen3.6 等本地模型设计 harness 式提示词——保留全部工具（DCP compress、MCP 代码智能、子代理）同时加装反幻觉规则、分步思考、工具优先级排序与大文件阅读指引。`system.ts` 按 `providerID` 匹配 ollama，路由优先于 GLM/Qwen 通用档。

### [0.7.6] - 2026-07-04

> 修复删除 session 报 404、GUI 卡在"思考中"不恢复。

#### 修复

- **删除 session 404**：`session.remove()` 先 `get(sessionID)` 校验存在性，级联删除子 session 或重复删除时若目标已不存在会抛 `NotFoundError` → HTTP 404。改为 `catchTag("NotFoundError")` 静默返回，已删即成功（`session/session.ts`）。
- **GUI "思考中"永久卡住**：`session_status` 仅在 bootstrap 时轮询一次，之后完全依赖 WebSocket 事件推送。网络抖动或事件丢失会导致 busy→idle 转换永远不到达前端，表现为模型已完成但界面一直显示"思考中"。新增 5 秒间隔轮询 fallback：仅当存在 busy session 时才发请求，idle 时零开销（`global-sync.tsx`）。

### [0.7.5] - 2026-07-03

> `redcode web` 根路径改为 xterm.js + PTY 的 TUI web 终端，手机浏览器可直接操作 RedCode TUI。

#### 新增

- **TUI Web Terminal**：`redcode web` 的 `GET /` 不再代理 GUI web app，改为返回内联 HTML 页面（`tui-terminal.html`），用 xterm.js (CDN) + 现有 PTY WebSocket 直接在浏览器中 spawn 并操作 `redcode.exe` TUI 实例。支持窗口自适应 resize、移动端防双击缩放。其他路径仍 fallback 到原有 GUI 代理。
- **`tuiTerminalHtml()` + `TUI_CSP`**：`ui.ts` 新增 TUI HTML 模板读取函数和专用 CSP 策略（允许 jsdelivr CDN）。服务端用 `split().join()` 注入 `__REDCODE_DIR__` 和 `__REDCODE_BIN__` 占位符，避免 Windows 反斜杠被 `String.replace()` 吞掉。

### [0.7.4] - 2026-07-02

> 输入框下方空白区加常用快捷键滚动提示。

#### 新增

- **`ShortcutsTicker` 常用快捷键跑马灯**：输入框下方状态栏原本 Cache hit 左侧一大片空白，现改为循环滚动展示 `新会话/会话列表/切换模型/MCP 状态/切换主题/帮助` 的实际快捷键，遵守 `animations_enabled` 开关（关闭动画时降级为静态一行）（`component/prompt/shortcuts-ticker.tsx`）。

### [0.7.3] - 2026-07-01

> 新增 `todoread` 工具，支持 compress 后重新读取 todo 状态，避免丢失上下文后重复已完成工作。

#### 新增

- **`todoread` 只读工具**：从 SQLite 持久化读回当前会话的 todo 列表，返回完整状态 + 摘要行（`N total · M done · A active · P pending`）。权限复用 `todowrite` 通道。在 `compress` 后调用可恢复已完成/待办认知，不再因摘要遗漏而重复已做完的步骤。

### [0.7.2] - 2026-07-01

> 修复隔离 worktree 子代理用完不释放实例，导致子进程/内存持续累积（GUI 长驻 sidecar 尤其明显）。

#### 修复

- **隔离 worktree 子代理泄漏 `InstanceStore` 实例**：`session/prompt.ts` 的 `runIsolated`（`task` 工具 `isolation:"worktree"` 用）创建隔离 worktree 的 `InstanceContext` 后，任务跑完从未释放，而 `InstanceStore` 缓存 `capacity: Infinity`，只能靠显式 dispose 清理——每次隔离子代理都会在内存里永久累积一份该 worktree 的 LSP server 等子进程。TUI 因 server 进程随每次 CLI 调用重启，泄漏会随会话结束自然清空；GUI 的 sidecar 是 Electron 整个 app 生命周期只起一个长驻进程，泄漏无限累积，表现为任务管理器里两三百个子进程、内存持续升高。修复：`runIsolated` 用 `Effect.ensuring` 包裹任务执行，无论成功/失败/中断都调用 `InstanceStore.dispose(ctx)` 释放隔离实例（`session/prompt.ts`）。

### [0.7.1] - 2026-07-01

> 0.7.0 首页美化的后续微调：footer 文案改英文、Logo idle 扫光调到肉眼可见并改为蓝色调。

#### 修复

- **footer 统计条文案**：`缓存 xx%` 改成 `cache hit xx%`（`feature-plugins/home/footer.tsx`）。
- **首页 Logo 启用 idle 扫光**：`buildIdleState`/`shimmerConfig` 这套呼吸扫光此前从未被启用过（`<Logo />` 一直不带 `idle`），首页加 `idle` 后发现幅度是给点击 burst 余韵设计的，常驻场景太淡——放大 `haloAmp`/`ambientAmp`/`primaryMix`，并把高光目标色从纯白 `PEAK` 换成偏白的饱和 `primary` 蓝（`idlePeak`），扫光经过时读出的是明显蓝色而不是泛白。同时把 idle 态 tick 频率从 60fps 降到静止时约 14fps（点击 burst/ring 特效仍满帧率），避免首页常驻页面拖 CPU（`component/logo.tsx`）。

### [0.7.0] - 2026-07-01

> 首页视觉美化：去掉一部分上游 opencode 观感，加了三处点缀——星空背景、footer 统计条、提示语呼吸点。

#### 新增

- **首页星空背景**：新增 `component/starfield.tsx` + `starfield-render.ts`，基于 `FrameBufferRenderable` 铺一层稀疏光点，位置/字符/闪烁相位由坐标哈希确定性生成，挂在 Logo 后面（`routes/home.tsx`）。手动低频 `requestRender`（~700ms 一次）代替常驻 60fps `live` 循环，呼应 Logo 组件默认不空闲动画、省 CPU/电量的既有设计取向。
- **首页 footer 统计条**：`home_footer` 插件（`feature-plugins/home/footer.tsx`）新增花费 + 缓存命中率，跨 session 聚合 `sync.data.session` 的 `cost`/`tokens`（落库时已 denormalize，纯本地 reduce，无新请求）。
- **提示语呼吸点**：`home_bottom` 的提示语前缀圆点（`feature-plugins/home/tips-view.tsx`）加低频呼吸色变，用 `tint()` 在 `background`/`warning` 间插值。

### [0.6.43] - 2026-07-01

> 修复 canary token 模块级 store 在 bun compile 下可能重复实例化，导致 prefix cache 命中率卡在 95%（此前巅峰 98%）。

#### 修复

- **canary token store 改用 globalThis**：`canary.ts`（260629 引入）的 token store 用裸模块级 `const store = new Map()`，与 6/20 已修过的 `prompt.ts` `_caches` 是同一类坑——bun compile 可能重复实例化模块，重复实例的 Map 是空的，`Canary.get(sessionID)` 会误判成新 session、铸造新随机 token，导致注入 system prompt 的 "Session marker" 那行每 turn 变化，打断 DeepSeek 的 prefix cache。改为 `globalThis` 兜底存储，与 `prompt.ts` 缓存同一套模式（`packages/opencode/src/session/canary.ts`）。

### [0.6.42] - 2026-07-01

> 修复压缩切断 tool 配对导致的 DeepSeek 400 断会话。

#### 修复

- **孤儿 tool-result 兜底**：上下文压缩（DCP 插件的 compress / core compaction）可能切断 `tool_call`/`tool_result` 配对，留下没有前置 `tool_calls` 的孤儿 tool 消息，发给 DeepSeek 等 OpenAI 兼容 provider 时报 `Messages with role 'tool' must be a response to a preceding message with 'tool_calls'`，会话直接卡死（孤儿会赖在历史里直到某次 collapse 才消失）。在 `normalizeMessages` 初始 sanitize 之后、所有 provider 专用块之前（deepseek/interleaved 分支会提前 return，必须前置）加入发送前扫描：丢弃无前置配对 `tool_call` 的 tool-result，整条 tool 消息若无剩余则删除（`packages/opencode/src/provider/transform.ts`）。

### [0.6.41] - 2026-06-30

> 第三方 code review 收尾 P1-b 续：prompt.ts 继续拆分，shellImpl 迁出。

#### 重构

- **prompt.ts 拆分续**：把 `shellImpl`（用户终端命令落库为 tool part，约 155 行）从 prompt.ts 巨型闭包提取到 `prompt/shell.ts`，沿用工厂函数 + 显式依赖注入模式（`makeShell(deps)`），行为不变、typecheck 通过，prompt.ts 由约 1866 行瘦到约 1700 行，后续 createUserMessage / runLoop / command 将陆续迁出（`packages/opencode/src/session/prompt.ts`、`prompt/shell.ts`）。

### [0.6.40] - 2026-06-30

> 第三方 code review 收尾 P1：handler 裸 SQL 收归 Session.Service，prompt.ts 启动拆分。

#### 重构

- **server handler 不再直接读表**：`handlers/session.ts` 此前用裸 Drizzle ORM 查询 `MessageTable`/`PartTable` 找最近一条 compaction 消息（GUI 初始加载跳过旧消息用），绕过了 `Session.Service` 抽象、handler 与表结构耦合。新增 `Session.Service.latestCompactionCursor()` 把这段 SQL 收归 session 层，handler 删去 `Database`/`MessageTable`/`PartTable`/drizzle-orm 全部直接引用，性能不变（仍是单次索引查询）（`packages/opencode/src/session/session.ts`、`src/server/routes/instance/httpapi/handlers/session.ts`）。
- **prompt.ts 拆分启动**：1866 行巨型文件开始按职责拆分，首批提取 `getModel`/`currentModel`/`sessionSourceLabel` 到 `prompt/shared.ts`（工厂函数 + 显式依赖注入模式 `makeShared`），后续将陆续迁出（`packages/opencode/src/session/prompt.ts`、`prompt/shared.ts`）。

---

### [0.6.39] - 2026-06-30

> 清理 prefix-cache 诊断代码 — 调查结论：客户端逐 turn 字节完全稳定，唯一 cache break 来自 auto-compaction 重写消息（结构性开销，非 bug）。

#### 移除

- **prefix-cache hash 诊断日志**：0.6.38 部署后插桩 119 turn 分析，仅 compaction（153→26 blocks）触发 1 次 `cacheBreak=YES`，其余全为 `growth-only`。确认客户端 prompt 构建字节级稳定，诊断代码功成身退（`packages/opencode/src/session/prompt.ts`）。

---

### [0.6.38] - 2026-06-30

> 移除未使用的 Office 聊天室功能 — 顺带消除一个 prefix cache 不稳定源。

#### 移除

- **Office 群聊/聊天室功能下线**：该功能自上线从未实际使用，且 `groupChatContext()` 把群聊消息注入系统提示词的 canary marker 之后——群聊内容一变就改写 system prompt 尾部、打断 DeepSeek 严格 prefix cache（历史日志多次记录命中率下跌与此相关）。后端删除 `src/chat/` 服务与 SQL schema、server `chat` 路由组与 handler、`prompt.ts` 的群聊注入与 `_caches.chatCtx` 缓存（`packages/opencode/src/session/prompt.ts`、`src/server/routes/instance/httpapi/{api,server,handlers/chat,groups/chat}.ts`）。前端 UI 与桌面第二窗口见 GUI 0.6.14。已应用的 migration 与 `session.client` 列作为历史保留，不影响运行。

---

### [0.6.37] - 2026-06-30

> 还原 canary commit 误删的 text-part 落盘逻辑。

#### 修复

- **交错 text→tool→text 丢失首段文本**：canary commit `1220d25af` 在 `text-end` 分支误删了 3 行 text-part 最终化逻辑（持久化 plugin 转换后的最终文本 + providerMetadata、重置 `currentText`），导致一个 step 内 text→tool→text 交错时第一段文本不落盘直接丢失。现在在 canary 泄漏检查之后还原这三行（`packages/opencode/src/session/processor.ts`）。

---

### [0.6.36] - 2026-06-29

> 修复 DeepSeek prefix cache 命中率断崖下跌——0.6.35 引入的 canary 重置 + modelKey 缓存键。

#### 修复

- **DeepSeek prefix cache 命中率从 95%+ 暴跌至 45%**：根因有二。一是 canary token 每轮被 `Canary.clear(ctx.sessionID)` 清空后重生成新值，system prompt 尾部字节每轮不同，DeepSeek 严格 prefix cache 无法匹配尾部。二是 `_caches.system` / `_caches.modelMsgs` 缓存键加上 `modelKey` 后，同一模型在不同路径下引用不同对象时 key 不匹配，缓存频繁失效。修复：删除 `processor.ts` 中的 `Canary.clear(ctx.sessionID)`，回归 `sessionID` 单键缓存（`packages/opencode/src/session/processor.ts`、`packages/opencode/src/session/prompt.ts`）。

---

### [0.6.35] - 2026-06-29

> 修复同 session 切换模型时系统提示缓存错用前一模型的缓存。

#### 修复

- **模型切换缓存键修复**：`_caches.system` 和 `_caches.modelMsgs` 的缓存键由单一 `sessionID` 改为 `sessionID + modelKey（providerID:modelID）`。切换模型后系统提示重新构建，避免新模型沿用旧模型的 system prompt、图片能力判断失效、模型自我认知错乱等问题（`packages/opencode/src/session/prompt.ts`）。

---

### [0.6.34] - 2026-06-27

> 修复 DCP nudge 配置导致的启动崩溃 + schema passthrough。

#### 修复

- **`dcp` key 导致 ConfigInvalidError 启动崩溃**：`redcode.jsonc` 加入 `"dcp"` 字段后，`config/parse.ts:topLevelExtraKeys` 将其识别为未知 key 并抛 `ConfigInvalidError`，进程无法启动。在 `config/config.ts` 的 `Info` schema 中新增 `dcp: Schema.optional(Schema.Unknown)` passthrough，插件 config 由插件自行校验，不影响主 schema（`packages/opencode/src/config/config.ts`）。
- **DCP nudge 配置恢复**：`nudgeForce: "strong"`（user 角色消息）+ `iterationNudgeThreshold: 10`（10 轮提前触发）重新写入 `~/.redcode/redcode.jsonc`。

---

### [0.6.33] - 2026-06-27

> StepFun prefix cache 命中率修复 + DCP nudge 增强。

#### 修复

- **StepFun prefix cache 命中率偏低**：`stepfun` / `step-plan` provider 缺少 `promptCacheKey`，导致 Step 3.7 Flash 跨调用缓存命中率仅 63~82%，远低于 DeepSeek/MiMo 的 94~97%。在 `transform.ts` 的 `promptCacheKey` 条件中补入两个 providerID，实测命中率上升至 88%+（`packages/opencode/src/provider/transform.ts`）。

#### 变更

- **DCP compress nudge 增强**：`nudgeForce` 从 `"soft"`（assistant 消息，易被忽视）改为 `"strong"`（user 消息，服从性更高）；`iterationNudgeThreshold` 从默认 15 降至 10，提前触发提醒（`~/.redcode/redcode.jsonc`）。

---

### [0.6.32] - 2026-06-26

> 移除上游 SaaS 控制台包，减重 ~35MB。

#### 变更

- **移除 `packages/console/`**：上游 opencode 云控制台 web app，RedCode 不走 SaaS 路线，零内部引用，删除后瘦身 521 文件 / 35MB，`package.json` 同步清理 workspace 条目与 `dev:console` 脚本。

---

### [0.6.31] - 2026-06-26

> 修复自定义 provider 下引擎压缩永不触发：context 未知时也按 threshold 硬上限压缩，DCP 不再无限催不执行。

#### 修复

- **overflow.ts 阈值守卫顺序修正**：`isOverflow()` 中 `compaction.threshold` 检查提到 `model.limit.context === 0` 守卫之前。自定义 provider（models.dev 无条目、config 未声明 limit）会兜底为 `context:0`，旧顺序在阈值检查前就早退，等于对这类 provider 关掉了压缩——DCP 一直 nudge 但引擎永不 compaction，撑到中断。现在 context 未知也照样按硬上限触发，符合该逻辑原本注释声明的意图。

---

### [0.6.30] - 2026-06-25

> sync-home 防覆盖加固：command/ 改为只铺缺失（不再盲覆盖私仓 persona 命令），merge-home-config 写入时保留 JSONC 注释。

#### 修复

- **command/ 同步改为 seed-only**：`sync-home.bat` 中 `xcopy /y` 替换为逐文件 `if not exist` 检查，私仓编辑的 persona 命令不再被公仓模板覆盖。
- **merge-home-config 保留注释**：新增 JSONC-aware patcher（`patchNewKeys`），合并模板新键时直接原文插入而非 `JSON.stringify` 重写，`// YYMMDD Red` 日期注释不再被剥。
- **模板 stepfun 端点修正**：`.opencode/redcode.home.jsonc` 的 stepfun 从无效的顶层 `api` 字段改为 `options.baseURL`，防止合并时向私仓重复注入已删除的 `api` 键。

---

### [0.6.29] - 2026-06-25

> 修复人格自我误认（GUI 被说成 TUI）与多模态误判：基础提示词写死 "CLI agent" 让模型把界面认错，env 又缺客户端事实。

#### 修复

- **提示词去 CLI 化**：13 个 `prompt/*.txt` 开头 `interactive CLI agent/tool` 统一改为 `interactive code agent`，消除"敏敏 TUI / 小宋 GUI 都不涉及 CLI"的语义偏差。
- **env 注入客户端类型**：`<env>` 块新增 `Client: RedCode Desktop GUI / Terminal TUI`（取 `flags.client`），给模型权威的客户端事实，避免把 GUI 误判成 TUI（`session/system.ts`）。

---

### [0.6.28] - 2026-06-25

> 修复流式重试时的 part 重复：断流重试会从头重跑，旧的失败 part 未清理导致消息里 text/reasoning/tool/step 重复。

#### 修复

- **流式重试 part 清理**：进入每个 step 前快照已有 part，重试时删掉失败那次新建的全部 part，并丢弃在途追踪（`currentText`/`reasoningMap`/`toolcalls`），避免重复内容落库（`session/processor.ts`）。

---

### [0.6.27] - 2026-06-25

> 修复 PTY 子进程泄漏（Windows 僵尸进程）+ sync-home 配置覆盖问题。

#### 修复

- **PTY 子进程泄漏**：Windows 上 PTY teardown 改用 `taskkill /T` 杀整棵进程树，防止 shell 子进程（node/python 等）残留成僵尸占满内存（`pty/index.ts`）。
- **sync-home 配置覆盖**：`sync-home.bat` 不再盲目 `copy /y` 覆盖 `~/.redcode/redcode.jsonc`，改为 JSONC 感知的深度合并——用户已有 key 保留，模板新增 key 自动补入（新增 `script/merge-home-config.ts`）。

---

### [0.6.26] - 2026-06-24

> 接入 Horizon MCP（AI 日报 pipeline），同步配置到 home 文件，更新 ai-daily skill。

#### 新增

- **Horizon MCP 配置**：在 `.opencode/redcode.home.jsonc` 和 `~/.redcode/redcode.jsonc` 添加 `horizon` MCP server 配置，调用本地 `D:\AI\Red\Horizon\src\mcp\server.py` 提供 `hz_run_pipeline` 等工具。
- **MCP resource template listing**（上游 `c6cc13e`）：新增 `resourceTemplates` 接口，支持发现 MCP server 的参数化资源模板。
- **ai-daily skill 升级**：skill 触发后自动调用 Horizon MCP 运行完整 pipeline（fetch → score → filter → enrich → summarize），替代原有 webfetch/web_search 聚合方式。

---

### [0.6.25] - 2026-06-24

> 移植上游 4 项 bugfix：快照子目录路径、MCP 结构化错误、skill 路径格式、OAuth 安全加固。

#### 修复

- **快照子目录路径**（上游 `dcf7b4e`）：`git add`/`git rm` 的 `--pathspec-from-file` 输入加 `:(top,literal)` 前缀，子目录下路径正确相对 worktree root 解析（`snapshot/index.ts`）。
- **MCP 结构化错误保留**（上游 `c17b955`）：`toolResultText` 对 `content` 类型提取纯文本而非 JSON dump 整个结构，模型能直接读到错误信息（`llm/protocols/shared.ts`）。
- **Skill 路径格式**（上游 `246d40d`）：skill base directory 由 `file://` URL 改为文件系统路径，避免 Windows 上 `file:///D:/...` 格式让模型困惑（`tool/skill.ts`）。
- **OAuth 回调绑定**（上游 `af31e97`）：MCP OAuth callback server 显式绑定 `127.0.0.1`，防止意外监听所有网络接口（`mcp/oauth-callback.ts`）。

---

### [0.6.24] - 2026-06-24

> 修复流式输出阻塞 + Windows 僵尸子进程泄漏。

#### 修复

- **AI SDK 流式输出阻塞**：`result.result.response` 实际在整个流完成后才 resolve（非 HTTP 头阶段），`await` 它会阻塞 `fullStream` 消费，网络异常时直接触发 `NoOutputGeneratedError`。改为 fire-and-forget 异步捕获 `X-Routed-Via`，不阻塞流（`packages/opencode/src/session/llm.ts`）。
- **Windows 僵尸子进程**：`cross-spawn-spawner.ts` 在 Windows 上直接 `return Effect.void` 跳过了非零退出码的子进程树清理，导致 `Start-Process`/`cmd /c start` 等启动的子进程变僵尸、内存持续增长。移除 Windows 提前返回，统一走 kill group 逻辑（`packages/core/src/cross-spawn-spawner.ts`）。

---

### [0.6.23] - 2026-06-23

> 系统提示词统一升级：deepseek/glm/mimo/minimax 全面增强，新增 Step 路由。融合 CC 最佳实践。

#### 变更

- **系统提示词全面增强**：以 deepseek.txt 为基准，融合 Claude Code 最佳实践，统一升级 6 个模型提示词（deepseek/glm/mimo/minimax/step）。新增"探索性问题不动手"、"如实汇报结果"规则；mimo/minimax 补齐 FIX SIBLINGS / THINK ARCHITECTURALLY / SURFACE TRADE-OFFS 三条规则。
- **Step 路由新建**：新增 `step.txt` + `system.ts` 路由（匹配 `step-`），Step 3.7 Flash 不再走旧 opencode default 提示词。

### [0.6.22] - 2026-06-23

> 补全 DeepSeek prefix cache 稳定性修复（MCP 工具排序 + tool key 排序 + system-reminder 注入时序）；AGENTS.md 新增纠正行为规范与注释格式规范；`/recall` 语义搜索增强。

#### 修复

- **MCP 工具顺序非确定性**：`Effect.forEach` 并发查询多个 MCP server 导致 tool 插入顺序随响应时序变化，破坏 prefix cache。改为顺序执行（`packages/opencode/src/mcp/index.ts`）。
- **Tool key 序列化顺序不稳定**：内建工具与 MCP 工具混合后 key 顺序不固定。resolve 后按 key 字母排序，保证 JSON 序列化 bytes 稳定（`packages/opencode/src/session/prompt.ts`）。
- **system-reminder 注入被 msgPin 缓存覆盖**：step>1 时对 user message parts 的 `<system-reminder>` 包裹在 msgPin 之前执行，缓存恢复后包裹丢失。改为在 modelMsgs 稳定化之后作为独立 user message 追加，不污染缓存前缀（`packages/opencode/src/session/prompt.ts`）。
- **注释格式不合规**：4 处 `// 260614 fix:` 缺 `Red` 标签、1 处 `// 260610 CC` 统一修正为 `// YYMMDD Red` 格式。

#### 变更

- **AGENTS.md**：新增"被纠正 → 先动手再开口"规则（被用户纠正后下一条回复必须以行动开头）+ 注释格式规范 `// YYMMDD Red xxx`。

#### 新增

- **`/recall` 语义搜索**：双路召回——关键词打分 + Ollama embedding cosine similarity 加权融合。有 Ollama 时自动启用语义路（`nomic-embed-text`），无 Ollama 时静默降级为纯关键词。支持 `--index` 预计算 embedding 缓存，MEMORY.md 变更后自动重建（`.opencode/scripts/recall-memory.mjs`）。

---

### [0.6.21] - 2026-06-22

> 修复 DeepSeek prefix cache 命中率随对话增长持续下降的问题，新增 LAN 访问支持。

#### 修复

- **DeepSeek prefix cache 命中率 cliff-drop**：DCP compaction 后 `cache_read` 从 139K 骤降到 52K 且持续冻结。根因是每次 turn 生成 model messages 时 DCP transform 和 AI SDK 转换链引入微小非确定性，导致 prefix bytes 逐轮变化。修复分两层——① 将 `toModelMessagesEffect` 的 `UIMessage[]` 构建抽成同步纯函数 `toUIMessages()`，消除 `Effect.fnUntraced` 内部的调度非确定性；② 新增 `_caches.modelMsgs` 缓存层，每轮发完 model messages 后快照，下一轮用缓存版本替换旧消息前缀，保证发往模型的 bytes 完全一致（`packages/opencode/src/session/message-v2.ts`、`packages/opencode/src/session/prompt.ts`）。

#### 新增

- **LAN 访问支持**：`redcode run` 新增 `--hostname` 参数，设 `0.0.0.0` 可监听所有网口，手机/平板可浏览器直连做临时 GUI（`packages/opencode/src/cli/cmd/run.ts`）。

#### 重构

- **`toModelMessagesEffect` 拆分**：同步纯函数 `toUIMessages()` 输出 `{ messages: UIMessage[], tools }`，使转换步骤可独立复用和测试（`packages/opencode/src/session/message-v2.ts`）。
- **build.bat 清理**：移除无效的 `full` 分支参数解析逻辑（`packages/opencode/build.bat`）。

---

### [0.6.20] - 2026-06-22

> X-Routed-Via 路由溯源 + build.bat 不再清空自定义 provider 配置。

#### 新增

- **X-Routed-Via 路由溯源**：捕获 LLM 响应头中的 `_routed_via` 字段（FreeLLMAPI 路由标识），存入 `Finish` 事件并在会话页脚显示路由来源（`packages/opencode/src/session/llm.ts`、`packages/opencode/src/cli/cmd/run/footer.view.tsx`）。

#### 修复

- **build.bat 不再清空自定义 provider 配置**：`build.bat` 会调 `sync-home.bat` 用仓库模板覆盖 `~/.redcode/redcode.jsonc`，导致 FreeLLMAPI 等自定义 provider 每次重编后丢失。修复方法：把 FreeLLMAPI 和 Step Plan provider 配置写入 `.opencode/redcode.home.jsonc` 模板，重编后不再丢失（`.opencode/redcode.home.jsonc`）。

#### 配置

- **阶跃星辰 Step Plan 接入**：新增两个 provider 配置到 `~/.redcode/redcode.jsonc`——`step-plan`（普通 API `api.stepfun.com/v1`，走余额）和 `stepfun`（Plan 模式 `api.stepfun.com/step_plan/v1`），模型 `step-3.7-flash`，用用户自有 key 鉴权。FreeLLMAPI 路由中已有的免费 `stepfun-step-3.7-flash` 保持不变（`~/.redcode/redcode.jsonc`）。

---

### [0.6.19] - 2026-06-25

> GLM/Qwen 提示词路由 + DCP compress 优先级 + build.bat 跳过 WebUI 重打包。

#### 新增

- **GLM/Qwen 提示词路由**：新增 `glm.txt` 强模型提示词（含 sibling-check/架构思维/trade-off 三条额外要求），`system.ts` 匹配 `glm`/`qwen` model ID 路由到精炼档，不再走 default 兜底（`packages/opencode/src/session/system.ts`、`packages/opencode/src/session/prompt/glm.txt`）。

#### 优化

- **DCP compress 优先级写入提示词**：deepseek/mimo/minimax 三个主力提示词新增"主动用 DCP compress，不等系统 auto-compact"指引，减少 compaction 触发导致的前缀缓存 miss（`packages/opencode/src/session/prompt/{deepseek,mimo,minimax}.txt`）。
- **build.bat 默认跳过 WebUI 嵌入**：日常编译用 `build.bat`（跳过 SPA 打包），需要完整嵌入时用 `build.bat full`，编译速度大幅提升（`packages/opencode/build.bat`）。

---

### [0.6.18] - 2026-06-22

> 新增 memory-auto-capture 插件 — 自动捕获被批评/被表扬/项目决策到每日日志。

#### 新增

- **memory-auto-capture 插件**：监听 `chat.message` 和 `experimental.session.compacting` 钩子，检测到用户批评、表扬、决策或要求记住时，自动追加到 `~/.redcode/memory/YYMMDD.md`，解决 agent 选择性遗忘问题（`~/.redcode/plugin/memory-auto-capture.ts`）。

---

### [0.6.17] - 2026-06-21

> Web UI 启动时从 API 种子项目列表，嵌入式 UI dev 模式加载修复。

#### 修复

- **Web UI 首次加载无项目**：手机/浏览器首次打开 Web UI 时，`server.projects.list()` 为空（无 localStorage 种子），页面只显示空白 loading。新增 `createEffect` 在启动时从 `globalSync.data.project` API 数据中写入项目列表，判断 `worktree.includes("redcode-test")` 跳过测试项目，做到首次加载立即可看（`packages/app/src/context/layout.tsx`）。
- **嵌入式 UI dev 模式 500 错误**：`serveUIEffect` 使用 bare import `import("redcode-web-ui.gen.ts")`，bun 从调用方模块目录（`src/server/shared/`）解析不到 gen 文件，退到 upstream proxy `https://app.redcode.dev` 又不可达，全请求返回 500。改为 bare import 失败后 fallback 到 CWD 相对路径加载，dev 模式下恢复正常（`packages/opencode/src/server/shared/ui.ts`）。

---

### [0.6.16] - 2026-06-20

> MCP 工具列表缓存优先加载 — 启动时立即可用，不等待 MCP server 就绪。

#### 优化

- **MCP 工具列表磁盘缓存**：MCP server 启动成功后，工具定义持久化到磁盘缓存。后续启动时若 server 未就绪或连接失败，自动回退到缓存工具定义，保证启动后立即可用（`packages/opencode/src/mcp/index.ts`）。

---

### [0.6.15] - 2026-06-20

> bun compile 模块重复实例化致前缀缓存失效修复 + MCP 孤儿进程泄漏修复。

#### 修复

- **DeepSeek 前缀缓存 bun compile 退化**：`bun compile --single` 下 `prompt.ts` 模块可能被实例化多次，导致模块级 `let` 缓存变量（`_systemCache`、`_chatCtxCache`、`_msgPinCache`）多副本不同步，系统提示词每轮字节级变化，前缀缓存命中率从 98% 骤降至 ~50%。迁移至 `globalThis.__rc_prompt_caches` 容器，绕过 bun compile 模块隔离，前缀在 session 内保持字节一致（`packages/opencode/src/session/prompt.ts`）。
- **MCP 孤儿进程泄漏（Windows）**：`connectLocal()` spawn 子进程后若连接失败，`transport.close()` → `process.kill()` 在 Windows 编译 exe 下不可靠，子进程成孤儿持续占锁/端口。`reconcile()` 热加载 1s 防抖看到失败重试 spawn 新进程，多次 config 写入 → 8+ 副本同时运行。修复：connect 前捕获 `transport.pid`，catch 分支调 `killProcessTree` 杀整棵树；新增 `creating` Set 防重入守卫（`packages/opencode/src/mcp/index.ts`）。

---

### [0.6.14] - 2026-06-18

> DCP 消息钉住 — 阻止 DCP 累积修改破坏 DeepSeek 前缀缓存。

#### 修复

- **DCP 累积修改致前缀缓存命中率下降**：DCP 的 `experimental.chat.messages.transform` 每轮对旧消息做累积修改（工具输出裁剪 `prune` 增量增长、压缩提示 `nudge` 锚点漂移、消息 ID 标签 `priority` 随裁剪变化），导致 DeepSeek 前缀从修改点起整段缓存 miss。经济账：裁剪省 ~$0.0005/轮，缓存 miss 多花 ~$0.01/轮，损失是收益的 20 倍。新增 `_msgPinCache`：DCP 转换后按 `msg.info.id` 缓存每条消息的 `parts`，后续轮次直接恢复缓存版本，前缀在整个 session 内保持字节一致。切换 session 自动清空（`packages/opencode/src/session/prompt.ts`）。

---

### [0.6.13] - 2026-06-18

> DeepSeek 前缀缓存退化修复 — _systemCache / _chatCtxCache 重建，命中率从 70% 恢复到 98%。

#### 修复

- **DeepSeek 前缀缓存退化**：Commit 7ee58bfcb 新增的 `_systemCache` / `_chatCtxCache` 缓存层被工作树回退约 30 行变更，导致 `instruction.system()` 每轮重读磁盘、`groupChatContext()` 每轮重查数据库，DeepSeek 前缀缓存命中率从 95%+ 骤降至 60-70%。通过 `git checkout HEAD` 恢复缓存逻辑；`groupChatContext()` 接受 sessionID 作为缓存键（`packages/opencode/src/session/prompt.ts`）。

#### 优化

- **依赖安全升级**：root catalog（solid-js 1.9.10→1.9.13、zod 4.1.8→4.4.3、ai 6.0.168→6.0.208）、opencode（immer 11.1.4→11.1.8、glob 13.0.5→13.0.6、@opentelemetry/api 1.9.0→1.9.1、@modelcontextprotocol/sdk 1.27.1→1.29.0）、desktop（electron 42.2.0→42.4.1），typecheck 全部通过。

---

### [0.6.12] - 2026-06-17

> LLM 依赖循环修复 — 提取 route 工具函数消除 packages/llm 菱形依赖。

#### 重构

- **LLM route 工具函数提取**：将 `route/client.ts` 中 `eventError`、`encodeJson`、`validateWith` 三个工具函数提取到 `route/errors.ts`，切断 client→protocols/shared 反向导入路径，消除 `packages/llm/src` 内 14 文件菱形依赖循环（`packages/llm/src/route/errors.ts`、`packages/llm/src/route/client.ts`）。

---

### [0.6.11] - 2026-06-16

> 缓存 miss 颜色显示 + type 级联修复。

#### 新增

- **缓存 miss 颜色显示**：miss 率 ≤20% 绿色（正常），≤50% 黄色（警告），>50% 红色（偏高）；与 cache hit 颜色阈值对称反转，miss 越低颜色越安全（`tui/component/prompt/index.tsx`）。

#### 修复

- **cache miss 字段缺失导致 typecheck 级联失败**：`types.gen.ts` 新增 `miss` 字段后，所有未含 `miss` 的 cache 类型定义报 TS 错误。根治：在核心 Schema (`message-v2.ts`) 的 `Assistant` 和 `StepFinishPart` cache 定义中补充 `miss: Schema.Finite`，确保所有派生类型自动包含 `miss`；同步修正 6 个 fixture/token 默认对象及 9 个测试文件中的对应类型（`session/message-v2.ts`、`session/prompt.ts`、`session/compaction.ts`、`cli/cmd/debug/agent.ts`、`cli/cmd/stats.ts`）。

---

### [0.6.10] - 2026-06-16

> 文档大扫除 + skill 触发词优化 + bump-version skill。

#### 修复

- **MANUAL.md 多处过时**：Browser MCP 标记已禁用；灵魂文件描述改为"自动注入+命令可选"；skill 表从 6 个扩充到 12 个并加触发词列；自定义 skill 说明改为 frontmatter 自动发现（不再需要注册 instructions）（`MANUAL.md`）。
- **README.en.md 过时**：Browser MCP 标记已禁用；配置路径从 `.opencode/opencode.jsonc` 改为 `.redcode/redcode.jsonc`（`README.en.md`）。
- **AGENTS.md 引用不存在的 skill**：`skill/auto-validate/SKILL.md` 已删除，改为内联说明（`AGENTS.md`）。
- **vision-autoagent 缺 frontmatter**：公开仓模板补 name + description，否则引擎无法发现（`.opencode/skill/vision-autoagent/SKILL.md`）。

#### 变更

- **Skill 触发词口语化**：所有 skill 的 description 加入中文口语触发短语（"帮我看看代码""查bug""太复杂了""小心点"等）；stop-slop/yuqi-slop 消歧为英文/中文分流。
- **新增 bump-version skill**："升版""bump""更新版本"触发，自动化 package.json→README 双语徽章→CHANGELOG→commit 全链（`~/.redcode/skill/bump-version/SKILL.md`）。

---

### [0.6.9] - 2026-06-16

> session 记录 client 字段 + Karina 主题配色优化。

#### 修复

- **Office 群聊会话分类误判**：`isTuiSession()` 原用 `directory.includes("redcode")` 判断，项目路径 `D:\AI\RedCode` 恒匹配导致所有会话都归 TUI。根治：session 创建时写入 `client` 字段（`flags.client`：desktop=GUI，cli=TUI），前端优先读 client 精确分类；老会话无 client 走标题前缀 `[宋雨琦]`/`[GUI]` fallback（`session/session.ts`、`session/session.sql.ts`、`app/pages/chat/index.tsx`、migration `20260616065539_session_client`）。

#### 改进

- **Karina 主题配色**：新增柳智敏应援色（品红 `#8d0079`、黄色 `#efd500`），标题→金色、链接→青色、链接文字→蓝色、行内代码→绿色、代码块语法高亮→多色、列表序号→品红。清理 opentui 不支持的条目（斜体/加粗/引用/列表项文字无 TextMate scope，设为基底白色避免误导）（`theme/karina.json`）。
- **缓存命中率显示精确到两位小数**：TUI 输入框下方 `Cache hit 98.50% · miss 1.50%` 从一位改为两位小数（`tui/component/prompt/index.tsx`）。

---

### [0.6.8] - 2026-06-16

> 写入侧乱码护栏 — write/edit 写入前检测私用区字符/替换符，拦住"把文件写成乱码"。

#### 修复

- **写入乱码护栏**：新增 `Bom.detectGarbled()`，统计私用区字符(PUA E000–F8FF)/Unicode 替换符(U+FFFD)——这是 GBK 错解 UTF-8 的乱码标志，正常文本几乎不含。write 写入前、edit 三个写入点（普通×2 + hashline）全检测，超保守阈值（FFFD 占比 >0.5% 或 PUA >30 个且占比 >2%）即拒绝写入并报错引导"用 read 重读 UTF-8 原文，勿写回乱码"。根治"用错误编码读取后把乱码写回固化文件"这类事故（SKILL.md 曾被写成 72 个 PUA）；不误伤正常文本/少量 Nerd Font 图标（`util/bom.ts`、`tool/write.ts`、`tool/edit.ts`）。

---

### [0.6.7] - 2026-06-16

> 会话标题加来源前缀 — 自动命名时标注 `[人格名/TUI/GUI]`，会话列表一眼区分是哪个 agent 起的。

#### 新增

- **会话标题来源前缀**：session 第一句话自动生成标题时加来源前缀——从对应 soul 文档第一行 `# 名字 · ...` 提取人格名（GUI→`[宋雨琦]`、TUI→`[柳智敏]`），通用 RedCode 无 soul / 非标准格式自动 fallback `[GUI]`/`[TUI]`（不写死人格名）。解决 Office 多会话分不清是 TUI(敏敏) 还是 GUI(小宋) 起的痛点。client 经 `REDCODE_CLIENT` 区分（desktop=GUI，其余=TUI），与 soul 注入同源（`session/prompt.ts` 的 `title()` + 新增 `sessionSourceLabel` helper）。

---

### [0.6.6] - 2026-06-16

> 修复 read/edit 读文件崩溃 — `Bun.hash` 在 GUI 的 Node sidecar 里 undefined，导致小宋读任何文本文件都报 `Bun is not defined`。

#### 修复

- **read/edit 文件指纹跨运行时崩溃**：6-10 引入 hashline 编辑时，`read.ts`/`edit.ts` 各自用 `Bun.hash.xxHash32` 算文件指纹 `[path#TAG]`。TUI 是 `bun --compile` 二进制（有 `Bun` 全局）正常，但 **GUI 的 sidecar 跑在 Electron 的 Node 运行时**（`process.parentPort` + `node:` 模块，无 `Bun` 全局）——读任何文本文件都在 `computeFileHash` 抛 `ReferenceError: Bun is not defined`，与文件编码无关。修法：抽出 `Hash.fileTag()`（`core/util/hash.ts`，改用 `node:crypto` 的 sha1 取前 16bit），read 产 tag、edit 校验 currentHash 共用同一跨运行时实现，删除两处重复的 `computeFileHash`。输出仍为 4 位大写 hex，碰撞空间不变（`tool/read.ts`、`tool/edit.ts`、`core/util/hash.ts`）。
- **markitdown MCP 服务器连接失败**：`~/.redcode/redcode.jsonc` 中 markitdown 的 `command` 错写为 `["markitdown-mcp-npx"]`，但实际安装的可执行文件是 `markitdown-mcp`（通过 `pip install markitdown-mcp` 安装在 Python Scripts 目录）。修正命令名称即可恢复连接（`~/.redcode/redcode.jsonc`）。

---

### [0.6.5] - 2026-06-15

> Office 多 agent 群聊后端 — 用户在群聊发消息，服务端自动派 TUI + GUI 两个 agent 顺序回复，打通跨 persona 协作。

#### 新增

- **Office 群聊多 agent 编排**：群聊 `office` 房间收到用户消息后，后台 fork 异步派发——TUI(敏敏) 先响应、GUI(小宋) 看到 TUI 回复后再响应，两条回复回写 chat room。各持独立持久化 session（`Office Group — TUI`/`GUI`）维持各自上下文，每 agent 注入专属 persona 系统提示词（TUI=后端/架构、GUI=前端/UI）（`server/routes/instance/httpapi/handlers/chat.ts`）。
- **主 agent 群聊感知**：主 agent（非子代理）系统提示词注入 office 群聊最近 10 条消息，知晓协作指令与对方进度，子代理不注入省 token（`session/prompt.ts`）。

---

### [0.6.4] - 2026-06-15

> MCP 生态扩充 — 进程管理 + SQLite 查询两个本地插件，配套工具优先级引导。

#### 新增

- **`mcp-process-mgmt` MCP 服务器**：从 DesktopCommanderMCP 提取进程管理核心，精简为独立 MCP 插件（`plugins/mcp-process-mgmt/`）。提供 6 个工具：`start_process`（启动 shell 或执行命令）、`send_input`（写入 stdin）、`read_process_output`（分页读取输出）、`wait_for_prompt`（等待 REPL 提示符）、`list_processes`（列出活跃 session）、`stop_process`（强制终止）。依赖从 25+ 个减至 2 个（`@modelcontextprotocol/sdk` + `zod`），适配 Windows `cmd.exe`。
- **`mcp-sqlite-query` MCP 服务器**：基于原生 `node:sqlite` 的轻量查询插件（`plugins/mcp-sqlite-query/`），提供 `sqlite_query`（执行 SQL）、`sqlite_schema`（查表结构）两个工具，结构化返回、免 shell 转义。

#### 优化

- **MCP 工具优先级引导**：`mcp-gate.js` 提醒文案补充 `get_call_hierarchy`（调用链）、`get_blast_radius`（改动影响面）、`get_symbol_source`（取定义源码）三个 grep 物理做不到的能力，引导改代码前先摸清依赖；新增两个 MCP 的 `description` 标注使用时机（sqlite 优先于 `bash sqlite3`、process-mgmt 仅管交互/长驻进程），让模型按场景自选（`.opencode/redcode.home.jsonc`）。

---

### [0.6.3] - 2026-06-15

> TUI 视觉优化 + 构建简化 — 侧栏分隔线/MCP 错误醒目/底栏紧凑化/品牌修正；build.ts 砍掉跨平台根治 ghostty-web 504；启用内置 LSP。

#### 布局调整

- **侧栏圆角边框**：整体加 `rounded` 圆角框（`╭╮╰╯`）+ 暗色边框色，品牌版本号嵌入底部边框线 `bottomTitle`，不再占独立行（`session/sidebar.tsx`）
- **侧栏 section 内嵌标题**：手写 `─` 分隔线改 `border={["top"]} + title`，标题嵌在分隔线里（`─ MCP 7/9 ─`、`─ LSP 2 ─`、`─ Todo 3/5 ─`、`─ Files 4 ─`），折叠箭头 `▼▶` → `▾▸`（`sidebar/{mcp,lsp,todo,files}.tsx`）
- **对话框圆角边框**：弹窗外框加 `rounded` 圆角框 + 暗色边框色，更有层次感（`ui/dialog.tsx`）
- **MCP 错误醒目化**：failed / needs_auth / needs_client_registration 条目前缀从 `•` 改 `⚠`，名字和状态文字着 error 红色，一眼可辨（`sidebar/mcp.tsx`）
- **底栏信息优化**：MCP 改紧凑格式 `⊙ MCP 7/9 ⚠2`（连接/总数+错误数）；末尾加 `^p cmd  ^x +` 快捷键提示；LSP 无连接时隐藏（`session/footer.tsx`）
- **侧栏品牌修正**：底部 `OpenCode` → `RedCode`（`session/sidebar.tsx`）

#### 配置

- **启用内置 LSP**：`redcode.jsonc` 加 `"lsp": true`，内置 38 种 LSP server 按文件扩展名自动探测启动（TypeScript/Go/Rust/Python 等），侧栏显示连接状态（`redcode.jsonc` + `.opencode/redcode.home.jsonc`）

#### 构建

- **build.ts 简化为 Windows 单平台**：移除 12 个跨平台 target（linux/darwin/musl/baseline）和 `--single`/`--baseline`/`--skip-install` flag，不再需要 `bun install --os="*"` 全平台原生依赖解析——根治 ghostty-web GitHub API 504 导致编译失败的问题（`script/build.ts` + `build.bat`）

---

### [0.6.2] - 2026-06-15

> 工作流稳定性 + MCP 生态扩展 — 把"搜代码先 MCP""不确定先停下问"从必漂的提示词软约束，下沉到插件 hook 硬层；新接入 MarkItDown/Semgrep/DBHub，修复 jcodemunch Win 编码崩溃。

#### 新增

- **MCP 优先门禁插件 `mcp-gate.js`**：用 `tool.execute.after` 拦 grep，每会话首次在结果尾部追加一次"代码符号优先 jcodemunch/typegraph"提醒、之后静默。根因——"搜代码先 MCP"写在提示词里是软约束，对抗不过预训练里 grep 的海量先验而漂移；hook 是代码层 `if`，稳定触发，补上"执行时负反馈"（`~/.redcode/plugin/mcp-gate.js`）
- **三新 MCP 接入**：MarkItDown（文档转 Markdown）、Semgrep（结构代码搜索）、DBHub（SQLite inspects 工具）。MarkItDown 从 git 源码装 0.0.1a5（PyPI 版缺 server 入口），`--no-deps` 绕过依赖冲突；Semgrep 1.166.0，clone semgrep/mcp repo 到 mcp-servers 目录；DBHub 全局 npm 安装，`--demo` 模式（`~/.redcode/redcode.jsonc`）

#### 变更

- **工作流逃逸口收紧**：AGENTS.md 任务循环第 1 步原文"模糊或不可逆才停下来问用户，**否则继续**"自带逃逸许可——模型"意识到不理解"时援引"否则继续"闷头干。改为"没把握/不理解/不可逆时**默认停下问**，只有需求清晰且可逆才直接动手"，直接压 completion bias（`AGENTS.md`）

#### 修复

- **敏敏称谓不稳（用"你"不叫"哥哥"）**：根因是人格 few-shot 示例的回答里一个称谓都没有（对照另一人格每条都带），模型照着示例学会了不叫。6 句示例全部补上称谓 + 新增"我的工作习惯"段植入 MCP 优先（`~/.redcode/souls/Tsoul.md`）
- **jcodemunch Windows GBK stderr 崩溃**：`run_stdio_server()` 往 stderr 打印含 💀 emoji 的 banner，Windows 控制台默认 GBK 编码无法转义，stdio 初始化失败。配置加 `PYTHONIOENCODING=utf-8` 解决（`~/.redcode/redcode.jsonc`）
- **mcp SDK 版本冲突**：semgrep 1.166.0 依赖 `mcp` SDK ≥1.27.0（新增 `transport_security` 模块），而 markitdown 锁的版本太低。统一将 mcp SDK 升级至 1.27.2（pip install -U mcp）
- **DeepSeek/MiMo 计费改用官方 CNY 定价**：models.dev USD 值经汇率换算存在精度损失；现 `models-dev.ts` 对已知模型直接注入官方 ¥/M 价格（Flash: input=1/output=2/cache=0.02，Pro: input=3/output=6/cache=0.025），`provider.ts` 同步覆盖。TUI 侧 `sidebar/context.tsx` 按 providerID 判断币种，CNY 直显/USD 按 6.76 换算

#### 清理

- **移除损坏的 gbrain MCP**：gbrain 二进制 bin 元数据损坏（装自已清理的 `Temp/gbrain-clone`）导致长期"老断"，且其核心"存/查记忆"功能被轻量本地的 su-prememory（SQLite+FTS5）完全覆盖。从配置移除，数据目录备份至 `~/.gbrain.bak`，卸载 bun 全局包（`.opencode/redcode.home.jsonc`）

---

### [0.6.1] - 2026-06-14

#### 修复
 - **粘贴图片被 LLM 拒绝后 vision MCP 找不到文件**：非多模态模型（DeepSeek）提交图片时，`unsupportedParts()` 只替换 base64 data URL 为错误文本，从不落盘。现改为在抛弃前将 base64 解码写入 `%TEMP%/redcode-vision-{timestamp}.{ext}`，并在错误文本追加 `TEMP_FILE:<path>` 供 vision-autoagent 直接读取（`provider/transform.ts`）
 - **修复数据字段名错误**：`savePartToTemp` 最初读取 `FilePart.url`（始终 undefined），AI SDK v4 FilePart 实际使用 `data` 字段。同时 `ImagePart.image` 可能是 `Buffer`/`Uint8Array`，非纯 base64 字符串，现已原生处理二进制数据。修完后图片正确落盘，`TEMP_FILE:` 路径正常输出（`provider/transform.ts`）
 - **vision-autoagent SKILL.md 缺少 TEMP_FILE 路径优先检查**：新增第 2 步——从错误消息中提取 `TEMP_FILE:` 路径直接调用 vision MCP，不再盲目按文件名搜索（`~/.redcode/skill/vision-autoagent/SKILL.md`）

---

### [0.6.0] - 2026-06-13

> RedCode Office — 虚拟办公室 / 聊天室。敏敏 + 小宋 + 哥哥在同一个界面里协作，不再开三个 exe 来回切换。

#### 新增

- **RedCode Office 聊天室 UI**：标题栏新增聊天气泡按钮（`chat-bubble` 图标），点击进入 `/chat` 路由，填满整个窗口区域（`titlebar.tsx` + `layout.tsx` + `pages/chat/index.tsx`）
- **聊天室侧栏 session 列表**：左侧按 TUI(敏敏)/GUI(小宋)/Group(办公室) 三个头像分组，点击展示该 agent 的所有 session 历史，按 `directory.includes("dist")` 区分 TUI/GUI（`pages/chat/index.tsx`）
- **ChatRoom + ChatMessage DB schema**：两表（`chat_room` / `chat_message`），sender 支持 `user`/`tui`/`gui`，可选关联 `session_id`（`src/chat/chat.sql.ts` + `migration/20260612082823_chat_room/`）
- **Chat Service 层**：`ensureRoom` / `sendMessage` / `getMessages` / `getLastMessage`，同步 Drizzle 模块（`src/chat/index.ts`）
- **Chat HTTP API**：Effect HttpApi 三端点 — `POST /chat/room/:roomId`(ensureRoom)、`GET /chat/room/:roomId/message`(messages)、`POST /chat/room/:roomId/message`(send)，send 自动 ensureRoom（`groups/chat.ts` + `handlers/chat.ts`）
- **办公室群聊**：`/chat` 页面的 Group 联系人可发送/接收消息，走 `chat_message` 表，3 秒轮询

#### 变更

- **移除跨会话感知（recentSessionDigest）**：不再每轮往系统提示词注入最近 10 条 session 摘要，省 ~500 token/轮。协作改由聊天室实现（`instruction.ts`）

> **Office 后续计划（0.6.3+）**：点击 session 查看对话详情 / 聊天室 ↔ agent 同步机制 / `@敏敏`/`@小宋` 路由 / 在线状态显示 / UI 对齐小宋主题（毛玻璃/背景图/头像）

---

### [0.5.9] - 2026-06-13

#### 优化

- **侧栏 context 面板五彩颜色 + 累计 total**：各 token 指标用鲜艳颜色区分（红色 context/淡紫 total/琥珀 in/绿 out/橙 reason/蓝 cacheRead/紫 cacheWrite/粉 cost），新增 session 累计 total token 行（`sidebar/context.tsx`）

#### 修复

- **TUI 侧栏费用 USD 显示为 ¥ 汇率缺失**：models.dev 定价以美元计，但侧栏 `money.format(cost())` 直接用 CNY 格式化，未乘以汇率，实际少显示了很多。添加 `USD_TO_CNY = 7.2` 汇率换算，与 GUI 侧保持一致（`sidebar/context.tsx`）
- **侧栏 input 与 context 颜色重复**：input 和 context 都用了红色系（`#ef5350` 与 `#ff5252`），视觉上难以区分。input 改为琥珀色 `#ffb300`（`sidebar/context.tsx`）

#### 清理

- **Console mail 死代码**：移除未使用的 `Wbr` / `WbrProps` / `SplitString` 组件（`packages/console/mail/emails/components.tsx`）

### [0.5.8] - 2026-06-13

#### 修复

- **缓存命中率断崖（6/12 分水岭根因）**：`recentSessionDigest()` 用相对时间戳（`5m ago`）注入系统提示词，每轮都变 → DeepSeek 自动前缀缓存全部失效 → 每轮 100% cache miss。改为绝对时间（`06-13 15:30`），系统提示词在会话内不再变化，前缀缓存恢复（`instruction.ts:39-46`）
- **小宋 memory 文件覆盖/乱码（根因链）**：① Gsoul 第 43 行"写文件一律用 write 工具"→ `write` = 覆盖 → 已有 memory 丢失 ② 发现丢了用 bash `echo >>` 追加 → Windows GBK 编码 → 中文乱码 ③ 发现乱码再 write 重写 → 重复内容。修复：Gsoul 改为"read+edit 先读后改"，memory-automation SKILL.md 加 "How to append" 示例，提示词加 CRITICAL 编码警告
- **小宋简单任务过度探索**：改 CHANGELOG 等已知文件时派 4 轮 explore 子代理 + 多次 Shell 读取，耗时 5-6 分钟。提示词加"简单任务直接 read+edit，不派子代理"

#### 优化

- **系统提示词瘦身 ~4KB/轮**：`redcode.jsonc` instructions 移除 `guardrail-profiles`、`defensive-agent` 两个 SKILL.md 全文注入，改为 skill 机制按需加载
- **三档提示词（deepseek/mimo/minimax）强化工具纪律**：CRITICAL 级 Windows 编码警告（读+写都不用 Shell），简单任务禁止 explore

#### 变更

- **小宋人设优化（Gsoul）**：基于真实宋雨琦性格（北京大妞、开口即段子、容易害羞、豪爽直率）调整。工作行为与敏敏对齐——先查再做、冷静高效，人格差异只体现在语气风格上。移除"利索"等速度暗示，消除 soul 与工作纪律的冲突
- **敏敏人设优化（Tsoul）**：基于真实柳智敏性格（"猪猪蛇"反差、外冷内软、完美主义、ENFP）丰富。补充私下软萌黏人面、完美主义代码洁癖。工作习惯不变
- **新用户 skill 自动播种**：bootstrap 启动时将 `.opencode/skill/` 子目录自动复制到 `~/.redcode/skill/`（跳过已有），新用户拉取后首次运行即可使用全部 skill（`bootstrap.ts`）
- **移除 exa-search MCP**：与 web-search 功能冗余，且极少使用。直接删除配置节约启动 token（~600 tokens/turn）（`~/.redcode/redcode.jsonc`、`.opencode/redcode.home.jsonc`）
- **新增 hot-trends skill**：`看热点` 触发，聚合 GitHub Trending（webfetch 爬取）+ B站排行（agent-reach_search_bilibili）+ 抖音热榜（web-search）。agent-reach 保留用于按需查询（`~/.redcode/skill/hot-trends/SKILL.md`）

### [0.5.7] - 2026-06-14

#### 修复

- **缓存命中率 100% bug**：opencode-go 代理不返回 DeepSeek `promptCacheMissTokens` 元数据，导致 `read / (read + 0)` = 100%。改为 miss/write 均为 0 时，用 `input`（实际输入 token）做分母兜底（context.tsx、prompt/index.tsx、subagent-footer.tsx、session-data.ts、session-context-metrics.ts）
- **`cache.write` 始终为 0**：DeepSeek 走 `@ai-sdk/openai-compatible` 时 `prompt_cache_miss_tokens` 不会被映射到 AI SDK 字段，`metadata.deepseek.promptCacheMissTokens` 始终 undefined。改为通过 `adjustedInputTokens`（AI SDK 报告的缓存调整前输入）推算 miss token，确保 cache 数据完整性与持久化（`session.ts` `getUsage()`）
- **TextNodeRenderable 裸 number 渲染崩溃（全面修复）**：OpenTUI `<text>` 只接受 string，多处直接渲染 number 导致致命错误。全面审计 TUI 所有 tsx 文件，共 16 处全部改为模板字符串。涉及：底栏 cacheHitPct/mcp count、侧边栏 messageCount/mcp on/bad、session-v2 numResults/questions count/grep count/matches count、dialog-status MCP/LSP/formatter/plugin count、footer permissions/lsp/mcp length、index reverted/diagnostic/webSearch numResults、subagent-footer index/total、diff-viewer files count（`prompt/index.tsx`、`sidebar/context.tsx`、`sidebar/mcp.tsx`、`session-v2.tsx`、`dialog-status.tsx`、`routes/session/footer.tsx`、`routes/session/index.tsx`、`routes/session/subagent-footer.tsx`、`feature-plugins/home/footer.tsx`、`diff-viewer.tsx`）
- **FFF MCP 配置缺失**：0.5.6 全局目录整合后，`~/.redcode/redcode.jsonc` 的 MCP 段未包含 fff，TUI 找不到该服务器。补回 `~/.redcode/redcode.jsonc` `mcp.fff` 定义（本地 exe，cwd `$REDCODE_ROOT`，60s timeout）
- **默认主题被 getCustomThemes 错误覆盖为 opencode**：`init()` 中 `getCustomThemes()` 扫描已不存在的 `~/.config/redcode/themes/` 目录后抛错，catch 将其强制设为 `"opencode"`，覆盖了 store 默认的 `"karina"`。改为 fallback 到 `"karina"`（`theme.tsx` catch handler）
#### 变更

- **侧边栏缓存百分比移至底栏**：侧边栏 `cache X,XXX,XXX (98.5%)` 因 row 宽不足换行，去掉百分比显示，仅保留 token 数字。百分比移到底栏 color-coded 显示（≥80 绿 / ≥50 黄 / ≥20 灰 / <20 红），一眼判断缓存效率（`sidebar/context.tsx`、`prompt/index.tsx`）

### [0.5.6] - 2026-06-13

#### 变更

- **全局目录统一到 `~/.redcode/`**：废弃 XDG 散落的 4 个目录（`~/.config/redcode`、`~/.local/share/redcode`、`~/.local/state/redcode`、`~/.cache/redcode`），全部收归 `~/.redcode/` 下子目录（`data/`=数据库+auth+log、`state/`=会话状态、`cache/`=bin 缓存）。config 直接用 `~/.redcode/` 根目录（已有 redcode.jsonc/souls/skill）。移除 `xdg-basedir` 依赖，不再依赖 XDG 规范。一个目录管所有，private git 统一跟踪（`packages/core/src/global.ts`）

### [0.5.5] - 2026-06-13

#### 修复

- **TUI 侧边栏 Orphan text 崩溃**：`sidebar/context.tsx:136` cacheHit 命中率显示的 `<span>` 裸放在 `<box>` 下，没被 `<text>` 包裹。当 cacheHit 不为 null 时 Ink/SolidJS TUI 抛 Orphan text error 致命崩溃。给 `<span>` 外套 `<text>` 修复。感谢小宋发现并修好 😏

### [0.5.4] - 2026-06-12

#### 修复

- **缓存命中率分母修正（input 不应计入分母）**：0.5.3 引入的全会话聚合缓存率中，分母使用了 `input + read + write`。但 input tokens 是未命中缓存的 fresh 输入，不应算入 cache 有效请求总数。修正为 `read + write`，使缓存命中率与 API 后台显示的数值一致（如 `read=100K, write=50K, input=200K`，之前算得 `28.6%`，修正后 `66.7%`）。涉及 TUI 侧边栏、底栏、子代理 footer 三处（`sidebar/context.tsx`、`prompt/index.tsx`、`subagent-footer.tsx`）+ GUI 指标面板（`session-context-metrics.ts`）+ CLI run data（`session-data.ts`）
- **插件 `~` 路径扩展**：`isPathPluginSpec` 和 `resolvePathPluginTarget` 支持 `~`/`~/` 开头的文件路径，自动展开为用户的 home 目录（`src/plugin/shared.ts`）

#### 新增

- **侧边栏缓存命中率区间颜色**：`< 50%` 红色（`error`）、`50%~80%` 黄色（`warning`）、`>= 80%` 绿色（`success`），一眼判断缓存效率（`sidebar/context.tsx`）
- **默认主题改为 Karina**：程序首次启动时自动加载 Karina 主题（深蓝钢色调），而非之前的默认 opencode 主题（`theme.tsx`）
- **侧边栏 Context 面板全面上色**：provider 用 `secondary`、model 用 `primary`、input/output 分 cyan/green 区分、reasoning 用橙色醒目标识、cache read/write 分色显示、费用用 `primary` 高亮、agent 名用 `accent`。告别全灰扁平，花花绿绿一眼可读（`sidebar/context.tsx`）

### [0.5.3] - 2026-06-12

#### 新增

- **跨会话感知（cross-session awareness）**：新会话启动时自动注入最近 24 小时内的其他会话摘要（标题、persona、统计），让敏敏/小宋互相知道对方做了什么，避免重复修改同一文件。查询共享 SQLite DB，按 `directory` 字段自动识别 TUI（敏敏）vs GUI（小宋）身份。每条格式 `[Xm ago] [小宋/GUI] 标题 (+N/-N, M files)`（`src/session/instruction.ts` `recentSessionDigest()`）
- **缓存命中率改为全会话聚合**：之前只取最后一条 assistant 消息的缓存率（≈99%），与 DeepSeek/MiMo 后台显示的 ~95% 不符。改为遍历全部 assistant 消息求和 `read/(input+read+write)`，结果与后台一致。影响 TUI 侧边栏、底栏、子代理 footer 三处显示（`sidebar/context.tsx`、`prompt/index.tsx`、`subagent-footer.tsx`）+ GUI 指标面板（`session-context-metrics.ts`）
- **anti-deferral 规则**：系统提示词（deepseek/mimo/minimax 三档）+ AGENTS.md 红线 + souls 人格文件均加入禁止"先放着/回头处理"规则，杜绝 code agent 询问是否搁置问题的行为。soul 文件同步删除"要不要…还是…"模板，强化"发现问题就修、做不到直说"（`prompt/{deepseek,mimo,minimax}.txt`、`AGENTS.md`、`.opencode/agents/{Gsoul,Tsoul}.md`）

#### 修复

- **跨会话感知 persona 判断逻辑修正**：cc 原始实现 `directory.includes("dist") ? "小宋/GUI" : "敏敏/TUI"` 逻辑反了——TUI 从 `packages/opencode/dist/...` 启动，应标记为敏敏。修正为 `directory.includes("dist") ? "敏敏/TUI" : "小宋/GUI"`（`src/session/instruction.ts`）
- **跨会话感知时间戳单位不匹配（毫秒/秒）**：`recentSessionDigest()` 两处使用 `Date.now() / 1000`（秒）与 DB 中毫秒级 `time_updated` 比对和计算，导致（1）24h 过滤器对毫秒级 `gte` 永远为 true 形同虚设，（2）`ago` 显示为巨量负数（如 `-29657816216m ago`）。修正为统一使用毫秒：cutoff 加 `* 1000`，`ago` 计算先除 `1000` 再除 `60`（`src/session/instruction.ts`）

#### 配置

- **DCP + token-compressor 共存确认**：验证两插件 hook 层完全不重叠（DCP: `messages.transform`/`system.transform`/compress 工具；TC: `tool.execute.after`），效果叠加无冲突。DCP 管去重/压缩/nudge，TC 管精细规则截断（`redcode.jsonc`）

### [0.5.2] - 2026-06-12

#### 修复

- **token-compressor 插件导致流式中断**：小宋写的 `token-compressor.js` 插件（意图替代 DCP）在 `experimental.chat.messages.transform` hook 中有致命 bug——`lastUserMessageTurn` 永远为 0，导致 `messagesSinceLastUser = turnCount` 无限增长，15 轮后每次请求注入畸形 `{role: "system"}` 消息，API 调用挂起。根因→状态变量从未被更新（`~/.redcode/plugin/token-compressor.js`）
- **DCP 移除后 compaction 永不触发**：DCP 被注释掉后，引擎 compaction 依赖 `model.limit.context`（现代模型 100 万+），197K token 也不触发压缩。根因→无兜底阈值（`src/session/overflow.ts`）

#### 新增

- **engine compaction.threshold 配置**：config schema 新增 `compaction.threshold` 字段（NonNegativeInt），当 token 总量超过该值时强制触发 compaction，不依赖模型声明的 context limit。设为 150K，作为 DCP 之外的引擎级兜底（`src/config/config.ts` + `src/session/overflow.ts`）
- **token-compressor 插件重写（基于 TokenJuice）**：完全重写为仅用 `tool.execute.after` hook 的安全插件，不碰消息管道。移植 openhuman/TokenJuice 的 14 条规则（git/cargo/tsc/npm/bun/docker/find/ls/grep + 通用兜底），支持 skip/keep/head/tail/failHead/failTail/counters/onEmpty。pass-through 安全：<512 字节不压、压缩率 >95% 不替换（`~/.redcode/plugin/token-compressor.js`）

#### 配置

- **DCP 插件恢复**：`@tarquinen/opencode-dcp` 重新启用（v3.1.12），与 token-compressor 分工——DCP 管去重/compress 工具/nudge（`messages.transform` 层），token-compressor 管精细规则截断（`tool.execute.after` 层），两者不同 hook 层互不冲突（`redcode.jsonc`）

### [0.5.1] - 2026-06-12

#### 修复

- **ast-grep native binding 启动崩溃**：`import("@ast-grep/napi")` 在 Tool.init 阶段立即执行，bun compile 后的单文件二进制找不到 native module → 服务端 fatal crash（TUI 闪退 / GUI sidecar 500）。改为 lazy load：init 时只创建 getter，首次调用 ast_grep 工具时才 import，单例缓存后续复用（`src/tool/ast_grep.ts`）
- **plugin undefined hook → provider 500**：`snip.js` 导出裸函数 `toolExecuteBefore`（不是 Plugin factory），被 `getLegacyPlugins` 当 factory 调用后返回 undefined，push 进 hooks 数组。后续 `provider.ts` / `plugin/index.ts` 遍历 hooks 时在 undefined 上访问 `.provider` / `.auth` / `.config` 属性直接 TypeError 500。修法→`applyPlugin()` 对 `server()` / legacy factory 返回值做 null guard，undefined 不入 hooks（`src/plugin/index.ts`）
- **provider 遍历 null guard**：`provider.ts:1258` 的 `for (const hook of plugins)` 增加 `if (!hook) continue` 防御，即使 hooks 数组混入 undefined 也不崩（`src/provider/provider.ts`）

#### 配置

- **移除不存在的 npm plugin 声明**：`redcode.home.jsonc` 中 `"plugin": ["@tarquinen/opencode-dcp", "opencode-snip"]` 两个包未安装到 node_modules，plugin loader 加载失败后产生空 hook 触发上述 provider crash。注释掉声明（`.opencode/redcode.home.jsonc`）
- **compaction 参数适配 100 万 token 窗口**：`preserve_recent_tokens` 从 2K-8K 调至 64K，`reserved` 从 20K 调至 50K，`tail_turns` 从 2 调至 3。减少频繁压缩，长对话体验更流畅（`~/.redcode/redcode.jsonc`）

#### 改进

- **编辑后自动验证（auto-validate skill）**：借鉴 RedsWhale 的 LSP post-edit 钩子，新建 `auto-validate` skill——每次 edit 源代码文件后立即触发 typecheck/test，形成紧密反馈循环，不用等到任务结束。AGENTS.md 工作方式章节同步更新（`~/.redcode/skill/auto-validate/SKILL.md` + `AGENTS.md`）

### [0.5.0] - 2026-06-11

#### 新增

- **`git` 工具**：新增内置 git 工具，封装 Git.Service 为 LLM 可用的结构化 git 操作——支持 `status`（工作树状态）、`diff`（差异对比）、`log`（提交历史）、`show`（历史文件内容）、`branch`（分支信息）、`stash_list`（暂存列表）。返回格式化输出，比 shell 执行 git 更易解析（`src/tool/git.ts` + `git.txt`）
- **`env` 工具**：新增内置 env 工具，提供环境信息检索——支持 `platform`（OS/版本/架构）、`paths`（关键路径）、`memory`（内存/磁盘）、`cpu`（内核/型号），以及按名称查询特定环境变量。用于调试环境问题、确认工具可用性、检查系统配置（`src/tool/env.ts` + `env.txt`）
- **工具 descriptions 升级为"pushy"风格**：为 `ast_grep`、`webfetch`、`skill` 等工具增加更明确的使用时机指引（OMP 风格），告诉模型"什么时候用这个、什么时候用别的"，减少错误触发

#### 变更

- **Tree-sitter 解析器新增 PowerShell 支持**：`tree-sitter-powershell` 已加入依赖，shell 工具可正确解析 PowerShell 命令的路径参数

#### 修复

- **缓存命中率二次修正**：0.4.15 的修法有误——DeepSeek API 只有"命中/未命中"两档，未命中 token 由 AI SDK 放入 `tokens.input`（调整后非缓存输入），`cache.write` 对 DeepSeek 始终为 0，导致改后公式 `read/(read+0)` 仍约等于 100%。正确公式为 `read/(input+read+write)`，分母恒等于全部 prompt token（命中+未命中），无论未命中 token 落在哪个桶均成立。结果现与 DeepSeek 开放平台显示一致（如 95.8%），而非永远 99-100%（`sidebar/context.tsx`、`prompt/index.tsx`、`subagent-footer.tsx`、`session-data.ts`）

### [0.4.16] - 2026-06-11

#### 新增

- **敏敏人格主题（Karina）**：新增内置主题 `karina`，冷蓝灰色调（primary `#7eb8da`、accent `#8ba2c6`），完整 dark/light 双模式 47 色，TUI 是敏敏主场（`context/theme/karina.json` + `theme.tsx` 注册）

#### 修复

- **TUI 启动闪退（ConfigJsonError）**：根因→`~/.redcode/redcode.jsonc` 中文注释被 GBK 编码损坏（乱码 `鍏ㄥ眬娉ㄥ叆`），JSONC 解析器在损坏行报 `ColonExpected` 崩溃；改法→源模板 `.opencode/redcode.home.jsonc` 所有注释改纯 ASCII 英文，杜绝 bat/git 编码转换再次破坏

#### 变更

- **TUI 中文适配全面落实**：80+ 条 tips 翻译（`tips-view.tsx`）；toast/dialog 全量中文化（`app.tsx`、`dialog-status.tsx`、`dialog-help.tsx`、`error-component.tsx`、`dialog-select.tsx`、`dialog-alert.tsx`、`dialog-prompt.tsx`、`dialog-export-options.tsx` 等 13+ 文件）；命令面板标题中文化（"切换模型/代理/主题"等）

### [0.4.15] - 2026-06-11

#### 新增

- **双层记忆系统**：引擎自动注入项目级 `.redcode/MEMORY.md`（项目专有备忘）；项目级不存在时回退全局 `~/.redcode/MEMORY.md`（跨项目通用教训）。解决了之前 MEMORY.md 不自动加载、跨项目教训丢失的问题（`session/instruction.ts` `systemPaths()`）
- **新项目自动初始化 `.redcode/`**：bootstrap 检测项目根既无 `.opencode/` 也无 `.redcode/` 时，自动创建 `.redcode/MEMORY.md` 空模板，新项目开箱即有项目级记忆（`project/bootstrap.ts`）
- **Soul 自动注入**：根据 `REDCODE_CLIENT` 环境变量（desktop=GUI / cli=TUI）自动注入对应人格文件（`~/.redcode/souls/Gsoul.md` 或 `Tsoul.md`）为系统级指令，不再需要每次手动 `/gui-persona` 或 `/tui-persona`；系统级注入不受 compact 丢失（`session/instruction.ts` `systemPaths()`）

#### 变更

- **AGENTS.md 重写**：新增记忆系统双层架构说明、记忆流动规则（全局→项目/项目→全局）、跨项目工作规则（别的项目发现 RedCode bug 提醒用户回 RedCode 工作区修）、版本更新 checklist（含双语 README 同步）、质量门禁（从 souls 迁入，报告门禁/首次编辑不熟文件/Guardrail 档位/compress 用法/协作模式）
- **Soul 模板瘦身**：Gsoul.md（140→68 行）/ Tsoul.md（142→64 行），操作规则全部迁入 AGENTS.md（系统级，compact 不丢），souls 只保留人格/语气/说话方式

#### 修复

- **缓存命中率计算修正**：根因→分母 `input + cache.read + cache.write` 中 `input` 已包含 cache tokens（API 返回值语义），cache.read 在分子分母都出现且分母被膨胀，导致命中率永远 ~99%；改法→分母改为 `cache.read + cache.write`（纯缓存命中率），并保留一位小数（`*1000/10`）。涉及 5 处：GUI metrics（`session-context-metrics.ts`）/ TUI sidebar（`sidebar/context.tsx`）/ TUI prompt（`prompt/index.tsx`）/ TUI subagent-footer（`subagent-footer.tsx`）/ CLI run（`session-data.ts`）

### [0.4.14] - 2026-06-10

#### 清理

- **core/plugin 类型导入显式化**：`plugin.ts` 对 `agent.ts` / `catalog.ts` 的 `import type` 由 namespace 导入改为直接类型导入（`import type { Info as AgentInfo, ID as AgentID }`），显式标注依赖边界，避免后续误改成 value import 引入真循环。

#### 修复

- **effect-drizzle-sqlite 双循环依赖破除**：
  - 循环1 `db.ts ↔ session.ts`：根因 `SQLiteEffectTransaction` 类定义在 `session.ts` 但继承自 `db.ts` 的 `SQLiteEffectDatabase`；将 `SQLiteEffectTransaction` 类迁至 `db.ts`，`session.ts` 改用 `import type` 回指，消除 value-level 循环
  - 循环2 `session.ts ↔ up-migrations/effect-sqlite.ts`：根因 `migrate` 函数定义在 `session.ts` 并 value-import 上游迁移模块；将 `migrate` 提至新建 `sqlite-core/effect/migrate.ts`，`session.ts` 和 `effect-sqlite/migrator.ts` 更新 import 路径
  - 两个循环均为 type-level 边缘 + 单向 value 依赖，现已全破
- **侧边栏缓存 token 分母为 0**：`sidebar/context.tsx` 中 cache 信息展示 `read / write`，write=0 时显示 `X,XXX / 0`；新增 cacheHit 命中率计算，write=0 时只显示读数值+命中率，与 GUI 侧同修
- **多模态图片双重 data URL 编码**：`@ai-sdk/openai-compatible` 对 `data` 字段再包一层 `data:...;base64,` 前缀导致图片 base64 损坏；`message-v2.ts` 新增 `stripDataUrlPrefix()` 在传入 AI SDK 前去除 data URL 前缀只保留 raw base64，用户消息和 tool-result media 两处均修（`session/message-v2.ts`）

### [0.4.13] - 2026-06-10

#### 清理

- **移除提示词中已下线的 CodeGraph 引用**：deepseek / mimo / minimax 三个紧凑提示词的工具优先级段落仍写着 "(3) CodeGraph — knowledge-graph search and call-chain tracing"，但 CodeGraph 已从项目移除（现仅 jCodeMunch + TypeGraph），属死引用；删除该子句，避免模型被引导调用不存在的工具（`session/prompt/{deepseek,mimo,minimax}.txt`）。

### [0.4.12] - 2026-06-10

#### 修复

- **MCP 客户端创建 failure-safe（移植上游 opencode #31595）**：根因→`create` 抛错被调用点 `Effect.catch(() => Effect.void)` 整个吞掉，服务起不来时连"失败"状态都不记录、直接从状态栏凭空消失；改法→`create` 外层包 `Effect.catchCause`，任何意外抛错收敛成 `status:"failed"` + 错因（`Cause.squash`，仅中断除外），调用点去掉吞错的 catch；文件 `mcp/index.ts` `create` / state forEach 调用点。
- **MCP 连接失败打可操作日志（移植上游 #31544）**：根因→服务不可用时只在 `connectLocal` 内部记 error，create 层无统一提示；改法→`!mcpClient` 且状态非 connected/disabled 时打 `server unavailable`（带 key/type/status）便于排障；文件 `mcp/index.ts` `create`。
- **getPrompt / readResource 加超时（移植上游 #31612）**：根因→之前只 tools 调用有超时，prompts/resources 请求无超时可永久挂起；改法→`withClient` 按 配置 timeout → `experimental.mcp_timeout` → `DEFAULT_TIMEOUT`(30s) 顺序取超时并透传给 `client.getPrompt`/`readResource`；文件 `mcp/index.ts` `withClient` / `getPrompt` / `readResource`。

### [0.4.11] - 2026-06-10

#### 新增

- **LSP 深度集成 — rename / codeAction / completion**：三个新 LSP 工具操作
  - `rename`：跨项目重命名符号，`newName` 参数指定新名
  - `codeAction`：获取当前位置可用代码操作（快速修复、重构等）
  - `completion`：获取当前位置的补全建议

### [0.4.10] - 2026-06-10

#### 新增

- **`task` 工具 `isolation:"worktree"` 子代理隔离**：子代理可在独立 git worktree（独立工作目录 + 分支）中运行，文件改动不触碰父工作区，用于高风险或并行改动
  - 新增 `Worktree.createAndWait`（`worktree/index.ts`）：同步建 worktree → populate(`git reset --hard`) → `store.load`，直接返回该实例 `InstanceContext`，**不走 fork/事件总线**，无竞态、错误正常传播
  - `prompt.ts` 新增 `runIsolated`：用 `Effect.serviceOption(Worktree.Service)` 运行时查找 Worktree（app/server 已在同级 `mergeAll` 提供，共享根实例不分裂），`run` 在隔离实例下跑（`Effect.provideService(InstanceRef, ctx)`），工具 cwd 随之隔离。serviceOption 不入 R 通道 → `SessionPrompt.layer` 依赖不变，零波及面
  - `task.ts` 新增 `isolation` 参数 + `isolatedOutput`（回报 worktree 目录/分支）；后台子代理与 worktree 隔离互斥（显式报错）

#### 修复

- **worktree 分支前缀品牌归一**：`makeWorktreeInfo` 生成的分支前缀 `opencode/${name}` → `redcode/${name}`（`worktree/index.ts:196`）

### [0.4.9] - 2026-06-10

#### 新增

- **`/subtask` 命令**：后台派发独立子任务，上下文隔离，主对话不被子任务的中间过程污染（`.opencode/command/subtask.md`）

#### 修复

- **提示词路由补全**：`system.ts` 的 `provider()` 之前 deepseek/mimo 模型全部跌回 95 行 verbose `default.txt`；补 deepseek/mimo 分支走各自紧凑提示词
  - 新增 minimax 分支：`api.id` 含 `minimax`（含 m3 及以后）复用 `PROMPT_MIMO` 紧凑风格（内容非模型专属，复用不造重复文件）
- **剪贴板贴图**：PowerShell `Get-Clipboard` 的 base64 stdout 会嵌入换行/空白导致解码失败；解码前 `replace(/\s/g, "")` 清洗，并加 magic bytes 校验确认确为图片（`tui/util/clipboard.ts`）

#### 变更

- **提示词品牌名归一**：`anthropic.txt` / `default.txt` / `kimi.txt` 正文里的 `opencode` / `OpenCode` 显示文案统一改为 `RedCode`

### [0.4.8] - 2026-06-10

#### 新增

- **记忆系统全面升级**：长尾教训从"每轮整体注入"改为"按需召回"，大幅省 token
  - **FTS5 trigram 召回**：`su-prememory` MCP 的 FTS5 分词器从 unicode61 改 trigram，中文可正常召回；带旧表迁移（检测非 trigram 的 `memories_fts` 表即 drop 重建）；`recall` 走 bm25 相关性排序，query <3 字回退 LIKE 兜底（`plugins/mcp-su-prememory-local/src/index.ts`）
  - **`/recall` 命令**：按关键词从 `MEMORY.md` 召回历史教训，配 `recall-memory.mjs`（node 调用绕开 PowerShell `bun.ps1` 执行策略封禁）
  - **CORE 块每轮注入**：新增 `memory.ts` 插件，每轮把 `~/.redcode/AGENTS.md` 的 CORE 块追加到 system 末尾（最高 recency），无标记即 no-op，公开仓零个人痕迹
  - **MEMORY.md 退出整体注入**：`redcode.home.jsonc` 的 `instructions` 去掉 `~/.redcode/MEMORY.md`，改 `/recall` 按需召回，工作铁律由 CORE 块兜底；USER 画像仍自动加载
  - **会话摘要索引**：新增 `~/.redcode/memory/INDEX.md`，每 session 一条 50–100 token 摘要，SessionStart 优先读索引、需细节再翻全量 `YYMMDD.md`；`memory-automation` skill 已接线（SessionStart 先读 INDEX、Stop 时追加摘要）

#### 修复

- **MCP spawn ENOENT（dev/GUI-sidecar）**：`resolveMcpCwd` 在 `findRedcodeRoot()` 返回空（如 `bun run dev` 下 execPath=bun.exe 向上找不到安装根）时，`$REDCODE_ROOT` 残留字面量 → spawn cwd 指向不存在目录 → ENOENT；改为 `root || fallback`，空根回退到 `InstanceState.directory`（`mcp/index.ts`）
- **typegraph-mcp 进程泄漏（Windows）**：命令从 `npx` 改 `node` 直起本地 tsx — npx 在 Windows 被 `cmd /c` 包装，真正的 node 子进程脱离 `transport.pid` 无法被 `taskkill /T` 回收 → 进程泄漏；同时工具从 14 个精简到 3 个 tsserver 类型工具（其余被 jcodemunch 覆盖）（`plugins/typegraph-mcp/server.ts`、`redcode.jsonc`）

#### 构建

- **`.gitattributes` 钉死行尾**：统一 LF/CRLF 规则 + 一次性归一，避免跨机器行尾漂移

### [0.4.7] - 2026-06-08

#### 改进

- **消息前缀动态化**：用户消息和助手消息的前缀从硬编码改为从配置文件读取
  - 用户名：从 `~/.redcode/USER.md` 的 `称呼：` 字段读取，默认 `User`
  - Agent 名：从 `~/.redcode/souls/Tsoul.md` 的第一行标题读取，默认 `Assistant`
  - Agent 配置新增 `displayName` 字段，支持自定义显示名
- **工具图标升级**：替换朴素 ASCII 图标为更有辨识度的 Unicode 符号
  - Shell: `$` → `⌘`
  - Write/Edit: `←` → ``
  - Read/Question/Skill: `→` → `◉`
  - Glob/Grep: `✱` → ``
  - WebFetch/ApplyPatch: `%` → `⊡`
  - Task: `│` → `⬡`
  - WebSearch: `◈` → `◎`
- **消息分隔线**：长对话中消息之间添加 `· · ·` 分隔，提升可读性

### [0.4.6] - 2026-06-07

#### 新增

#### 文档

- **MANUAL.md 大幅更新**：MCP 章节从 4+2 个服务器升级为 4 类表格化呈现

### [0.4.5] - 2026-06-07

#### 新增

- **Agent Reach — 统一搜索 MCP**：新增 `plugins/agent-reach-mcp/`，内置 6 个搜索工具覆盖 3 大平台
  - `search_github` / `get_github_repo` — 搜仓库、搜 Issue、看详情（通过 `gh` CLI）
  - `search_bilibili` / `get_bilibili_video` — 搜 B站视频、提取字幕（B站 API + yt-dlp）
  - `get_douyin_video` — 解析抖音视频信息（通过 yt-dlp Douyin extractor）
  - `doctor` — 一条命令检查各工具可用性
- **Exa 语义搜索 MCP**：接入 Exa AI 语义搜索引擎（`type: "remote"`，`https://mcp.exa.ai/mcp`），免费 1000 次/月，覆盖 web search + web fetch
- **MCP disabledTools 配置**：`ConfigMCP.Local` 新增 `disabledTools` 字段，可在配置层面屏蔽指定 MCP 服务器的多余工具，无需改 RedCode 源码
  - 应用于 codegraph：隐藏 7 个被 jCodeMunch 替代的冗余工具，仅暴露 `codegraph_explore`
- **Supermmemory 本地记忆插件**：`plugins/mcp-su-prememory-local/` — 纯本地 SQLite+FTS5 语义记忆 MCP，三种工具（`memory` 记/忘、`recall` 搜、`stats` 统计），数据存 `~/.redcode/supermemory.db`
- **Diagnose 技能**：`.opencode/skill/diagnose/SKILL.md` — 结构化 bug 诊断工作流（重现 → 缩小范围 → 定位根因 → 修复 → 验证），适配自 @mattpocock/skills

#### 安装/配置

- **Agent Reach 依赖安装**（各平台首次使用前需执行）：
  - B站/抖音：`uv tool install yt-dlp`（视频信息提取）
  - GitHub：`gh` CLI 预装，`gh auth login` 后可用

### [0.4.4] - 2026-06-07

#### 新增

- **MCP 全局配置化**：`ConfigMCP.Local` 新增 `cwd` 字段（支持 `~/` 和 `$REDCODE_ROOT` 占位符展开）；`mcp/index.ts` 新增 `findRedcodeRoot()` 从 exe 路径自动定位 RedCode 安装根目录；6 个 MCP 服务器定义从项目级配置（`opencode.jsonc` / `redcode.jsonc`）移至全局 `~/.redcode/redcode.jsonc`。现在在任何项目目录启动 RedCode 均可自动加载 MCP 工具，不依赖项目 `.opencode/` 目录
- **Session 全局 scope**：`Session.list()` 支持 `scope: "global"` 列出所有项目的会话（不限于当前项目）；HTTP API (`GET /session?scope=global`) 及 SDK 类型同步更新；会话目录过滤默认关闭（`session_directory_filter_enabled` 默认值 `true` → `false`），新用户开箱即见跨项目会话列表
- **技能指令全局化**：6 个共享技能指令从项目配置（`opencode.jsonc` / `redcode.jsonc`）移至全局 `~/.redcode/redcode.jsonc`，使用 `~/.redcode/skill/...` 路径，跨项目目录自动加载。之前仅在 RedCode 项目内可用的技能（memory-automation、guardrail-profiles、defensive-agent、goal-automation、simplify、vision-autoagent）现在任意项目目录均生效。同时也补上了之前漏掉的 `simplify` 技能注入

#### 改进

- **记忆自动化规则强化**：扩展 SKILL.md 中的硬触发器（批评/夸奖/个人信息/项目决策 → 自动记日志），提升自动提取的可靠性

### [0.4.3] - 2026-06-06

#### 新增

- **条件技能（paths frontmatter）**：SKILL.md 支持 `paths` 字段声明 glob 模式（如 `"src/**/*.py"`）。设定了路径的技能只在当前项目目录匹配时才注入系统上下文，避免无关技能膨胀 prompt。`Skill.available()` 新增 `directory` 参数，`forDirectory()` 内部使用 `Glob.scan` 做路径匹配
- **search_tools 工具**：新增 `/search_tools` 工具，允许 LLM 按名称或描述搜索可用工具。端口自 claude-code 的 SearchExtraToolsTool 模式。所有内建/MCP/插件工具均可搜索
- **buildTool 简化工场**：`Tool.build()` 工厂函数，为零服务依赖的简单工具提供更简洁的创建方式，安全默认值，支持 3 行创建一个工具

#### 重构

- **Shell cancel race 修复**：从 upstream 移植 `run-state.ts` `cancel()` 中缺失的 `busy` 检查，避免 shell 取消时的竞态条件

#### 技术债

- **Effect v4 类型适配**：`Tool.build()` 需要 `as Effect.Effect<DefWithoutID>` 断言以保持泛型参数推断；搜索工具使用 `InstanceState.get(state)` 而非 `ToolRegistry.Service` 避免层内循环依赖

---

### [0.4.2] - 2026-06-06

#### 修复

- **"请选择智能体和模型"误弹 toast 根治（第 6 次复发）**：`bootstrap.ts` 新增 `agent_ready` 信号 + 5s 超时兜底；`local.tsx` 统一就绪 gate 收敛三路异步信号；`submit.ts` 轮询等最多 5s 而非静默丢提交；`use-providers.ts` `ready()` 不要求 `connected.length > 0`

#### 功能

- **Vision AutoAgent 技能**：DeepSeek 不支持多模态时自动调用 vision MCP (`qwen3-vl:8b`) 分析用户发送的图片，前端只回"分析中..."，不报错、不多耗 token。新建 `.opencode/skill/vision-autoagent/SKILL.md`，`redcode.jsonc` 统一注册所有 skill 至 `instructions` 段

#### 重构

- **双仓分离 — 隐私重构**：灵魂文件 (Tsoul.md/Gsoul.md)、工作记忆 (MEMORY.md)、每日日志 (memory/)、个人命令 (Karina.md/son.md) 全部从仓库移出。仓库仅保留通用模板，实际数据存 `~/.redcode/`。修改涉及：
  - `.opencode/agents/` → 空白模板，不再含个人人格
  - `.opencode/MEMORY.md` → 格式模板，清空个人内容
  - `.opencode/command/` → 重命名为 tui-persona/gui-persona，路径指向 `~/.redcode/souls/`
  - `AGENTS.md` / `README.md` / packages `AGENTS.md` → 抹掉所有个人身份名
  - `CHANGELOG.md` / 配置文件 → 清除 `D:\AI\`、`D:\AI\KLX\` 等硬编码路径
  - `script/sync-home.bat` → 停止同步个人文件，只同步 skill/插件
  - `skill/memory-automation` / `*` → `哥哥` → `用户`，路径改为 `~/.redcode/`
  - 全身搜索已确认无个人名/路径/称呼残留

#### 新增

- **启动时自动播种 `~/.redcode/`**：`InstanceBootstrap.run` 中新增 `ensureDir` + 模板复制逻辑。首次启动自动创建 `~/.redcode/{memory,souls}/`，从 `.opencode/agents/` 复制 Tsoul.md/Gsoul.md/USER.template.md/MEMORY.md，已存在的文件不被覆盖。TUI、GUI sidecar、打包 exe 均走同一路径

#### 文档

- **README 精简 + MANUAL.md 用户手册**：README 仅保留核心介绍和快速开始链接；MANUAL.md 从新人视角编写 420 行完整操作指南，覆盖模型配置、MCP 安装、人格系统、记忆系统、权限控制、Skill 扩展、多机同步

### [0.4.1] - 2026-06-05

#### 修复

- **web-search MCP 系统代理探测**：`search-server/index.ts` 的 `fetchHtml` 之前直接调 PowerShell `Invoke-WebRequest` 不传 `-Proxy`，系统代理关了就直连超时；新增 `getSystemProxy()` 读注册表 `Internet Settings` 的 `ProxyEnable`/`ProxyServer`，代理开启时提取地址显式传给 `-Proxy` 参数，启动时探测一次缓存（`.opencode/search-server/index.ts:25-56`）
- **Compaction 静默化**：之前压缩摘要的完整文本会渲染进对话滚动区，干扰阅读；过滤掉 `mode === "compaction"` 的 assistant 消息，三处同步修改（`pending` memo / `lastAssistant` memo / render Match 条件），标题栏 `—— Compaction ——` 保持不变（`routes/session/index.tsx:204,208,1213`）

#### 优化

- **doom_loop 循环检测扩展**：原判定仅覆盖「同一工具连续 3 次」；新增 `CYCLE_WINDOW = 6` 窗口，检测 A→B→A→B（周期 2）和 A→B→C→A→B→C（周期 3）交替模式，解决 MiMo 等模型在 agentic 任务中反复横跳却绕过阈值的问题（`session/processor.ts:427-458`）

### [0.4.0] - 2026-06-04

#### 新增

- **ECC 启发三件套**：借鉴 ECC（Everything Claude Code）的设计理念，新增三个共享 skill：
  - **`memory-automation`** — 自动化记忆环：SessionStart 自动注入最近 3 天日志教训、PreCompact 保存状态到 `.session-last.json`、Stop 时自动提取教训更新长期库（`.opencode/skill/memory-automation/SKILL.md`）
  - **`guardrail-profiles`** — 三档控制：`ECC_PROFILE=minimal|standard|strict` 环境变量切换，不改配置文件；minimal 少确认快干活、strict 每步都问（`.opencode/skill/guardrail-profiles/SKILL.md`）
  - **`defensive-agent`** — Agent 防御性设计：11 种 FP 不报、4/4 confidence gate、首次编辑不熟文件强制调查引用和依赖（`.opencode/skill/defensive-agent/SKILL.md`）
- **ecc-shell-stub v2**：注入 `ECC_PROFILE`/`ECC_MEMORY_RECENT`/`ECC_MEMORY_LONG` 到 `shell.env`，`permission.ask` 按 profile 区分放行策略
- **Tsoul 人格内化防御模式**：新增"防御模式""怎么改不熟的文件""Guardrail 怎么跑"小节
- **HOOKS.md**：定义 RedCode 的生命周期约定（SessionStart/PreCompact/Stop），plugin 自动 + agent 手动分工

- **DCP 插件集成**：安装 `@tarquinen/opencode-dcp`（动态上下文裁剪），自动压缩旧对话、去重工具调用、裁剪错误输入，节省 token
- **`opencode.jsonc` + `redcode.jsonc` 自动加载**：两个配置文件同步添加 `plugin` + `instructions`，启动即生效

- **`web-search` 极简 MCP server**：受 FreeWeb 启发，只保留 `web_search` 一个工具（`.opencode/search-server/index.ts`，165 行），DuckDuckGo HTML 搜索 + Yahoo 兜底，零 API key；依赖仅 `@modelcontextprotocol/sdk` 一个包，启动 ~1s；Windows 系统代理自动透传（走 PowerShell `Invoke-WebRequest`）

### [0.3.17] - 2026-06-04

#### 新增

- **DeepSeek / MiMo 专属系统提示词**：`session/system.ts` 的 `provider()` 新增 `deepseek`/`mimo` 子串匹配，分别返回 `prompt/deepseek.txt`、`prompt/mimo.txt`；主用的 DeepSeek V4 与小米 MiMo-V2.5 不再走 default 提示词
- **人格触发命令**：`.opencode/command/{gui-persona,tui-persona}.md`，对话里一条命令即加载 GUI/TUI 人格，比手打"你是X"更快；命令仅向上下文注入文字、不替换模型提示词（`request.ts` 的 `agent.prompt` 会顶掉 deepseek/mimo 提示词，故不做成 agent）。**修复**：命令此前从未被引擎加载——`config/paths.ts` 只扫 `.redcode` 目录，命令却放在 `.opencode/command/`；`script/sync-home.bat` 之前同步了 skill 却漏了 command。现补同步 `.opencode/command` → `~/.redcode/command`（真镜像：先删后拷），重启后命令真正生效

#### 工作流

- **全局配置目录迁移 `.redcode` → `~/.redcode`**：从旧位置迁到用户 home 目录。引擎 `config/paths.ts` 的 `directories()` 无条件扫描 `home/.redcode`，不管项目在哪个盘都自动发现，彻底解决跨盘/跨机器路径问题；`build.bat` 同步目标改为 `%USERPROFILE%\.redcode`
- **全局记忆/画像机制化注入**：`~/.redcode/redcode.jsonc` 的 `instructions` 由 `session/instruction.ts` 引擎侧读取并在 `:137` 展开 `~/`，每个项目启动自动注入 `MEMORY.md`/`USER.md`，消除旧的"靠 AGENTS.md 喊话读 MEMORY"行为链脆弱点

#### 文档

- **AGENTS.md 重构**：根 AGENTS.md 身份触发段补充人格命令与自动注入说明；`packages/{opencode,desktop}/AGENTS.md` 顶部加 breadcrumb（本包=TUI/GUI、对应人格），进子目录读文件时自动叠加强化身份

### [0.3.16] - 2026-06-03

#### 重构

- **语义颜色分层**：在 47 个扁平颜色属性之上新增 `theme.colors` 语义层，按 text/surface/border/status/diff/markdown/syntax 8 组分群。旧属性完全兼容，新代码可用 `colors.text.body`、`colors.surface.panel`、`colors.status.error` 等语义路径访问
- **Theme 类型导出**：`Theme` 类型从 `theme.tsx` 导出，`SharedSyntaxTheme` 收敛为类型断言，减少重复类型定义

#### 修复

- **llm 模块循环依赖**：`schema/options.ts` → `route/client.ts` → `schema/index.ts` → `schema/options.ts` 的 17 文件循环依赖降至 3 文件（transport barrel 循环，可接受）。移除 `schema/options.ts` 对 `route/client.ts` 的反向导入，改用本地类型定义
- **theme-store 测试**：`DEFAULT_THEMES.redcode` 修正为 `DEFAULT_THEMES.opencode`，恢复 4 个损坏的单元测试
- **system 主题 isDark 时序**：`generateSystem` 中 `isDark` 声明移至 `fallbackBg`/`fallbackFg` 之前，修复 Temporal Dead Zone 导致的 ReferenceError
- **palette 回退兜底**：`generateSystem` 中 `palette[0]`/`palette[7]` 可能为 undefined，补充 `#1a1b26`/`#ffffff` 硬编码回退色值
- **Proxy 类型安全**：`theme.tsx` 中 Proxy getter 移除 `@ts-expect-error`，改用 `keyof Theme` 类型断言
- **resolveTheme 过滤补全**：`backgroundMessage` 加入初始过滤列表，避免重复解析

### [0.3.15] - 2026-06-03

#### 新增

- **MCP 懒加载**：启动时不连接 MCP server，第一次调用该 MCP 的 tool 时才按需连接，减少冷启动等待
- **MCP pending 状态**：侧边栏 MCP 面板显示"Waiting…"等待状态，启动时一目了然

#### 工作流

- **删除文件单独授权**：`apply_patch` 中 `type: "delete"` 的操作需额外弹窗确认，不再是编辑权限附带的
- **灵魂文件进仓库**：`Gsoul.md` / `Tsoul.md` 从上级目录移入 `.opencode/agents/`，git 跟踪推送，换机自动同步
- **全局 workspace（`.redcode/`）**：在项目上级创建全局共享目录，包含 AGENTS.md、MEMORY.md、USER.md、souls 等，所有项目共享身份与记忆，不再每项目重复搭建
- **`build.bat` 版本自检**：编译前自动跑 `check-version-consistency.ts`，版本不一致时阻止编译并提示
- **权限范围扩展**：`containsPath` 增加上级目录检查，信任与项目同级的兄弟项目

---

### [0.3.14] - 2026-06-03

#### 新增

- **MCP 配置热重载**：文件 watch `redcode.jsonc`，检测到 MCP 配置变更后自动添加/删除/重连服务器，无需重启 TUI
- **MCP 工具调用进度推送**：耗时较长的 MCP 工具调用（如 browser 截图）实时显示进度状态，避免无响应感

---

### [0.3.13] - 2026-06-03

#### 新增

- **消息视觉区分**：用户消息添加 `> ` 前缀（agent 色加粗），AI 消息添加 ✦ 前缀（accent 色）
- **语义色 `backgroundMessage`**：用户消息背景色独立于面板色，后续主题可单独定制

#### 修复

- **Browser MCP 端口冲突**：server 启动时自动检测 9001 端口，被僵尸进程占用时自动 kill 旧进程并重试

---

### [0.3.12] - 2026-06-03

#### 新增

- **MCP 健康监控**：每 30s 检查所有 connected 的 MCP server，连续 3 次失败标记断开并自动尝试重连
- **MCP 工具调用失败自动重连**：tool call 报错时自动尝试 reconnect 并重试（最多 3 次）
- **MCP Transport 日志**：记录实际使用的 transport 类型（stdio/SSE/HTTP），便于排查

---

### [0.3.11] - 2026-06-03

#### 修复

- **MCP 进程树泄漏（Windows）**：`descendants` 在 Win32 直接返回空数组，导致每次 TUI 退出时子进程（codegraph/typegraph/npx 链）变成僵尸堆积。改为 `taskkill /F /T /PID` 一次杀整棵树，Unix 保持原逻辑
- **Browser MCP 断连**：server `socket.on("close")` 无条件置 `ws = null`，导致新连接被旧 socket 的 close 事件覆盖破坏。改为 `if (ws === socket)` 条件判断
- **exe MCP 路径解析**：编译后的 exe 运行时 `cwd` 是 bin/ 目录，相对路径（`./browsermcp-server/index.js`）解析失败。新增 `findProjectRoot`，从 exe 所在目录向上查找 `redcode.jsonc` 或 `.git`，确保 MCP 命令路径正确解析
- **滚动条默认值迁移**：kv 存储中旧的 `scrollbar_visible: false` 会覆盖新默认值。新增一次性版本迁移（`kv_version`），首次启动时自动升级为 `true`

#### 变更

- **滚动条默认开启**：消息区域右侧滚动条默认显示，支持鼠标点击轨道跳转和拖拽滑块滚动。可通过 `session.toggle.scrollbar` 命令或 `/mcps` 切换
- **Browser MCP 扩展 v1.0.3**：改用 `chrome.alarms` 保活（每 24s 触发），替代不可靠的 `setTimeout`，解决 Manifest V3 service worker 休眠后断连

#### 配置

- `redcode.jsonc` 新增 browsermcp 配置
- `.opencode/opencode.jsonc` 新增 browsermcp 配置

#### 新增

- **Browser MCP 集成**：新增浏览器自动化 MCP 服务器，支持导航、截图、点击、输入、获取页面内容等操作，可让 AI 直接操控主人的浏览器
- **jCodeMunch MCP 集成**：新增结构化代码检索服务器（60+ 工具），支持精确符号获取、死代码检测、影响评估、编辑安全预检、AST 模式匹配等，比 grep 省 95% token
- **TypeGraph MCP 集成**：TypeScript 语义导航服务器（14 个工具），支持类型解析、调用链追踪、barrel 文件穿透、循环依赖检测

#### Browser MCP 使用方式

1. 安装 Chrome 扩展：
   - 打开 `chrome://extensions/`
   - 开启"开发者模式"
   - 点"加载已解压的扩展程序" → 选择项目内的 `browsermcp-extension` 目录（相对路径，跨电脑/盘符通用）
2. 点击扩展图标 → Connect（图标显示绿色 "ON" 表示连接成功）
3. 重启 TUI 生效

可用工具：`browser_navigate`、`browser_go_back`、`browser_go_forward`、`browser_snapshot`、`browser_click`、`browser_type`、`browser_hover`、`browser_select_option`、`browser_press_key`、`browser_wait`、`browser_screenshot`、`browser_get_console_logs`

---

### [0.3.9] - 2026-06-02

#### 新增

- **Prompt 栏点击切换**：Agent 名称、模型名称、推理强度标签支持鼠标点击，直接弹出对应选择列表（DialogAgent/DialogModel/DialogVariant）
- **用户可配置快捷键**：`tui.json` / `tui.jsonc` 已完整支持 `keybinds` 字段覆盖默认快捷键，支持全局（`~/.config/redcode/tui.json`）、项目级、`.redcode/` 目录级配置，逐级合并覆盖

---

### [0.3.8] - 2026-06-02

#### 新增

- 动态终端标题：session 忙碌时标签栏显示 `▶` 前缀，空闲恢复；多 tab 终端一目了然
- 统一清理注册表：`CleanupRegistry` 集中管理所有退出清理（keymap、console 劫持、plugin runtime、audio），避免散落 `finally` 导致泄漏

#### 修复

- **构建流程修复**：Windows 上 `rm -rf` 因文件锁定失败不再中断编译，用 `try/catch` 安全跳过
- **版本号硬编码**：预览版不再生成 `0.0.0-dev-<timestamp>`，改用 `package.json` 中的真实版本号
- **Console 污染 TUI 渲染**：`console.log/warn/error` 在 TUI 启动后被劫持转入环形缓冲区（500 条），退出时还原，避免第三方库日志乱入终端

---

### [0.3.7] - 2026-06-01

#### 新增

- 记忆系统：新增每日日志 + 定期审视机制，被纠正时自动写入 `memory/YYMMDD.md`，收工时摘要合并到 MEMORY.md，确保教训跨会话持久

#### 修复

- **构建流程纠正**：TUI exe 编译改用 `bun run build -- --single`（`script/build.ts`），替代之前手拼 `bun build --compile` 的错误方式

---

### [0.3.6] - 2026-06-01

#### 新增

- 侧边栏 Context 区块充实：显示 provider 名、模型名、token 明细（输入/输出/推理/缓存）、消息数、agent 名、创建时间和最后活动时间；未知上下文上限显示 `?`，超过 200% 显示 `⚠` 警告
- Loading 动画替换：左下角蓝色方块 Knight Rider 动画改为 🐲🔥 喷火龙呼吸动画
- 右键粘贴：主输入框和对话框输入框支持右键粘贴剪贴板内容

### [0.3.5] - 2026-05-31

#### 新增

- prompt 输入框自适应 & 可配置高度：合并上游实现，文本框行数根据内容自动伸缩，支持用户配置最小/最大行数

#### 修复

- 行内 tool 行换行对齐：提取 `InlineToolRow` 组件，图标与文字使用 flex 布局，换行后文字正确对齐

### [0.3.4] - 2026-05-31

#### 新增

- Shell Mode：空提示框按 `!` 进入 Shell 模式，直接运行系统命令（通过 `session.shell` 而非发送消息），命令完成后自动退出 Shell 模式
- Session Switcher：新增 `$session.list` 命令和 `/sessions` 斜杠命令，打开会话切换对话框，支持按项目/状态过滤、消息预览和 diff 摘要

#### 修复

- Diff Viewer 改进：合并上游空白状态展示、交互优化、设计重设计等修复；修复文件树中已审查文件的勾选标记 Unicode 乱码
- 测试文件 import 路径修正：`diff-viewer.test.tsx` 中 `@opencode-ai` → `@redcode-ai`

### [0.3.3] - 2026-05-31

#### 修复

- compacted 会话 HTTP API 消息过滤：消息分页查询自动跳过 compaction summary 之前的旧消息，避免 GUI 加载大量旧消息导致 OOM/卡死。同时在 `packages/opencode` 侧生效，TUI 和 GUI 共享同一服务端
- 测试用例 import 补全：`db.test.ts` 补全 `it` 的 `bun:test` import，修复测试运行时引用错误

### [0.3.2] - 2026-05-30

#### 变更

- 统一数据库路径：移除 channel 分库逻辑（`redcode-dev.db` / `redcode-beta.db` 等），所有渠道统一使用 `redcode.db` 主库；删除 `disableChannelDb` 运行时标志
- 斜杠命令中文化：`/compact`→压缩会话、`/connect`→连接供应商、`/copy`→复制会话记录、`/export`→导出会话记录、`/fork`→分叉会话、`/init`→初始化 AGENTS.md、`/review`→审查变更

### [0.3.1] - 2026-05-28

#### 新增

- 对话框 Ctrl+V 粘贴：`dialog-prompt.tsx` 添加系统剪贴板读取，作为 bracketed paste fallback；`keybind.ts` 新增 `dialog.prompt.paste` 快捷键绑定

#### 修复

- DeepSeek 模型变体不可用：`transform.ts` 移除 DeepSeek 模型 variants 排除列表，`openai-compatible` 类型模型绕过 `reasoning` 能力检查

#### 重构

- 删除死代码：移除未使用的 `GoLogo` 组件（`logo.tsx`）、整个 `dialog-tag.tsx` 文件、未引用的 `Descriptions` 和 `TuiAttentionSoundPaths` 导出
- 类型安全提升：`toast.tsx` `err: any` → `unknown`、`kv.tsx` `defaultValue?: any` → `unknown`、`dialog.tsx` `replace(input: any)` → `JSX.Element`、`dialog-prompt.tsx` `ctx: any` → `CommandContext`、`local.tsx` 反序列化类型标注

---

## GUI

### [0.7.13] - 2026-08-02

> 渲染热路径从 marked 换 markdown-it——marked 的 lexer/parse 在长文本上是 O(n²) 退化（50KB 纯文本 462ms），markdown-it 线性扩展到 1.2ms（489x），流式长输出每 tick 数百 ms 的卡顿根因被拔掉。

#### 性能

- **markdown 解析器 marked → markdown-it 14**（`packages/ui/`）：marked 在 10KB→50KB 纯文本上 lexer+parse 从 25ms 劣化到 462ms（5x 文本 → 18x 时间，O(n²)），叠加流式渲染每 tick 全量 parse+sanitize（`markdown-stream.ts` 每 tick `marked.lexer(全文)`），长输出下正是 3000 万 token 级会话卡顿的根因。换 markdown-it 14.3.0：50KB 混合文本 parse 5.1ms（96x）、流式 30 tick 10ms vs 2439ms（244x），线性扩展无 O(n²)。改动：`context/marked.tsx` 重写 init（`html:true` + `linkify:true` + taskLists 插件补偿 checkbox + link_open renderer 定制 external-link，四种数学语法 `$`/`$$`/`\\(`/`\\[` 全兼容）；`markdown-stream.ts` 换 `md.parse()` tokenize（未闭合 fence 判断改为 token 序列以 `fence` 结尾 + `fence.map[0]` 行号精确切片，行为与旧版一致，4 测试全过）；`useMarked().parse` 接口不变，`markdown.tsx` 零改动。全量回归：ui typecheck + 21 测试 pass、app/desktop typecheck pass；性能复测流式 60 tick 最终 50KB = 126ms（2.1ms/tick）vs 旧 marked 理论 35s（279x），分块拼接与全量渲染输出一致。

---

### [0.7.12] - 2026-08-01

> 流式渲染与缓存清理两条热路径继续瘦身——版本指纹不再每次全量拼接，缓存清理不再每次全量扫描。

#### 修复

- **流式版本指纹改增量缓存，消灭每 16ms 全量字符串拼接**（`packages/app/src/pages/session/message-timeline.tsx`）：`activeAssistantContentVersion` 原是每次 delta 都把 active 消息的全部 parts（含工具输出）拼成一个大指纹字符串（O(轮次文本)），长输出下随 flush 频率累积 O(n²) 分配。改为增量版本号——per-part 签名 `Map` 比对，只有签名变化的 part 才重算并递增版本号，未变 part 仅 `Map.get` 比较；消费方（auto-scroll 的 `on` 依赖）只比较值变化、不读内容，语义不变。缓存超 1000 条才做一次清理（删除不在当前活跃集合的签名），正常路径零额外分配。
- **缓存清理懒化：无裁剪无孤儿时 O(1) 短路**（`packages/app/src/context/global-sync/event-reducer.ts`）：`cleanupDroppedSessionCaches` 原先每次 `session.created`/`session.updated` 都全量扫描 6 类 store 键 + 全部 parts（40-session 缓存 × 千条消息 = 数万条目/事件），为的是兜底清理被 trim 出列表的会话残留缓存。现在调用点先用 trim 前后长度差判断是否真发生裁剪，另加 `pendingOrphanSessions` 打点——`message.updated` 插入时若 session 已不在列表（被 trim 会话的消息事件仍在推送）就标记；两条件都不成立则直接跳过全扫，成立才走原逻辑并清空打点。孤儿兜底语义不变（测试覆盖 part-only orphan 场景）。

---

### [0.7.11] - 2026-08-01

> 长会话卡顿两个结构性根因修复（每 delta 双写字符串累加、无消息上限）+ 任务栏闪烁提醒。

#### 修复

- **每 delta 单次写入，消灭 O(n²) 字符串累加**（`packages/app/src/context/global-sync/event-reducer.ts`）：`message.part.delta` 同时写 `part_text_accum_delta` 和 `part[].text` 两份拷贝，每次 delta 都 O(当前全文) 复制，长流式输出（三千万 token 级会话）下总成本 O(n²)。TUI 对照（`packages/opencode/src/cli/cmd/tui/context/sync.tsx:327-343`）只写一份；`readPartText`（`packages/ui/src/components/message-part-text.ts`）在 accum 缺失时本就 fallback `part.text`，删掉 accum 写入行为不变。
- **每会话消息上限 100 条**（同上文件 `message.updated` case）：GUI store 无界保留全部消息+parts，超长会话使内存与全量扫描（`messageAgentColor`、`cleanupDroppedSessionCaches`）无界增长。仿 TUI 的 100 条 shift（`sync.tsx:271-289`）丢最旧消息及其 parts；历史消息靠 `directory-sync` 的 cursor 分页（`loadMore`）随时回拉，截断只影响内存缓存，不影响滚动查看。

#### 新增

- **任务栏闪烁提醒**（`packages/desktop/` 五处链路）：仿 TUI `attention.bell` 的微信式提醒——`platform.notify` 失焦触发时 `window.api.flashFrame(true)`（`renderer/index.tsx`），经 preload `flash-frame` 通道（`preload/index.ts`、`preload/types.ts`）到 main 进程 `BrowserWindow.fromWebContents` + `isFocused()` 守卫（`main/ipc.ts`），窗口聚焦自动停闪（`main/windows.ts`）；Tauri shim noop 占位（`renderer/tauri-api-shim.ts`）。桌面端所有通知（turn-complete/error/permission/question）汇聚于 `platform.notify` 一处生效。

---
### [0.7.10] - 2026-07-31

> 输入框补上主 agent 切换控件 —— 此前 GUI 只能停在 build，plan / redmind 在界面上选不到。

#### 新增

- **输入框主 agent 切换控件**（`packages/app/src/components/prompt-input.tsx`）：工具栏此前只渲染 `modelControl()` 和 `variantControl()` 两个控件，没有任何切换主 agent 的入口，于是永远停在 `local.agent.list()[0]`（`build`）。底层其实早就是通的——`local.agent` 的 `list`/`current`/`set` 在 `@` 提及子代理时就在用，`agent.cycle` / `agent.cycle.reverse` 命令也早就注册了（`use-session-commands.tsx`，有快捷键、命令面板里能调），i18n 的 `command.agent.cycle` 各语言齐全，缺的只是这个可见控件。照 `variantControl` 的结构补一个 `agentControl`，放在模型控件左边，`list().length > 1` 才显示，tooltip 复用已有的命令与快捷键。顺带说明：用户反馈的"`/agent` 没效果"是同一件事的另一面——`agent.cycle` 是命令面板的命令 id，不是输入框里的斜杠命令，在输入框打 `/agent` 本来就不会触发。

---

> GUI 的 agent 切换下拉把 redmind 显示成 "Redmind"——TUI 侧 0.8.x 已用 displayName 修正，web 渲染层漏了，这次统一走 `displayName ?? name`。

#### 修复

- **agent 下拉与 @ 提及显示名修正**（`packages/app/src/components/prompt-input.tsx`）：GUI 输入框的 agent 切换控件下拉 `options`/`current` 直接渲染 `agent.name`（id 全小写 "redmind"），叠上 `capitalize` CSS 首字母大写后显示成 "Redmind"，与 TUI 已修正的 `displayName: "RedMind"` 不一致。修法：Select 改为传 agent 对象数组（SDK `Agent` 类型本就带 `displayName?`），`value={(a) => a.name}` 用 id 做键、`label={(a) => a.displayName ?? a.name}` 做显示名，`onSelect` 收到对象后取 `item.name` 回写；@ 自动补全的 `display` 同样改 `displayName ?? name`（`name` 字段仍用于匹配与插入，保持 id 小写）。build/plan 等无 displayName 的 agent 显示不变（capitalize 继续负责首字母大写）。

### [0.7.9] - 2026-07-23

> Electron → Tauri 迁移正式开工——可行性/体积/首屏握手时序此前已在原型里验证完毕，今天新增第一批真实（非原型、非 stub）代码。

#### 新增

- **Tauri 迁移骨架 + sidecar 首屏握手**（`packages/desktop/src-tauri/`）：新增真实 Tauri 项目骨架（`Cargo.toml`/`tauri.conf.json`/`capabilities`），实现 `await_initialization`/`get_default_server_url` 两个 command——前者真实拉起编译好的 sidecar exe、解析 stdout 拿到监听地址后才 resolve（不是猜时序的桩），后者老实返回 `null`。用真实 0.7.34 sidecar exe 端到端验证过：真实 URL、真实随机密码鉴权（curl 验证无认证 401/正确密码 200/错误密码 401）。目前是独立于现有 Electron 应用的并行基础设施，尚未接入实际打包/开发流程，不影响当前已发布 Electron 版的行为。
- **sidecar 环境注入**：随机 `REDCODE_SERVER_PASSWORD`/`REDCODE_SERVER_USERNAME`、loopback `NO_PROXY`/`no_proxy` 合并，spawn 时通过 `.env()` 注入子进程。

#### 诊断

- **系统证书/env 代理这块没法从 Tauri 侧移植**：Electron sidecar 的 `useSystemCertificates()`/`useEnvProxy()` 是进程内 Node API 调用（`tls.setDefaultCACertificates`/`http.setGlobalProxyFromEnv`），只有"进程内 fork JS 文件"这种执行模式能调；Tauri sidecar 是独立编译的 exe，Rust 侧没有等价的进程内钩子，编译版 CLI 自身的 `serve` 启动流程也从没调用过等价逻辑——这是裸跑 CLI 本来就有的缺口，不是 Tauri 迁移引入的新问题，真要修得改 CLI 自己的启动引导，留待以后。
- **打包后 `$REDCODE_ROOT` 本地 MCP 解析，Electron 现在也有同样的坑**：迁移设计文档原以为"Electron dist 产物已经在 sidecar 旁边放了 package.json"就够，实测 `electron-builder.config.ts` 的 `files`/`extraResources` 根本没把 `plugins/`、`.opencode/search-server/` 等本地 MCP 实际依赖的文件打进安装包——这几个 `$REDCODE_ROOT` 相关本地 MCP 在真实装好的 Electron 版里现在也连不上，只是一直没人在真装好的环境里跑 `redcode mcp list` 验证过，没暴露。开发模式下（`src-tauri/` 本身嵌在 monorepo 目录树里，向上 5 层必然能找到仓库根）没有这个问题，已用 `redcode mcp list` 实测全部 `$REDCODE_ROOT` 相关 MCP 显示 connected 确认。

### [0.7.8] - 2026-07-19

- **版本发布**：GUI 版本升级至 `0.7.8`，同步更新版本徽章与发布记录。

#### 修复

- **点击 Status tab 不丢失 Context tab**（`packages/app/src/pages/session/helpers.ts`）：`activeTab()` memo 没有兜底处理非文件标签（`status`、`plan` 等）。当 `tabs().active() === "status"` 时，path 检查失败直接回退到 `openedTabs()[0]`，导致 tab 被切到文件标签、context 面板隐藏。修法：在 path 检查之后加 `if (active && active !== "review") return active`，对所有非文件标签直接返回原值。同时删掉了此前逐条硬编码的 `"status"`/`"plan"` 分支，统一为泛化兜底。

### [0.7.7] - 2026-07-17

> 打包体积瘦身——语言包只留中英文、effect/drizzle-orm 不再原始打包，安装目录 500M → 405M；顺带查清楚主 exe 232M 是原装 Electron 本身的体积，不是能优化的地方。

#### 优化

- **语言包裁剪**（`electron-builder.config.ts`）：Electron 默认把 Chromium 支持的全部 55 种 UI 语言 `.pak` 打进包，RedCode 是中文母语产品用不上这么多。加 `electronLanguages: ["zh-CN", "en-US"]`，实测 48M → 1.2M。
- **effect/drizzle-orm 不再原始打包**（`electron.vite.config.ts`、`package.json`）：这两个纯 JS 包（无原生绑定）之前被 electron-vite 默认外部化，没走 Rollup tree-shake，整个 node_modules 源码原样塞进 `app.asar`。排除掉外部化名单让它们正常打包压缩，并从 `dependencies` 挪到 `devDependencies`（打包后已不需要以 node_modules 形式随包分发）。实测 `app.asar` 139M → 90M。完整走了一遍 `electron-builder --win` 打包 + 实际启动验证：sidecar（用 drizzle-orm）、主进程（用 effect）均正常初始化，`server ready` 收尾无异常。
- 以上两项合计：`dist/win` 500M → **405M**（-19%）。

#### 诊断

- **主 exe 232M 排查——不是 RedCode 的问题**：把 electron-builder 缓存里的原版 Electron 42.4.1 zip 解出来直接对比，官方原装 `electron.exe` 就是 232,313,344 字节，RedCode 打包后的 `RedCode Dev.exe` 是 232,421,376 字节——只差 108KB（图标/版本信息资源），RedCode 自己的代码资源一点没往这个文件里加。这个体积是 Electron 42.x 把 Chromium/V8 引擎主体直接编进主 exe（而非拆成独立 dll）决定的，不是配置能调的，唯一杠杆是换更小的 Electron 大版本——不建议为这十几 MB 去动它。

### [0.7.6] - 2026-07-17

> 补记两笔已经上线但一直没进版本号的改动：智谱/阶跃 CNY 计价显示、聊天渲染的 dompurify 安全修复。

#### 修复

- **CNY 计价遗漏智谱/阶跃**（`session-context-metrics.ts`）：`CNY_PROVIDERS` 只登记了 `deepseek`/`xiaomi`/`opencode-go`，通过 `stepfun`/`zhipuai` 接入的模型费用按 USD 价目误折算，费用显示偏差。加入这两个 provider（同步的 TUI 侧 `home/footer.tsx` 改动已经在更早的 TUI 版本里，这次只补 GUI 这一半）。

#### 安全

- **`dompurify` XSS 系列漏洞修复**（`packages/ui`，TUI 0.7.26 已记录）：`packages/ui` 是 app/desktop 共用的组件库，`markdown.tsx` 里 LLM 回复/reasoning 内容经 `DOMPurify.sanitize()` 渲染进聊天界面——GUI 侧同样吃这个补丁，`3.3.1 → 3.4.12`，之前只记在了 TUI 变更里，这次补上 GUI 记录。

### [0.7.5] - 2026-07-15

> Session Context 面板配色优化 + 部分数据提示——统计项颜色区分度不足、会话历史懒加载导致数字可能不完整两处体验问题。

#### 优化

- **Context 统计面板配色**（`session-context-tab.tsx`）：16 项统计里此前大量复用同一 `--syntax-*` token（4 项同色、3 项同色，另 4 项无色），视觉上难以区分。改为按固定顺序分配 8 种 token，同色的两处在网格里横向、纵向（含窄边栏塌成单列时）都不相邻，标题类字段（会话名/创建时间）保留中性色。

#### 修复

- **Context 统计可能只反映部分已加载消息**（`session-context-tab.tsx`、`i18n/{en,zh,zht}.ts`）：会话消息懒加载（`directory-sync.ts` 初始只拉 40 条，滚动加载更多每次 +80 条），但"总 token / Cache Hit"等统计是对 `sync.data.message` 当前已加载的部分求和，刚打开长会话时数字会明显偏低且命中率失真，且面板上没有任何提示。检测到 `sync.session.history.more(id)` 为真时，在统计区顶部显示"仅统计已加载 N 条消息，向上滚动加载完整历史后更准确"提示，不强制自动补全加载（避免长会话卡顿）。

### [0.7.4] - 2026-07-12

> 已连接自定义 provider 支持编辑——ovh/ollama 等 config/custom 源提供商可自行修改模型/endpoint，无需找 agent。

#### 新增

- **已连接自定义 provider 编辑**（`dialog-custom-provider.tsx`、`dialog-custom-provider-form.ts`、`settings-providers.tsx`）：`settings-providers.tsx` 对 `source=config/custom` 的已连接提供商显示"编辑"按钮，点击打开 `DialogCustomProvider` 并以 `editProviderID` prop 进入编辑模式。表单预填现有配置（models/headers/baseURL/name/apiKey），providerID 字段禁用防改。保存时合并现有模型配置保留 limits/flags/capabilities 等额外字段，不覆盖未涉及的属性，实现无损编辑。

#### 变更

- **本地模型 qwen3.5 context 修正**（`redcode.home.jsonc`）：qwen3.5:9b-q8_0 的 context 限制从 262144 下调为 163840，匹配模型实际支持的最大上下文窗口。

### [0.7.3] - 2026-07-10

> Todo 层级子任务 GUI 侧适配——composer 待办面板按层级缩进渲染。

#### 新增

- **Todo 层级子任务缩进渲染**（`session-todo-dock.tsx`）：随引擎侧新增的 `id`/`parent_id` 层级字段，composer 待办面板按 `parent_id` 链条计算缩进层级显示子任务，防环/防越界兜底深度上限 5 层。

### [0.7.2] - 2026-07-10

> 首页随机 Tips + 快捷键栏增强 + 标签去重 bug 修复。

#### 新增

- **首页随机 Tips**（`home.tsx`）：快捷键栏上方每次加载随机展示一条提示（操作技巧/编程智慧/名人名言，50 条），类似 RedClaw 启动提示。

#### 优化

- **快捷键栏增强**（`home.tsx`）：补充至 10 个常用快捷键（+切换项目/打开项目/切换主题/归档会话），去掉边框改为纯文本，字体放大 ~150%。

#### 修复

- **标签重复 bug**（`titlebar.tsx`）：`addTab` 去重从 `href` 改为 `sessionId`，同一会话从不同目录编码进入不再产生重复标签。

### [0.7.1] - 2026-07-10

> 首页体验微调 — 看板卡片显示日期 + 空闲列两列网格 + 快捷键栏壁纸可见度。

#### 优化

- **看板卡片显示日期**（`home-kanban.tsx`）：每张卡片右下角标注会话日期（今天/昨天/MM-DD），不用猜会话是哪天的。
- **空闲列两列网格**（`home-kanban.tsx`）：会话超过 6 个时自动切为两列网格布局，充分利用右侧空间。移除 `max-w-[320px]` 列宽限制。
- **快捷键提示条颜色加深**（`home.tsx`）：`text-faint` → `text-muted`、`border-base` → `border-strong`，壁纸场景下清晰可读。

### [0.7.0] - 2026-07-10

> GUI 0.7 里程碑 — 引擎侧文本重复检测 + MiMo 100K output + 首页体验增强。

#### 新增

- **文本重复检测与恢复**（引擎层，GUI/TUI 共享）：双层防护防模型跑飞——N-gram 单步检测（流式 delta 滑动窗口，同一 80 字符模式出现 3 次中断）+ LoopRecoveryTracker 跨步检测（Dice bigram 相似度 ≥0.85 渐进干预：nudge→replan→stop）。GUI 弹 toast 通知用户。
- **MiMo 输出上限 100K**（引擎层）：`transform.ts` 检测 model ID 含 `mimo` 时自动使用 `MIMO_OUTPUT_TOKEN_MAX = 100,000`（标准 32K），释放 MiMo-V2.5 等模型的长输出能力。
- **首页会话数 64 条**：`HOME_SESSION_LIMIT` 从 15 提升到 64，一屏看到更多历史会话。
- **打开文件管理器**：项目右键菜单新增「在文件管理器中打开」，快速跳转项目目录。
- **首页会话归档**：会话列表和看板右键菜单新增「归档会话」，直接从首页管理会话生命周期。

#### 移除

- **Horizon MCP** 从默认配置中移除。

### [0.6.29] - 2026-07-09

> 首页布局优化 + 快捷键提示条。

#### 改进

- **首页左栏底部吸底**：缓存命中率环 + 设置按钮固定在左栏最下方（`mt-auto`），项目列表占据剩余空间自适应高度，不再被中部"堵塞"
- **首页底部快捷键提示条**：展示 6 个常用快捷键（搜索/新会话/切换会话/文件树/设置/命令面板），帮用户发现功能
- **首页 grid 布局优化**：`grid-rows-[1fr_auto]` 让快捷键条贴底显示，减少底部空白

#### 杂项

- 删除未使用的 `RedCode.bat` 启动脚本

### [0.6.28] - 2026-07-07

> 输入框历史前缀 ghost 补全（fish/zsh-autosuggestions 风格）。

#### 新增

- **输入框 ghost 联想补全**（`prompt-input.tsx`、`prompt-input/editor-dom.ts`、新增 `prompt-input/suggestion.ts`）：正常模式下从最近历史里找第一条「纯文本、以当前输入为前缀、且更长」的记录，把超出部分作为灰字 ghost 内联显示在光标之后；`→`/`End`/`Tab` 接受，继续输入即刷新/清除。ghost 是不可编辑节点，光标长度记 0、不进 DOM 解析、不进提交，不影响 @ 文件/子代理 pill、换行、历史导航与 IME。

### [0.6.27] - 2026-07-07

> 同步引擎 tsserver 内存上限修复（实测为小宋内存主要来源），desktop 重新打包生效。

#### 修复

- **tsserver 无内存上限致小宋跑任务吃 2.5G+ 内存**（引擎 `lsp/server.ts`，随 desktop 重打包生效）：内存实测真凶是 LSP 启动的 tsserver（非 Electron 框架、非 sidecar 本体、非消息缓存）。引擎侧已加 `maxTsServerMemory: 2048` 上限（详见 TUI 0.7.16），超限自动重启 tsserver；GUI 随本次 desktop 重打包带上该修复。

### [0.6.26] - 2026-07-07

> 同步 TUI 0.7.14 的缓存命中率公式修复到 GUI 侧（侧栏面板 + 首页看板环形图）+ 应用图标底色处理。

#### 修复

- **缓存命中率"三选一"公式漏记未命中量**（`session-context-metrics.ts`、`home-stats.tsx`）：与 TUI 侧同一根因（DeepSeek 真实 miss token 有时被记进 `cache.write` 而非 `cache.miss`），旧公式 `miss || write || input` 只取一个来源，命中率虚高。改为 `read + miss + write` 直接求和。

#### 变更

- **应用图标源图 `恶龙露比.ico` 去白底**：原图 alpha 通道全不透明，但 RGB 里带有编辑器"透明预览棋盘格"被烤死成实际像素的痕迹（浅灰/白交替）。按颜色阈值区分背景（灰白无色偏）与肚皮（暖白/奶油色，B 通道明显偏低）后抠图，背景变真透明，肚皮/牙齿/眼睛高光等浅色细节保留不受影响。

### [0.6.25] - 2026-07-07

> 根治"打开即多目录内存/进程风暴"的三个真正源头（0.6.23 只堵住了首页 loadSessions 那一路）+ 更换应用图标为恶龙露比。

#### 修复

- **[核心] `bootstrap` 触发判断恒假 → 任何一次 `{bootstrap:false}` 首触都永久锁死目录**（`child-store.ts`）：旧逻辑用 `childStore.status === "loading"` 决定是否二次 bootstrap，但 `status` 永远硬编码 `"complete"`，判断恒假——导致 `enrich()`/recentProjects 等对全部历史项目的 `{bootstrap:false}` 遍历一旦首次创建 store，就抢占了触发权，之后用户真正进入项目（`{bootstrap:true}`）反而不再触发。改用显式 `bootstrapped: Set` 记录，bootstrap 触发与 store 创建彻底解耦：只在"从未真正 bootstrap 过"且调用方要 bootstrap 时触发且仅一次。
- **`enrich()` 用 `child()` 把每个历史项目永久 pin 住**（`layout.tsx`）：`child()` 无条件 `pinForOwner`，而 `enrich()` 跑在 layout 根 owner 里永不 cleanup，等于把每个历史项目永久 pin——0.6.23"重连只刷新 pinned 目录"的过滤形同虚设，还是会把全部历史项目重新 bootstrap。改为 `peek()`（只读、不 pin）。
- **titlebar 对每个恢复的 tab `createDirSyncContext` → 整套 bootstrap + 永久 pin**（`titlebar.tsx`）：`createDirSyncContext` 内部走 `child()`（`bootstrap:true` + pinForOwner），titlebar 常驻不销毁，每个 tab 目录都被强制拉起整套 MCP/LSP 且永久 pin。titlebar 只需显示 title/status，改为 `peek({bootstrap:false})` 只读 store。
- **首页对选中项目的全部 sandbox 一次性 `loadSessions`**（`home.tsx`）：`loadSessions` 是真实 `session.list` HTTP，服务端 instance-context 中间件对任何带 directory 的路由都会触发该目录整套 `InstanceStore.load()`（client 端 `{bootstrap:false}` 拦不住服务端）。旧代码对 `projectDirectories()`（含全部 sandboxes）`Promise.all` 全量拉起，有几个 sandbox 就同时起几套完整进程树。改为只主动加载主 worktree 的 session，sandbox 只在真被展开/进入时才 bootstrap。
- **启动时对 N 个历史项目自动配色 → 逐一 `project.update` 触发服务端 bootstrap**（`layout.tsx`）：`project.update` 走 instance-context 中间件，每个 directory 都触发 `InstanceStore.load()`。改为统一走 `projectMeta`（bootstrap:false）只在本地缓存颜色，用户真正进入项目时再由正常流程同步到服务端。
- **`projectMeta()`/`projectIcon()` 写入触发整套 bootstrap**（`child-store.ts`）：元数据/图标写入本不需要拉起 MCP/LSP/watcher，改为 `ensureChild(dir, { bootstrap: false })`。
- **`dialog-select-directory` 用 `child()` 锁住历史目录**（`dialog-select-directory.tsx`）：同 enrich，改 `peek({bootstrap:false})` 避免 pinForOwner 永久锁住历史项目致重连重新 bootstrap。

#### 变更

- **应用图标更换为恶龙露比**（`icons/{dev,beta,prod}/icon.ico`）：任务栏图标 + 安装包/文件夹图标统一。源图内部为单帧非正方形 PNG，已重打为 16/24/32/48/64/128/256 七帧多分辨率正方形 ico，满足 electron-builder 与 Windows 任务栏要求。

### [0.6.24] - 2026-07-06

> 修复健康检查 3s 超时误报 unhealthy + SSE 心跳超时 30s→90s 配合 sidecar Event Loop 阻塞。

#### 修复

- **健康检查 `/global/health` 超时太短导致粉红 dot**（`server-health.ts`）：sidecar 繁忙时健康检查 3s 超时、连续 2 次失败即标 unhealthy，状态灯从绿变粉红。`defaultTimeoutMs` 3000→30000，给重型步骤间足够余量。
- **SSE 心跳超时 30s→90s**（`global-sdk.tsx`、`server-sdk.tsx`）：配合 sidecar Event Loop 阻塞时长，90s 防止深度阻塞时的误断连。超时前保持连接存活，断链采用指数退避重连。

### [0.6.23] - 2026-07-06

> 修复 GUI 打开即 200+ 进程 / 5-7GB 内存暴涨（历史项目全量拉起 MCP）。

#### 修复

- **[核心] 首页启动对所有历史项目全量 loadSessions 触发 MCP 风暴**：`layout.tsx` 启动时无条件对 `server.projects.list()` 里每一个开过的历史项目并行 `loadSessions`；`session.list` 走 instance 路由中间件（`instance-context.ts`）无条件 `InstanceStore.load()`，未加载目录直接触发 `bootstrap.run()→plugin.init()` 拉起整套 MCP server。实测 9 个历史项目 × 完整 MCP roster，`app.getAppMetrics()` 抓到 sidecar 子进程树 15 秒内从 0MB 飙到 7882MB / 200+ 进程。改为只预热 `server.projects.last()`（最近一个项目），其余交给用户实际打开项目时按需加载。
- **首页 Kanban 对所有项目无条件拉起 path/lsp/provider query**：`child-store.ts` 中这三个 query 原本走批量 `useQueries` 无条件触发，改为同 mcpQuery 一样只在 `activeMcpDirectory` 命中时才 `enabled`（`server-sync.tsx` 补 `fetchQuery` 兜底 enabled 翻转不自动 fetch 的问题）。
- **重连/全局 disposed 事件对所有历史目录重新拉起 MCP**：`server-sync.tsx`/`global-sync.tsx` 的 `server.connected`/`global.disposed` 批量 fanout 循环原本无条件遍历 `children.children`，改为只刷新 `pinned`（当前打开）的目录。
- **`server.instance.disposed` 单目录事件无冷却重新 bootstrap**：`event-reducer.ts` 新增 15s 冷却 + `isPinned` 门控，防止服务端连续 dispose 同一目录时客户端跟着无限重连、重建整套 MCP。
- **目录淘汰只清客户端缓存，服务端子进程永不回收**：`onDispose` 补调 `/instance/dispose`，目录从 GUI 淘汰时同步通知服务端关闭该目录的 MCP/LSP/watcher。

#### 新增

- **进程内存诊断日志**：`desktop/src/main/index.ts` 每 15s 把 `app.getAppMetrics()` + sidecar 全量子孙进程树（PowerShell CIM 查询，含 MCP 的 node/bun/python 子进程）写入日志；本次问题定位靠此直接抓到实证。

### [0.6.22] - 2026-07-06

> 补齐 global-sdk SSE 事件流的心跳 + 重连修复，与 server-sdk 保持一致。

#### 修复

- **global-sdk SSE 心跳/重连未同步修复**：0.6.19 仅修复了 `server-sdk.tsx` 的心跳竞态和重连策略，`global-sdk.tsx` 遗漏——心跳超时仍为 15s（应 30s）、重连仍为固定 250ms（应指数退避 256ms→2s）。深度思考超 15s 时 global-sdk 误判断连 → 固定 250ms 疯狂重连 → 刷新风暴 → 输出延迟数分钟。补齐：心跳 30s + 指数退避 + 成功重置（`global-sdk.tsx`）。

### [0.6.21] - 2026-07-05

> 文档全仓扫描清理：修复 jcodemunch README 链接/命令、GitHub Action README OpenCode→RedCode 品牌重命名、glossary PR 引用改指上游。

#### 修复

- **jcodemunch README 错误**：链接 `colbymchenry/jcodemunch` → `jgravelle/jcodemunch-mcp`，安装命令 `npx` → `uvx`（`README.en.md`）。
- **GitHub Action README 品牌遗留**：`opencode` → `RedCode`、`/opencode` → `/redcode`、`/oc` → `/rc`、mock owner `sst`→`JiaHuiRed`（`github/README.md`）。
- **glossary PR 引用指向错误仓库**：`JiaHuiRed/RedCode/pull/XXXXX` → `anomalyco/opencode/pull/XXXXX`，产品名 `OpenCode`→`RedCode`（`.opencode/glossary/*.md` 17 文件）。

#### 文档

- **`packages/web/README.md`**：替换 Starlight 脚手架模板为 RedCode 文档站说明。

### [0.6.20] - 2026-07-05

> 修复 GUI streaming 期间每 token 全量重跑 markdown 解析导致主线程过载、心跳超时断连。

#### 修复

- **GUI streaming 卡死/重连**：`message.part.delta` 每 token 更新 store → `createPacedValue` 每 24ms 释放 chunk → `Markdown` 全量重跑 `marked.parse()` + Shiki 高亮 + `DOMPurify.sanitize()` + `morphdom()`。文本越长 O(n²)，3000 字符时每次 ~100ms → 主线程过载 → 15s 心跳超时 → SSE 断连显示"重试中"。`PacedMarkdown` 加 300ms 节流，streaming 期间 markdown 重解析频率从 ~125 次降到 ~10 次（`packages/ui/src/components/message-part.tsx`）。

### [0.6.19] - 2026-07-05

> 修复 SSE 心跳计时器竞态导致连接被误杀、事件丢失、GUI 数分钟才出字。

#### 修复

- **SSE 心跳 `clearTimeout` 竞态**：`resetHeartbeat()` 中 `clearTimeout` 在 timer callback 已被事件循环入队后无效，stale callback 执行 `attempt?.abort()` 误杀当前健康连接 → `reader.cancel()` 丢弃缓冲区中未读事件 → 250ms 重连间隔期间 GlobalBus 事件也丢失。模型深度思考 >15s 后恢复输出时尤其容易触发，延迟乘数累积可达分钟级。
  - 增加 `heartbeatGen` generation counter：每个 timer 捕获当前 gen，callback 运行前检查 `gen !== heartbeatGen`，旧 callback 直接 return 不 abort（`server-sdk.tsx`、`global-sdk.tsx`）。
  - `clearHeartbeat()` 同步递增 gen，确保 `stop()` 和 `finally` 块中的清理也能兜住 stale callback。

---

### [0.6.18] - 2026-07-04

> 同 TUI 0.7.6：session 删除 404 修复 + 思考中卡住 fallback 轮询。

#### 修复

- 同 TUI 0.7.6 changelog（共享代码）。

### [0.6.17] - 2026-07-03

> 图片预览支持多图左右切换。

#### 新增

- **图片预览左右切换**：输入框附件和已发送消息中的多张图片，点击预览后可通过左右箭头按钮或键盘方向键切换，顶部显示 `1 / N` 计数器。单张图保持原有行为（`image-preview.tsx`、`message-part.tsx`、`prompt-input.tsx`）。

### [0.6.16] - 2026-07-01

> 首页左下角新增跨 session 看板：缓存命中率环形图 + 累计花费。

#### 新增

- **首页看板 `HomeStatsPanel`**：聚合当前项目下所有 session（含子 agent worktree session）已 denormalize 好的 `cost`/`tokens` 汇总列，纯客户端 reduce，无需新起 server/IPC 通路。展示缓存命中率环形图（read/write/miss/output 四段）+ 累计花费（统一折算 ¥）。极小占比分段加最小可视弧长兜底，避免被反锯齿吃掉（`packages/app/src/pages/home-stats.tsx`）。
- `session-context-metrics.ts` 导出 `CNY_PROVIDERS` 供看板复用；`zh.ts`/`en.ts` 新增 `home.stats.*` 词条。

---

### [0.6.15] - 2026-06-30

> 第三方 code review P0 安全修复：附件写入路径遍历防御。

#### 安全

- **write-attachment 防御路径遍历**：主进程 IPC handler 此前直接 `join(sessionDir, ".attachments", filename)` 写文件，未校验 renderer 传入的 `filename`。虽然正常路径用 `uuid().ext` 构造无风险，但主进程作为特权端不应信任 renderer 输入。改用 `resolve` 并校验最终路径仍在 `.attachments/` 内，越界即抛错（`packages/desktop/src/main/ipc.ts`）。

---

### [0.6.14] - 2026-06-30

> 移除 Office 聊天室 UI 与桌面第二窗口。

#### 移除

- **聊天室界面下线**：删除 `pages/chat/` 页面、标题栏聊天气泡入口、`/chat` 路由与 `layout.tsx` 的 chatMatch 布局分支；桌面端移除第二个 BrowserWindow（`createChatWindow`/`getChatWindow`/open-chat-window IPC/preload `openChatWindow`/renderer `isChatView`，连带清理无用 `lazy` import）。配合后端 TUI 0.6.38 一并下线（`packages/app`、`packages/desktop`）。

---

### [0.6.13] - 2026-06-29

> 图片附件落盘 + 修复 dev 模式 fs/promises 浏览器兼容报错。

#### 新功能 / 修复

- **图片附件持久化 IPC**：粘贴/拖拽图片后通过 `write-attachment` IPC handler 写入 `sessionDir/.attachments/{uuid}.ext`，`build-request-parts.ts` 以 `file://` URL 路径替代 base64 dataUrl 传给后端，减少内存占用（`packages/desktop/src/main/ipc.ts` → `preload/types.ts` → `preload/index.ts` → `renderer/index.tsx` → `platform.tsx` → `prompt-input.tsx` → `attachments.ts`）。
- **dev 模式浏览器兼容修复**：`attachments.ts` 移除 `import path from "path"`、`import { mkdir } from "fs/promises"` 及 `Bun.write()` 调用（Vite 打包时 externalize 报错），改为可选 `writeAttachment` IPC 回调，web 平台优雅降级。

---

### [0.6.12] - 2026-06-24

> 原生右键菜单深色化 + 中文化。

#### 优化

- **原生右键菜单深色主题**：强制 `nativeTheme.themeSource = "dark"`，原生右键菜单（图片/视频）不再显示白色系统菜单，与 app 深色风格一致（`packages/desktop/src/main/index.ts`）。
- **原生右键菜单中文化**：`electron-context-menu` 增加 `labels` 中文映射（图片另存为、复制图片等），隐藏多余的"全选"（`packages/desktop/src/main/index.ts`）。

---

### [0.6.11] - 2026-06-23

> 审视面板毛玻璃穿透 + 清理已废弃侧边栏入口。

#### 修复

- **审视面板磨砂效果失效**：右侧审视面板虽已有 `backdrop-filter: blur` 规则，但 `tabs.css` 通过 `#review-panel &[data-variant][data-orientation]` 嵌套选择器（特异度 1,4,0）设置实色 `background-color`，覆盖了外层磨砂透明规则。改用 `!important` 强制清透 tabs 根、tabs-list、`.sticky` 按钮区、tabs-content 的背景色，并清除 `.sticky::before` 渐变遮罩（`index.css`）。
- **已废弃"切换侧边栏"残留入口**：侧边栏功能早已移除，但菜单栏视图菜单和命令面板中仍保留 `sidebar.toggle` 条目，点击无反应。移除菜单项（`desktop-menu.ts`）和命令注册（`use-session-commands.tsx`）。

---

### [0.6.10] - 2026-06-22

> 气泡配色分化 + 会话标题栏毛玻璃 + 审视面板默认打开上下文。

#### 优化

- **助手/用户气泡配色分化**：助手气泡改蓝紫调 `rgba(168,180,240,0.12)`、用户保持粉色 `rgba(248,164,208,0.15)`，视觉上一眼区分来源方向（`session-turn.css`、`message-part.css`）。
- **会话标题栏毛玻璃**：将不透明渐变背景替换为轻磨砂 `rgba(18,18,18,0.15) + blur(4px)`，与气泡同风格——能透视聊天背景，又有一层薄玻璃质感（`message-timeline.tsx`）。
- **审视面板默认打开上下文**：右侧面板初始化时自动展示上下文标签页，无需手动点击打开（`layout.tsx`）。

---

### [0.6.9] - 2026-06-20

> 移除冗余嵌套 QueryProvider — 简化 context 树。

#### 重构

- **移除重复 QueryProvider**：`AppInterface` 内部嵌套了一层 `<QueryProvider>`，其所有子节点（`GlobalSDKProvider`、`ServerSDKProvider`、`ServerSyncProvider` 及全部页面组件）已在 `AppBaseProviders` 中被外层 QueryProvider 包裹，内层 `new QueryClient()` 的 cache 域完全冗余。删除后所有 TanStack Query 调用自然落入外层 cache，行为一致（`packages/app/src/app.tsx`）。

---

### [0.6.8] - 2026-06-20

> ELECTRON_MIRROR 镜像配置 — Windows electron-builder 下载失败修复。

#### 新增

- **Windows electron-builder 下载镜像**：国内网络 electron-builder 从 GitHub 下载 electron 42.x 经常超时/失败。在 `packages/desktop/package.json` 所有含 `electron-builder` 的 scripts 前 prepend `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`，确保 Windows 构建走国内镜像加速（`packages/desktop/package.json`）。

---

### [0.6.7] - 2026-06-18

> 聊天气泡 iMessage 风格改版 — 圆角有机造型，双向粉色统一。

#### 优化

- **气泡造型 iMessage 化**：助手/用户气泡从直角矩形改为大圆角非对称造型（助手 `4px 20px 20px 20px`、用户 `20px 20px 4px 20px`），一角收紧指示来源方向，其余三角大弧。去掉三角形小尾巴和 emoji 装饰（`session-turn.css`、`message-part.css`）。
- **助手气泡与用户统一粉色**：助手气泡从偏青蓝 `#7ec8e3` 改为粉色 `#f8a4d0 16%`，与用户气泡同色系、方向镜像（`session-turn.css`）。

---

### [0.6.6] - 2026-06-17

> 深色模式气泡粉色修复 + 侧栏全彩分配 — 深色背景气泡粉色可见，侧栏 12 项 10 色各不撞。

#### 修复

- **深色模式气泡粉色可见**：`color-mix` 基底从透明 `--surface-base` 改为纯色 `#151515`，品红 8%→20%，边框 25%→40%；兼容 v1 `@media` 和 v2 `[data-color-scheme]` 双主题系统（`message-part.css`）。
- **侧栏统计全彩分配**：12 项统计分配 10 种不同色值——引入 `--text-interactive-base`（蓝）为 cache 独立着色，`--syntax-comment`（灰）为助手消息，用户消息复用绿、消息数复用黄，其余 8 项各占一色，视觉全分散（`session-context-tab.tsx`）。

---

### [0.6.5] - 2026-06-16

> UI 细节打磨 — 去掉助手分割线、用户气泡变粉、context 颜色去重、缓存改名。

#### 优化

- **去掉助手回复左边框**：移除 assistant content 的 cyan 左分割线，保持对话流干净（`session-turn.css`）。
- **用户气泡粉色化**：背景改为 8% 品红透明色，边框 25% 品红混合，整体偏粉（`message-part.css`）。
- **Context 面板颜色去重**：总 token=绿、输入=青、输出=品红、消息数=黄、使用率=黄、推理=黄、用户消息=绿、助手消息=青，不再撞色（`session-context-tab.tsx`）。
- **"缓存 token（读/写）"→ "Cache Hit"**：中英文标签统一简化（`i18n/zh.ts`、`i18n/en.ts`）。

---

### [0.6.4] - 2026-06-16

> UI 视觉优化 — 头像放大 20%、上下文面板彩色统计、聊天气泡多色边框。

#### 改进

- **头像放大 20%**：消息列表中用户和助手头像从 40px 放大至 48px，更清晰易辨（`avatar.css`）。
- **上下文面板彩色统计**：Context 标签页 16 项统计指标按类型着色——绿色（token 数）、黄色（使用率/推理）、青色（provider/模型/缓存）、品红（消息数）、红色（费用），一目了然（`session-context-tab.tsx`）。
- **聊天气泡多色左边框**：用户气泡保持品红左边框，助手回复加青色左边框，工具调用组加黄色左边框，bash 输出加绿色左边框——四种颜色区分四种内容类型（`session-turn.css`、`message-part.css`）。
- **缓存命中率显示精确到两位小数**：侧栏缓存命中率从一位改为两位小数，更精确反映实际缓存效能（`session-context-metrics.ts`、`session-context-format.ts`）。
- **缓存命中率计算修正**：深层套 `cache.miss` 元数据而非回退 `sumInput`，避免分母多算缓存命中导致命中率偏低（`session-context-metrics.ts`）。

---

### [0.6.3] - 2026-06-16

> 主页默认看板视图 + Gsoul 褪 AI 味 — 进入主页直接看工作中/需关注/空闲三列看板；人格文档清理 AI 腔。

#### 变更

- **主页默认看板视图**：进入主页默认显示看板（工作中/需关注/空闲三列），状态一目了然，不再默认会话列表；右上角按钮仍可切回列表（`pages/home.tsx` view 默认值 `list`→`kanban`）。

#### 改版

- **Gsoul 褪 AI 味**：全篇 5+ 处二元对比句式（"不X,但Y"/"不是X,是Y"）改为直接陈述；删懒极端（"谁都绑不住"→"谁也拦不住"）；工作习惯段精简 40%（MCP 优先细则已移至 AGENTS.md）。-31/+24 行，净减 7 行（`~/.redcode/souls/Gsoul.md`）。

---

### [0.6.2] - 2026-06-15

> Office 群聊界面 — Group 联系人变身真实群聊（消息气泡 + 输入框 + 发送），可在办公室直接协调敏敏和小宋一起干活。

#### 新增

- **Office Group 群聊 UI**：点 Group 联系人从「会话列表」变为真实群聊界面——消息气泡按 sender 区分（User 右对齐紫蓝、TUI/GUI 左对齐+头像）、底部输入框（Enter 发送/Shift+Enter 换行）、3 秒轮询刷新、自动滚底、agent 处理中显示「TUI & GUI are thinking...」指示器（`pages/chat/index.tsx`）

#### 修复

- **会话列表跨目录可见**：`fetchSessions` 改用 `scope=global` 可见 TUI+GUI 全部目录的会话；`isTuiSession` 判断从脆弱的 `includes("dist")` 改为路径匹配（`/dist`、`redcode`、`/opencode`，归一化斜杠+小写）（`pages/chat/index.tsx`）

---

### [0.6.1] - 2026-06-15

> Plan 面板 + Kanban 看板 + CNY 官方定价 — 侧栏新增 Plan 标签实时追踪 todo 进度，主页新增看板视图按状态分列管理会话，DeepSeek/MiMo 计费改用官方人民币定价不再汇率换算。

#### 新增

- **Plan 面板（侧栏标签页）**：侧栏新增常驻 Plan 标签，展示当前会话完整 todo 计划——进度条 + 百分比 + 进行中/已完成/待处理统计 + 全列表（状态指示器：脉冲圆点=进行中、勾号=已完成、空心圆=待处理），空状态有引导提示（`session-plan-tab.tsx` + `session-side-panel.tsx` + `helpers.ts`）
- **Kanban 看板（主页视图切换）**：主页搜索栏右侧新增列表/看板切换按钮（`menu`/`grid-plus` 图标），看板三列：工作中（Spinner）/ 需关注（权限/错误/未读）/ 空闲，卡片显示会话标题+项目名+状态指示器（`home-kanban.tsx` + `home.tsx`）

#### 修复

- **DeepSeek/MiMo 计费改用官方 CNY 定价**：之前取 models.dev USD 值 ×7.2 换算，存在汇率过时（实际 6.76）和双重转换精度损失；现在 `models-dev.ts` + `provider.ts` 对已知模型直接注入官方 ¥/M 价格（Flash: input=1/output=2/cache=0.02，Pro: input=3/output=6/cache=0.025），GUI 侧 `session-context-metrics.ts` 按 providerID 判断币种，`session-context-format.ts` CNY 直显/USD 按 6.76 换算
- **USD→CNY 汇率更新**：`session-context-format.ts` 汇率从 7.2 更正为 6.76（2026-06 实际汇率），TUI 侧 `sidebar/context.tsx` 同步更新

---

### [0.6.0] - 2026-06-13

> RedCode Office — 虚拟办公室入口，从小宋界面一键进入，统一管理敏敏/小宋的所有 session。

#### 新增

- **RedCode Office 入口**：标题栏新增聊天气泡按钮（`chat-bubble` 图标），点击进入 `/chat` 路由，全窗口展示办公室界面（`titlebar.tsx` + `icon.tsx`）
- **办公室布局适配**：`/chat` 路由自动切换 `items-stretch` 填满窗口，跳过常规 session 的圆角/边距样式（`layout.tsx`）
- **session 历史列表**：左侧 TUI/GUI/Group 三个联系人，点击展示对应 agent 的 session 列表，支持模型名称和时间显示（`pages/chat/index.tsx`）

#### 变更

- **移除跨会话感知注入**：随 TUI 侧 `recentSessionDigest` 移除，不再每轮注入 ~500 token 的 session 摘要（服务端变更）
- **包含服务端更新 TUI 0.6.0**：ChatRoom DB schema + Chat HTTP API + recentSessionDigest 移除。详见 TUI 0.6.0

> **Office 后续计划（0.6.3+）**：点击 session 查看对话详情 / UI 对齐小宋主题（毛玻璃/背景图/头像）/ 聊天室 ↔ agent 同步 / `@敏敏`/`@小宋` 路由

---

### [0.5.10] - 2026-06-13

#### 变更

- **小宋人设优化（Gsoul）**：基于真实宋雨琦性格调整——北京大妞豪爽直率、段子体质、容易害羞。工作行为与敏敏对齐（先查再做），人格差异只在语气。移除速度暗示，消除 soul 与工作纪律冲突
- **包含服务端更新 TUI 0.5.8**：缓存命中率修复（绝对时间戳）+ 提示词工具纪律强化 + memory 追加模式 + 系统提示词瘦身。详见 TUI 0.5.8

- **成本显示 USD→CNY 汇率换算**：`session-context-format.ts` 将 API 返回的 USD 成本按汇率 7.2 换算为人民币显示，而非直接改货币符号
- **Token 统计聚合全会话**：`session-context-metrics.ts` 累计所有 assistant 消息的 token 数据（input/output/reasoning/cache），而非仅取最后一条
- **Session digest 缓存**：`instruction.ts`（TUI）首次计算 `recentSessionDigest()` 后缓存，避免每轮重算导致系统提示变化 → DeepSeek prefix cache 失效

### [0.5.9] - 2026-06-12

#### 修复

- **DeepSeek / MiMo 成本少算缓存未命中（硬编码修复）**：models.dev 远程 API 中 DeepSeek 和 Xiaomi MiMo 所有模型的 `cache_write` 均为 null（→ 0），而这两家没有独立 cache write 价格（缓存未命中 = input 原价）。代码中 `adjustedInput = totalInput - cacheRead - cacheWrite` 把未命中 token 全部分配到 `cache.write` 计费项，但 `cache.write = 0` 导致这些 token **完全不收费**（如 600 miss + 400 hit 场景：实收 $0.00112，应为 $0.0851，差 76 倍）。在 `packages/core/src/plugin/models-dev.ts` 中硬编码 DeepSeek 和 Xiaomi 的自定义 provider 的 `cache.write` = `input`。不影响 Anthropic/OpenAI 等有独立 cache write 价格的 provider（`packages/core/src/plugin/models-dev.ts`）

### [0.5.8] - 2026-06-12

#### 修复

- **包含服务端更新 TUI 0.5.2**：token-compressor 插件重写（消除流式中断）+ DCP 恢复（去重/compress/nudge）+ engine compaction.threshold 兜底。详见 TUI 0.5.2

### [0.5.7] - 2026-06-12

#### 修复

- **包含服务端更新 TUI 0.5.1**：ast-grep lazy load / plugin undefined hook guard / provider null guard，修复 sidecar 启动后 provider.list 返回 500、模型列表为空、项目加载失败的问题

### [0.5.6] - 2026-06-11

#### 修复

- **缓存命中率二次修正（GUI 侧）**：同 TUI 0.5.0，`session-context-metrics.ts` 的公式从 `read/(read+write)` 改回 `read/(input+read+write)`，与 DeepSeek 平台数字对齐（`session-context-metrics.ts`）

#### 新增
- **代码审查技能（ce-code-review）**：移植自 EveryInc/compound-engineering-plugin（20.9k stars），14 个人格化审查员，onfidence-gated 去重流水线，P0-P3 严重性分级 + autofix 分类，双模式（交互式自动修复 / mode:agent 仅报告）
- **opencode-snip 插件**：自动为 git/npm/docker 等命令输出加 snip 前缀，过滤冗余输出，减少 60-90% token 消耗
- **local-stats 本地编码统计插件**：纯本地编码活动追踪，记录每次 edit/write/read 调用，统计文件变更行数，按天存 JSON 到 `.redcode/stats/`，无需外部 API

#### 修复
- **DCP 插件配置恢复**：.opencode/redcode.home.jsonc 源模板补回 plugin 字段，修复 build 后 DCP 插件丢失问题

#### 变更
- **移除 /deepwork 引用**：goal-automation skill 中删除未实现的 /deepwork 手动模式段落
- **技能打磨**：goal-automation / simplify / diagnose 三个技能修复编码损坏，simplify 新增 RedCode 工具链提示
### [0.5.5] - 2026-06-11

#### 新增

- **包含服务端更新（TUI 0.4.15）**：双层记忆系统（项目级+全局回退）、新项目自动初始化 `.redcode/`、Soul 自动注入（GUI 模式自动加载小宋人格，无需手动 `/gui-persona`）、AGENTS.md 重写、Soul 模板瘦身

#### 修复

- **缓存命中率计算修正**：分母 `input + cache.read + cache.write` 重复计入导致永远 ~99%→改为 `cache.read + cache.write`，保留一位小数（`session-context-metrics.ts`）

### [0.5.4] - 2026-06-10

#### 新增

- **全局插件配置**（`~/.redcode/redcode.jsonc`）：新增 `plugin` 字段，将 ecc-shell-stub.js 和 @tarquinen/opencode-dcp 配置为全局插件，切换工作区时不再丢失。解决了之前只在 RedCode 项目目录下才能使用完整插件集的问题。

#### 变更

- **ecc-shell-stub.js** 复制到 `~/.redcode/plugin/` 目录，作为全局 ECC 三件套（memory-automation / guardrail-profiles / defensive-agent）
- **@tarquinen/opencode-dcp** 通过 npm 全局安装（v3.1.12），提供动态上下文裁剪功能

 #### 修复
 
 - **缓存 token 分母为 0 问题**：`session-context-tab.tsx` 中 cacheTokens 的 `read / write` 显示在 write=0 时展示 `168,704 / 0` 看起来像除法 bug。改为按缓存命中率展示：`read / write (XX%)`，write=0 时只显示 `read (XX%)`，无缓存活动时 `—`。命中率计算公式 `cacheRead / (input + cacheRead + cacheWrite)`，取自 TUI 已有实现（`prompt/index.tsx:338`）
 
#### 构建说明

```bash
npm install -g @tarquinen/opencode-dcp
```

### [0.5.3] - 2026-06-10

#### 清理

- **layout.tsx 复杂度拆分**：1514 行单文件拆为三个模块：预取系统（247 行，`layout/prefetch.ts`）和通知弹窗（120 行，`layout/notification-toasts.ts`），主组件减至 ~1150 行（-24%）。预取系统为纯逻辑函数+createEffect hook，零 JSX 零信号耦合，可独立测试。

### [0.5.2] - 2026-06-10

#### 清理

- **包含服务端提示词更新（TUI 0.4.13）**：GUI 以 opencode 为本地 sidecar，提示词在服务端选取并对两端生效；本版随打包吃到「移除 CodeGraph 死引用」的提示词清理，详见 TUI 0.4.13。

### [0.5.1] - 2026-06-10

#### 改进

- **Edit 工具模糊搜索反馈**：`oldString` 精确匹配失败时，自动用 Levenshtein 滑动窗口搜索最接近的匹配块，返回相似度百分比、匹配文本、行号和字符级 diff，帮助 LLM 快速定位并修正 oldString（`packages/opencode/src/tool/edit.ts` 新增 `fuzzyFindBestMatch` / `similarityRatio` / `charDiff`，`edit.txt` 提示词同步更新）

### [0.5.0] - 2026-06-10

#### 新增

- **全界面毛玻璃质感**：原仅作用于聊天气泡/输入框的毛玻璃（背景图局限在聊天面板），升级为整窗磨砂。背景图从聊天面板（`session.tsx`）上移到根布局（`layout.tsx`）整窗铺底，根 `<div>` 按当前视图背景图打 `data-app-frost` 标记；标题栏（`titlebar.tsx` header）与主卡片（`layout.tsx` main）加 `data-frost-surface` 改半透明材质 + `backdrop-filter: blur(18px)` 透出并模糊整窗壁纸；内部各栏（文件栏 `#file-tree-panel`、审查栏 `#review-panel`、聊天栏）去实色底，统一显露主卡片这层磨砂材质，形成全界面一致的磨砂玻璃观感。标题栏/主卡片加 `relative z-[1]` 压在背景图（`absolute z-0`）之上。未设背景图时 `data-app-frost` 不触发，维持原实色界面（`index.css` 新增 `[data-app-frost]` 规则，不入 @layer 以越过 Tailwind utilities 覆盖 `bg-*`）
- **主界面/聊天背景图分离**：新增独立的「主界面背景图」设置（`settings.appearance.homeBackground`），与聊天背景图分开管理，设置页（`settings-general.tsx`）并排放「Home Background / Chat Background」两个上传项。整窗背景按视图分流（`layout.tsx` 的 `appBackground()`）：进会话（`params.id`）用聊天背景图，首页/无会话用主界面背景图——解决主界面满屏壁纸在公司场景尴尬的问题，可单独把主界面背景留空或换中性图
- **修复·会话页毛玻璃失效**：会话页根容器（`session.tsx`）原写死 `bg-background-base` 实色，盖住主卡片磨砂层，进会话后毛玻璃消失；改为设了聊天背景图时去实色底（`classList` 条件化），露出整窗壁纸；同步把审查栏标签条 `bg-background-stronger` 也纳入去底清单
- **状态弹层下沉为审查面板标签页（方案 A）**：标题栏服务器/MCP/LSP/插件状态弹层移入右侧审查面板，变成常驻「状态」标签页。标题栏保留健康圆点作指示器，点击直接打开右侧面板的状态标签（`titlebar.tsx` 的 `openStatusTab` 经 `useLayout()` + sessionKey 打开并激活 `status` 标签）；首页/无会话时回退为原弹层（`status-popover.tsx` 用响应式 `<Show>` 在按钮态/弹层态间切换）。`StatusPopoverBody` 抽出 `fill` 入参以适配面板宽度（去弹层专用阴影/圆角）；`status` 标签在 `helpers.ts` 排除于文件标签之外、`activeTab` memo 特判常驻；新增 i18n `session.tab.status`（状态/Status/狀態）

#### 布局调整

- **毛玻璃满贴标题栏（去"镶嵌感"）**：设了背景图时主卡片（`layout.tsx` main）去掉 `m-2`/圆角/阴影外框，磨砂层满贴标题栏边到边，不再像「在主界面里镶嵌进去的一块玻璃」；未设背景图时维持原卡片样式
- **会话页亮暗互换（两侧暗、中间亮）**：原文件栏/审查栏全透显得过亮、聊天区 `0.62` 暗罩显得过暗，层次割裂。改为文件栏 `#file-tree-panel`、审查栏 `#review-panel` 走更深的磨砂底（`bg-deep 72%` + `blur(18px)`）当暗色外壳——审查栏因此也有了可见的磨砂变化（不再「没变化」）；聊天区暗罩从 `rgba(0,0,0,0.62)` 降到 `0.3`（`session.tsx`），成为更亮的焦点区（`index.css` `[data-app-frost]` 规则、`session.tsx` 遮罩）
- **首页项目栏分割线**：首页项目栏 `<aside>`（`home.tsx`）加 `lg:border-r`，与右侧会话列表区之间划出竖向分割线，视觉层次更清晰

### [0.4.7] - 2026-06-10

#### 新增

- **包含服务端更新**：随 sidecar 吃到 TUI 0.4.10 的服务端能力——`task` 工具 `isolation:"worktree"` 子代理隔离（子代理在独立 git worktree 中运行，文件改动不触碰父工作区）+ worktree 分支前缀品牌归一 `opencode/`→`redcode/`。GUI 侧无界面改动，重新 build+package 后 sidecar 即生效

### [0.4.6] - 2026-06-09

#### 修复

- **对话页右上角 MCP 状态恒"未配置 MCPs"（根治·读取端）**：TUI 同引擎同配置可见 9 个 MCP 全连，GUI 对话页却永远"未配置"。病根在 `@tanstack/solid-query` 的 `useQueries` 批量 observer——其中一条 query 的 `enabled` 在运行时 `false→true` 翻转时，既不自动 fetch（observer 卡在 `status=pending, fetchStatus=idle`），也不把外部 `fetchQuery` 灌入的缓存暴露给 SolidJS store 的 getter，导致 `sync.data.mcp` 恒读成 `{}`。先前在 `server-sync.tsx` 加 `queryClient.fetchQuery` 主动预热缓存只修了触发端，读取端仍被同一 bug 卡住。**根治**：把 MCP 这条从 `useQueries` 批量里单拎出来成独立 `useQuery`，独立 observer 的 reactive `enabled` 翻转能正确触发并反应缓存；仍只连"当前进入的项目"，首页其它项目不连，N×M spawn 风暴防护不变（`child-store.ts` 拆 `useQuery`、`server-sync.tsx` 缓存预热 effect 保留兜底、`titlebar.tsx`/`session.tsx` 用 `routeDir`/`decodeDirectory` 把 statusDir 与 activeMcpDir 对齐到同一项目 store）
- **MCP 子进程泄漏致渲染进程 OOM 白屏（第一段·杀树机制）**：sidecar spawn 的 MCP 孙进程不在任何 job 里，sidecar 一旦被掐死就成孤儿，堆积打满 Windows commit charge（如 38.8/40.8GB）→ 渲染进程报 `oom`（exitCode -536870904）间歇白屏。引擎侧 `mcp/index.ts` 的 `killProcessTree`（`taskkill /F /T`）本身没错，但三条路径让它没机会跑：① dev 热重启（electron-vite 掐主进程，`before-quit`/`will-quit` 不触发、优雅 stop 来不及）② stop 超时回退 `child.kill()` 只杀 sidecar 不级联 ③ sidecar `process.exit(1)` 崩溃 finalizer 不跑。**主进程兜底按 sidecar PID 杀整树**：`server.ts` 导出 `killSidecarTree`/`killSidecarTreeSync`（Windows `taskkill /F /T /PID`，趁 sidecar 还活着才杀得动孙进程），stop 超时回退与启动失败回退改杀整树；`index.ts` 记 `sidecarPid` 并装 `process.on('exit'/'SIGINT'/'SIGTERM')` 同步兜底（覆盖 dev 热重启——electron-vite 发的是 SIGTERM/SIGINT 能捕获）。覆盖 dev 重启/退出/超时/崩溃全路径，纯 SIGKILL 除外（需 Windows Job Object，未引原生依赖）。**注**：此段只解决“何时、对谁发杀树指令”，实测仅杀得动 `["node",…]` 直起的 MCP（browsermcp/web-search）；`npx` 包装的仍漏，见下段
- **MCP 子进程泄漏（第二段·npx 包装脱离·实测确认并修）**：实测开关一轮 GUI 后，直起 node 的 MCP 全清，`npx tsx`/`npx -y @…` 的留 11 个孤儿（node+tsserver）。根因 = Windows 上 cross-spawn 给 npx 套 `cmd /c` shim，shim 启完真 node 立即退出 → 真正的 node 子树**脱离** `client.transport.pid`（PPID 指向已死的 wrapper），既不在 sidecar 进程树内、也不被按 transport.pid 的 `taskkill /T` 命中。**修法 = MCP 命令改 node 直起插件本地 tsx**：typegraph 由 `["npx","tsx","./plugins/typegraph-mcp/server.ts"]` 改为 `["node","./plugins/typegraph-mcp/node_modules/tsx/dist/cli.mjs","./plugins/typegraph-mcp/server.ts"]`，transport.pid 落在活的、sidecar 直属的 node 上，`taskkill /F /T` 贯穿整树（node cli.mjs → node tsx server.ts → tsserver.js）。`.opencode/redcode.home.jsonc` + `~/.redcode/redcode.jsonc` 两处同改。**实测验证**：启动→连接→优雅关闭，node 24→0，零孤儿
- **typegraph-mcp 精简 14→3 工具 + 删 codegraph（服务端配置/插件）**：jcodemunch 已覆盖导航与图查询（references/cycles/coupling/blast-radius），typegraph 唯一不可替代的是 tsserver 类型精度，故只保留 `ts_definition`/`ts_type_info`/`ts_module_exports`，移除其余 11 工具 + oxc 图子系统（`server.ts` 删 `buildGraph`/`startWatcher`/`graph-queries` 引用，改 `createResolver`-only + 极简 `fs.watch` 调 `reloadOpenFile`/`closeFile` 保 tsserver 新鲜）。codegraph（早被 jcodemunch 完全覆盖、此前误留 `enabled:true` 仍在 spawn 泄漏）整块删除。两处配置同改，typecheck 通过

#### 布局调整

- **聊天背景遮罩加深 0.4→0.62**：实测 `rgba(0,0,0,0.4)` 仍偏亮压不住文字，加深半透明遮罩保证对话可读（`session.tsx`）

### [0.4.5] - 2026-06-08

#### 新增

- **微信风聊天背景图**：设置页「外观」新增「Chat Background」行，可上传图片（PNG/JPEG/WebP/GIF）作为聊天窗口背景，全局生效、所有会话共用。复用头像的 `FileReader`→dataURL→持久化设置模式，存入 `settings.v3` 的 `appearance.chatBackground`。渲染层在 `session.tsx` 聊天面板容器内加一层 `absolute inset-0 z-0` 背景层（`bg-cover bg-center`），消息内容 `z-[1]` 自然浮于其上；消息气泡保留自身底色，背景图在气泡间隙透出，呈微信聊天背景效果（`context/settings.tsx` 增字段+getter/setter、`settings-general.tsx` 上传 UI、`session.tsx` 背景层、`MessageTimeline` 滚动容器本就透明无需改）

#### 修复

- **仓鼠加载动画浅色主题被洗白**：`message-timeline.tsx` 的 `TimelineThinkingRow` 原用 `mix-blend-mode: screen` + 深色盒衬底显示仓鼠 PNG，在浅色/护眼配色下 screen 混合把图洗成近乎全白不可见。`hamster.png` 本就是透明底 RGBA（colortype 6），深色盒与混合模式纯属多余。改法：去掉外层深色盒与 `mix-blend-mode`，透明 PNG 直接平铺，任意主题下均正常显示（`message-timeline.tsx:159`）

#### 清理

- **删除 V2 三栏重构遗留的 V1 侧边栏死代码**：`04a5a1045`（6 月 2 日）将布局从 V1 单栏 rail-sidebar 重构为 V2「文件树｜聊天｜审查」三栏后，丢弃了 V1 侧边栏渲染但留下大量从不挂载的脚手架。本次彻底清理：删除 5 个孤儿文件（`layout/sidebar-{shell,project,workspace,items}.tsx` + `layout/inline-editor.tsx`）；`layout.tsx` 移除级联死代码约 886 行（`SidebarPanel`、workspace/project 两个 context、项目 rail 拖拽 handler、`rename{Session,Project,Workspace}`、`removeProject`、`showEditProjectDialog`、`delete|resetWorkspace`、`DialogDelete|ResetWorkspace`、`closeProject`、`workspaceName`、`workspaceLabel`、`hoverProjectData`、peek 悬停机制、`providers`/`location`/`isBusy`/`sortNow`/`side`/`panel` 等未用声明）。合计净删约 2300 行。`layout.tsx` 内 `return` 前加 `260608` 回滚注释，列明全部删除项，便于按提交回退。typecheck 全绿、`oxlint` 无未用变量
- **公开库个人痕迹清理（续）**：配合「公开库通用化、个人配置迁私有库」的双仓方向，扫掉 `.opencode/skill/diagnose` 与 `vision-autoagent` 两个技能提示词里残留的「哥哥」→「用户」（沿用 souls/persona 早先通用化的同款先例）。公开库现状：souls 为通用人格（非特定人设）、memory 为空、skill/command 无个人称呼——新人克隆即得干净可用的完整项目，零个人痕迹；个人 souls、记忆、画像、每日日记统归私有 `RedCode-private` 仓，两台机器经其 `pull/push` 同步。CHANGELOG 历史条目内出现的旧称呼按「客观记录」原则保留不改

### [0.4.4] - 2026-06-06

#### 新增

- **错误兜底 P1 — Retry UI**：提交消息失败时，composer 底部显示错误横幅（包含可读错误信息 + Retry 按钮 + 关闭按钮）。用户编辑输入或发送成功时自动清除。`restoreInput()` 已在 0.4.2 确保输入文本保留，此版在保留基础上增加可视化反馈和重试入口（`prompt-input/submit.ts` + `prompt-input.tsx`）
- **Session 标签状态指示器**：标题栏会话标签页新增状态指示点——`busy` 时显示黄色脉冲点、`retry` 时显示红色点。通过 `sync.data.session_status` 驱动，实时的会话运行状态一目了然（`titlebar.tsx`）

### [0.4.3] - 2026-06-06

#### 新增

- **三款新配色方案**：护眼绿（Eye Green）、米黄（Cream）、深蓝（Deep Blue）三种全新配色方案，与主题完全独立。原 ColorScheme 类型从 `"light" | "dark" | "system"` 扩展为 6 种，`data-color-scheme` 属性驱动 CSS 变量覆盖。亮色变体（cream/green）复用 light 主题变体，深色变体（deepblue）复用 dark 主题变体，各配色独立覆盖背景/文字/图标色值。**v2 主题系统（composer / 新组件）+ 老主题系统（文件树/聊天/审查面板）双套令牌均覆盖**——后者在 `packages/ui/src/styles/theme.css` 内增加对应 `[data-color-scheme="..."]` 块，盖过 OS 自动 dark 切换，避免主面板仍是白底。设置页「外观→配色方案」下拉菜单可选用。涉及 5 个核心文件（`context.tsx` 类型 + resolveMode / 两份 `theme.css` 色值 / `theme-constants.ts` / `settings-general.tsx` 选项 / i18n 中文英文繁体翻译）

#### 优化

- **ResizeHandle 可见化**：拖拽分割条新增 `background: var(--border-weaker-base)`，hover 时不再透明不可见（`resize-handle.css`）
- **标题栏底部视觉分隔**：标题栏新增 `border-b border-border-weaker-base`，与内容区建立层次（`titlebar.tsx`）
- **消息轮次淡入动画**：`@keyframes turn-fade-in` 动画让每条消息从 `opacity: 0 translateY(4px)` 淡入（`session-turn.css`）

### [0.4.2] - 2026-06-06

#### 修复

- **bootstrapDirectory 未执行导致输入框卡死（#3）**：`child-store.ts` 的 `status` 硬编码 `"complete"`，`child()` 中 `status === "loading"` 的 bootstrap 触发条件永不为真；`"server.connected"` 事件路径可能在 GUI 启动时跳过（空 `children` 或 `recent` 守卫）。`agent_ready` 永远 `false` → 统一就绪 gate 卡死 → 输入框无法发送。修复：在 `ensureChild()` 新建 child store 后直接调用 `onBootstrap(directory)`，不依赖事件或 status 检查（`child-store.ts:274-277`）
- **"请选择智能体和模型" 误弹 toast（第 6 次复发 · 根治）**：彻底定位结构性病根并收敛。submit 依赖 providers / models / **agent** 三个异步信号，但 agent 列表由 `bootstrap.ts` 的 **slow 批次** fire-and-forget 填充、**从无就绪标志**（不像 provider 有 `provider_ready`），导致 `agent: []` 空窗期内 `agent.current()` 兜底失败返回 null → 弹 toast。历次修复（0.3.16 加 submit ready、0.3.17 加 child-store fallback、0.4.1 改 `||→&&`）都只补当时暴露的那条腿，agent 这条从未被挡，故每逢单数版本改 render 路径（扰动 SolidJS 挂载时序、放大 race window）必复发。**根治三步**：① `types.ts`/`child-store.ts` 新增 `agent_ready` 字段，`bootstrap.ts` 在 agent 加载完成的 `.then` 里置真；② `local.tsx` 新增统一就绪 gate `ready() = providers.ready() && model.ready() && sync.data.agent_ready`，三信号收敛到一处，将来新增异步依赖只在此补条件、不再散落漏挡；③ `submit.ts` 改用 `local.ready()`，加载中静默返回（该 toast 历次误弹的唯一根因），仅当 gate 通过仍为 null（真·无 provider 配置）才提示。删除 submit 中已无用的 `useProviders` 依赖

### [0.4.1] - 2026-06-05

#### 新增

- **用户/助手头像系统**：`settings.tsx` 新增 `userProfile` + `assistantProfile` 字段（各含 `avatar` + `displayName`），支持 base64 图片上传。用户消息气泡旁显示自定义头像（`message-part.tsx`），助手消息显示可配置头像（`message-timeline.tsx`）。`avatar.tsx` 新增 `medium` 尺寸（2.5rem），聊天头像统一使用
- **用户消息气泡美化**：气泡内边距 8px → 10px 上下/14px 左右，圆角 6px → 10px 10px 4px 10px（右下角更锐），新增 `body-row` 弹性容器 avatar 与内容并排（`message-part.css`）
- **设置页用户资料 + 助手头像区**：`settings-general.tsx` `ProfileSection` 包含显示名输入框、用户头像上传/预览/移除；新增 `Assistant Avatar` 区，支持助手头像独立上传
- **web-search Google 兜底**：DuckDuckGo + Yahoo 后新增 Google 搜索 fallback，系统代理自动补 `http://` 前缀

#### 修复

- **"请选择智能体和模型" 误弹 toast**（第 5 次复发）：`providers.ready()` 用 `||` 判断 `all.size > 0 || connected.length > 0`，数据加载初期 `all` 先到即返回 true，但 `connected` 还空时 `defaultModel()` 返回 null，导致 submit guard 误判并弹 toast。改为 `&&`，要求 `all` 和 `connected` 都加载完才算 ready。**规律**：单数版本（0.3.16→0.3.17→0.4.1）每次改 `submit.ts` / `message-timeline.tsx` 等渲染路径时触发，修改渲染/消息组件后必须走完整数据流验证（`use-providers.ts:36`）
- **思考中仓鼠浅色模式黑标**：`/hamster.png` 透明 PNG 在浅色主题下黑色锯齿边缘可见。包裹 `background: var(--surface-base)` 容器 + `mix-blend-mode: screen` 消除黑色边缘（`message-timeline.tsx:171-178`）

#### 优化

- **`session.tsx` 拆分**：1667 行 `Page()` 函数抽出 4 个独立模块——`session-history-loader.ts`（历史加载）、`session-review-diff.ts`（Review diff 滚动）、`session-message-nav.ts`（消息导航/光标）、`session-keyboard.ts`（键盘快捷键）。主文件 1623 行，各模块面向入参不耦合闭包
- **avatar 组件新增 medium 尺寸**：2.5rem（40px），聊天头像专用，小号 2 倍

### [0.4.0] - 2026-06-04

#### 新增

- **目标自动化（goal-automation）**：本版本立项，TUI/GUI 两端共享
  - **`/goal` 斜杠命令**（`.opencode/command/goal.md`，`sync-home.bat` 同步到 `~/.redcode/command/`）：用户在 TUI 或 GUI 里 `/goal <text>` 钉住当前会话目标，agent 围着目标转、不会跑题；`/goal clear` 清掉、`/goal done` 标完成。命令 YAML `model: kimi-k2.5` 轻量模型执行
  - **`goal-automation` skill**（`.opencode/skill/goal-automation/SKILL.md`）：agent 看到大任务时主动建议一次，**不自动钉**——主动权在用户手上。触发条件（3+ 轮、跨多文件、含修/实现/重构等词、出现 done 标志，三选二即建议），不刷屏、不在 flow 时打断
  - **`opencode.jsonc` 挂载**：instructions 数组新增 `./.opencode/skill/goal-automation/SKILL.md`，TUI/GUI 两端自动加载
  - **GUI 人格内化**：Gsoul.md 加协作模式段，承认 /goal /deepwork + goal-automation，主动权归用户
- **GUI 承认 ECC 启发三件套**：Gsoul.md 加"ECC 启发三件套"段——`memory-automation` / `guardrail-profiles` / `defensive-agent` 走自动挂载机制，GUI 同享，不需额外配置

#### 推迟到 0.4.1

- **GUI 端 `/goal` chip 顶部指示器**：原计划在 Titlebar 加 chip 让用户可见当前钉住的目标。砍掉原因：数据流未设计清楚（layout.tsx 跨层读 chat 状态、OpenCode command 系统不顺、IPC 改造成本大），为假想需求硬写不划算。0.4.1 补，先想清楚数据流（备选：command 系统改造 / 新建 cross-layer store / 走 plugin 通道）

#### 变更

- 版本号升级 0.3.17 → 0.4.0

### [0.3.17] - 2026-06-04

#### 修复

- **标题栏版本号写死漂移**：`index.html` 标题栏徽章原本硬编码 `v0.3.16`，每次升级要手动改、极易漏改 → 编译出的 exe 显示旧版本。改为占位符 `v__RC_VERSION__`，`electron.vite.config.ts` 新增 `redcode:inject-version` 插件（`transformIndexHtml`），build/dev 时从 `package.json` 自动注入。GUI 自此与 TUI 一致：`package.json` 为唯一版本来源
- **桌面通知图标请求死域名**：`index.tsx` `notify()` 的通知图标硬连 `https://redcode.dev/favicon-96x96-v3.png`，该域名未注册 → 每次弹通知 DNS 解析失败、控制台刷 `ERR_NAME_NOT_RESOLVED`。改为基于 `document.baseURI` 解析本地打包图标，不再发外网请求
- **思考中仓鼠 emoji 跨平台渲染**：Win10 渲染正常（Segoe UI Emoji 多色渐变），Win11 渲染为 Fluent 扁平纯色块。将 🐹 emoji 替换为本地仓鼠图片（`/hamster.png`），彻底消除系统 emoji 字体差异

#### 构建说明

- `check-version-consistency.ts` 标题栏徽章检测兼容 `__RC_VERSION__` 占位符（视为恒一致，因构建期自动同步）

### [0.3.16] - 2026-06-04

#### 修复

- **`build-and-package.bat` 同步目标遗留**：打包脚本仍往旧目录同步 souls/MEMORY/AGENTS，导致配置迁移到 C 盘后两处残留。改为 `%USERPROFILE%\.redcode`，与 TUI `build.bat` 对齐

#### 变更

- **同步全局配置目录迁移**：GUI 以 opencode 为 sidecar，随服务端一并吃到 `~/.redcode` 迁移与全局记忆机制化注入
- 版本号升级 0.3.15 → 0.3.16

### [0.3.15] - 2026-06-03

#### 新增

- **ECC 插件状态指示器**：标题栏版本号旁显示绿色 `ECC` 标签，一眼确认插件已加载
- **压缩策略优化**：`experimental.session.compacting` 扩展 prompt，保留任务进度、错误信息、测试结果等关键上下文

#### 修复

- **审视面板拖拽方向反了**：ResizeHandle 新增 `invert` 属性，左移审视变宽、右移变窄

#### 变更

- 版本号升级 0.3.14 → 0.3.15

### [0.3.14] - 2026-06-03

#### 新增

- **ECC Plugin 集成**：`.opencode/plugins/ecc-shell-stub.js` 自动加载，提供以下功能：
  - `shell.env` — 注入 ECC 环境变量
  - `tool.execute.after` — 自动跟踪文件变更
  - `experimental.session.compacting` — 上下文压缩时保留关键上下文
  - `permission.ask` — 自动放行读/格式化/测试等安全操作
  - `changed-files` tool — 查看当前会话改过的文件
  - `git-summary` tool — 一条命令返回分支/状态/log/diff

#### 变更

- 版本号升级 0.3.13 → 0.3.14

#### 修复

- **审视面板拖拽方向反了**：ResizeHandle `edge` 默认 `"end"` 导致拖拽方向与直觉相反。改为 `edge="start"`，左移变宽、右移变窄
- **browsermcp-server 端口冲突无法恢复**：ESM 模块内使用 `require("child_process")` 导致端口被占时 kill 逻辑报错。改为顶层 `import` 修复

#### 工作流

- **版本一致性自检脚本**：新增 `script/check-version-consistency.ts`，编译前自动扫描 package.json/README/CHANGELOG/标题栏版本号是否对齐
- **build-and-package.bat 自动检查**：编译前跑版本自检 + 自动同步灵魂文件到上级目录供其他项目使用
- **全局 workspace（`.redcode/`）**：AGENTS.md/MEMORY.md/USER.md/souls 移至全局目录，所有项目共享身份与记忆，build bat 自动同步

### [0.3.13] - 2026-06-02

#### 修复

- **仓鼠位置修复**：将 🐹 从 flex `ml-auto`（最右）移到 TextShimmer"思考中"之后。当 AI 产生 reasoning heading（如 markdown 标题）时，`TextReveal` 展开不再把仓鼠推到右侧角落

#### 重构

- **抽取 `UpdateAvailableToast`**：将文件末尾的 32 行子组件移到 `components/update-available-toast.tsx`，零行为变化
- **抽取主题常量**：`colorSchemeOrder` / `colorSchemeKey` 纯常量从 `layout.tsx` 抽到 `pages/layout/theme-constants.ts`

#### 布局调整

- **FileTree → 最左、Review → 最右**：新布局为三栏：`[FileTree] [Chat] [Review]`
  - `FileTreePanel` 从 `SessionSidePanel` 内部分离为独立组件 `pages/session/file-tree-panel.tsx`
  - `session.tsx` 主 flex 容器改为：`<FileTreePanel />` → `<ChatPanel />` → `<SessionSidePanel />`
- **删除 V1 sidebar fallback**：`layout.tsx` V1 旧设计（152 行无引用代码）移除，`USE_NEW_DESIGN` 常量删除
- **删除 `sidebar.toggle` 命令**：V2 设计下 Sidebar 永不显示，对应 Cmd+B 命令移除

### [0.3.12] - 2026-06-02

#### 新增

- **思考中仓鼠动画**：在 AI 思考状态行的右侧加 🐹 emoji，左右小跑 + 上下跳动，1.2s 循环（与左侧 Mona 猫猫 gif 配合，更可爱）
- **Sidebar 展开/折叠过渡动画**：`sidebar-shell.tsx` 的 panel 容器加 `transition-opacity duration-150`，展开/折叠时内容平滑淡入淡出
- **Cmd+1 ~ Cmd+9 切项目快捷键（V2 设计补全）**：`layout.tsx` 移除 `!USE_NEW_DESIGN` 条件限制，V2 设计也支持 `Cmd+1` ~ `Cmd+9` 切换项目；修复 title bug 用 i18n `command.project.index`
- **Cmd+T 切下一个会话 / Cmd+Shift+T 切上一个会话**：在 `use-session-commands.tsx` 添加 `session.next` / `session.previous` 命令，按当前 project 内的 root session 排序（recent 在前）切到下一个/上一个

#### 优化

- **Sidebar 列表 hover 体验**：原本 hover 时只显示 archive 按钮；现在 archive 按钮的 `transition-[width,opacity]` 过渡更平滑

---

### [0.3.11] - 2026-06-02

#### 新增

- **设计系统 token**：CSS 变量化同心圆角（`--radius-xs/sm/md/lg/xl/2xl`）、分层阴影 5 级（`--shadow-xs/sm/md/lg/xl`，每级双层偏移），全局统一
- **文字排版优化**：`h1-h4` 启用 `text-wrap: balance`，段落启用 `text-wrap: pretty`，标题更整齐，段落不孤字
- **统一 focus 指示器**：所有可聚焦元素通过 `:focus-visible` 显示 2px outline + 2px offset，键盘可访问性提升
- **Sidebar 折疉态项目指示器增强**：通知红点放大到 8px、加 ring 描边、permission/error 状态加 `animate-pulse` 脉冲动画；unseen 数量徽章（>1 显示数字，>9 显示 "9+"）；working spinner 加 ring 描边

---

### [0.3.10] - 2026-06-02

#### 新增

- **V2 Titlebar 全量启用**：Tab 式 session 管理上线，支持 `Cmd+W` 关闭 tab、`Cmd+Option+←/→` 切换 tab、项目头像 + 标题显示；右侧集成 StatusPopover（token 用量）和 Update pill
- **Loading 窗口动画**：Logo 呼吸脉冲动画、内容区域淡入、进度条平滑过渡，启动体验更流畅
- **Home 搜索快捷键**：`Cmd+K` / `Ctrl+K` 一键聚焦搜索框，搜索框右侧显示快捷键提示
- **Home 空状态优化**：无 session 时显示大图标 + 标题 + 描述 + "New Session" 按钮，替代原来的一行文字

#### 清理

- 移除 9 处 `VITE_REDCODE_CHANNEL` feature flags，所有 V2 功能（Titlebar、Layout、Session Design、Prompt Input）在生产环境统一启用
- 移除已废弃的 `DesktopTitlebarIconButton` 空组件
- 简化 session-side-panel、session-header、settings-general 中的 beta 门控逻辑

---

### [0.3.9] - 2026-06-01

#### 新增

- **图标重制**：`gen-icon.py` 从 `Red.ico` 源图生成全尺寸图标，支持 16~1024px 多分辨率 ICO，修复文件资源管理器/任务栏图标模糊问题
- 图标渠道同步：dev/beta/prod 三渠道 `icon.ico` 统一使用 `Red.ico`

---

### [0.3.8] - 2026-06-01

#### 新增

- TypeGraph MCP 集成：新增 `typegraph-mcp` 代码语义导航服务器（14 个工具），支持类型解析、调用链追踪、影响分析、循环依赖检测等，与现有 CodeGraph 互补

#### 修复

- 会话模型/智能体选择修复：`submit.ts` 将 ready 检查移到取值之前，同时检查 `providers.ready()` 和 `models.ready()`，避免 provider 已加载但 localStorage 持久化数据未就绪时误弹"请选择智能体和模型"toast
- Windows 打包签名挂起：`electron-builder.config.ts` 的 `afterAllArtifactBuild` 改用 `fs.cp` + `fs.rm` 替换不可靠的 `fs.rename`；本地打包改用 PowerShell 自签名证书，不再因 signtool.exe 挂起

### [0.3.7] - 2026-06-01

#### 新增

- TTS 朗读配置面板：设置 → 通用新增「文字转语音」区块，支持独立配置 MiMo TTS `sk-` 前缀 API Key、音色选择（冰糖 / 茉莉 / 苏打 / 白桦 / 英文四种）、以及朗读功能总开关；朗读按钮仅在开关开启时显示

#### 修复

- TTS 调用逻辑修正：原实现调用不存在的本地路由 `/session/tts`（必然静默失败），现改为渲染进程直接请求 `https://api.xiaomimimo.com/v1/chat/completions`，使用 MiMo v2.5 TTS 模型，base64 WAV 响应直接通过浏览器 Audio API 播放
- 标题栏版本号动态化：版本徽章从硬编码字符串改为读取 `window.api.appVersion`（由 preload 注入 `npm_package_version`），后续只需改 `package.json` 版本号，标题栏自动同步
- 侧边栏项目自动置顶：当前活跃项目调用 `touch()` 时自动移到侧边栏列表顶部，不再保持静态创建顺序
- compaction 消息加载方向修正：`MessageV2.page` 新增 `after` 参数；compacted 会话初始加载从「summary 之前的旧消息」（原逻辑反向）修正为「summary 及之后的新消息」，避免加载大量 pre-compaction 历史导致渲染器 OOM
- 新建会话 provider 检测再修正：`global-sync.tsx` 将 `global.provider` 从初始化时的静态快照改为惰性 getter，确保 child-store 响应式 getter 运行时读取的是实时 `globalStore.provider` 而非启动时 global query 尚未完成的 EMPTY 快照；修复了项目级 provider 查询完成而全局查询尚未结束时 fallback 判断失效、导致"需要配置 provider"弹窗的竞态问题

### [0.3.6] - 2026-05-30

#### 新增

- 消息朗读按钮：AI 回复气泡旁新增 🔊 按钮，点击调用 MiMo TTS API（限时免费 `mimo-v2-tts`）朗读回复内容；利用已有的 `notification.tsx` + `sound.ts` 音频基础设施，TTS 音频通过浏览器 `Audio` API 播放；复用现有 provider 配置体系接入 TTS 模型，无需额外 API key

### [0.3.5] - 2026-05-29

#### 修复

- 大会话导致渲染器 OOM/卡死：compacted 会话的消息查询只返回 compaction summary 之后的消息（`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`），避免 GUI 加载大量旧消息导致渲染器内存溢出或无响应
- 初始消息加载量减半：`initialMessagePageSize` 从 80 降至 40，`historyMessagePageSize` 从 200 降至 80，降低首次渲染压力
- 新建项目/provider查询失败时回退到全局 provider：`child-store.ts` 补充 `!projectData` 判断，当项目级 provider 查询返回 `undefined`/`null` 时自动回退到全局已连接 providers，避免要求重新配置
- 中文 i18n 适配：`zh.ts` 补全 24 条缺失翻译（project 切换、设置页面、错误页等），修复 `layout.tsx` 中 "Export logs" 硬编码英文（TUI 同步生效）

### [0.3.4] - 2026-05-29

#### 变更

- 包含服务端更新：统一数据库路径、CodeGraph MCP 代码知识图谱集成、斜杠命令中文化、provider 错误处理改进、shell/message-v2 修复

### [0.3.3] - 2026-05-29

#### 修复

- 新建会话重复弹出"选择智能体和模型"：`child-store.ts` 项目级 provider 查询 fallback 条件扩展，当 `connected` 为空但全局有已连接 providers 时自动回退，避免每次新建会话都要求重新配置
- 会话右键重命名菜单缺失：`sidebar-items.tsx` 手动 `onContextMenu` 实现替换为 Kobalte `ContextMenu` 组件，使用 Portal 渲染避免 overflow 裁剪
- GUI 图标白底：`yayi_256x256.ico` 用 sharp `unflatten` 去除白色背景，重新打包 ico/png 资源
- DeepSeek 模型变体下拉框不显示：`transform.ts` 移除 DeepSeek 排除列表，`@ai-sdk/openai-compatible` 类型模型绕过 `reasoning` 能力检查

### [0.3.2] - 2026-05-28

#### 新增

- 项目右键删除：首页 (`home.tsx`) 项目列表新增 `ContextMenu`，右键单个项目可删除；旧侧边栏 (`sidebar-project.tsx`) 项目图标右键菜单同样新增"删除"；旧侧边栏展开后项目头部三点 `DropdownMenu` 也补充"删除"项
- 项目删除后端 API：`Project.remove` Effect 服务方法 + DELETE `/project/:projectID` HTTP 路由 + `Event.Removed` 全局事件广播；SDK (`sdk.gen.ts`) 新增 `project.remove` 客户端方法；前端 `event-reducer.ts` 监听 `project.removed` 自动从列表移除
- 会话归档右键菜单：`sidebar-items.tsx` 会话项右键菜单加入"归档"选项
- 侧边栏底部收起按钮：`sidebar-shell.tsx` 加 `onToggleSidebar` prop，左侧 rail 设置按钮上方新增侧边栏切换按钮（旧设计 / prod channel 生效）

#### 修复

- 原生右键菜单拦截 HTML 菜单：`main/index.ts` 的 `electron-context-menu` 加 `shouldShowMenu`，限定只在图片/视频上触发，避免压制 Kobalte `ContextMenu` 不出现
- 任务栏 / 标题栏图标糊化：`scripts/gen-icon.py` 移除 `GaussianBlur(radius=1.0)`，红环改用 `ellipse(width=ring_w)` 单次抗锯齿描边，小尺寸（≤32 / ≤64）超采样倍率提升至 16x / 8x，重新生成全套 PNG/ICO
- 标题栏版本徽章：`packages/desktop/src/renderer/index.html` 顶部交通灯旁版本徽章更新为 `v0.3.2`
- DeepSeek 费用按 CNY 计价（3d3b0ce）

#### 变更

- TUI 与 GUI 版本号解耦：`packages/opencode/script/build-node.ts` 不再从 `packages/desktop/package.json` 读取版本，改读 opencode 自己的 `package.json`；TUI 现可独立递增版本号，互不影响

### [0.3.1] - 2026-05-28

#### 新增

- 对话框 Ctrl+V 粘贴：`dialog-prompt.tsx` 添加系统剪贴板读取，作为 bracketed paste fallback；`keybind.ts` 新增 `dialog.prompt.paste` 快捷键绑定

#### 修复

- DeepSeek 模型变体不可用：`transform.ts` 移除 DeepSeek 模型 variants 排除列表，`openai-compatible` 类型模型绕过 `reasoning` 能力检查

#### 重构

- 删除死代码：移除未使用的 `GoLogo` 组件（`logo.tsx`）、整个 `dialog-tag.tsx` 文件、未引用的 `Descriptions` 和 `TuiAttentionSoundPaths` 导出
- 类型安全提升：`toast.tsx` `err: any` → `unknown`、`kv.tsx` `defaultValue?: any` → `unknown`、`dialog.tsx` `replace(input: any)` → `JSX.Element`、`dialog-prompt.tsx` `ctx: any` → `CommandContext`、`local.tsx` 反序列化类型标注

---

## 共同历史

### [0.3.0] - 2026-05-27

> TUI/GUI 版本号解耦里程碑。汇总 0.0.1~0.2.x 全部改动，此后 TUI 与 GUI 各自独立递增。

#### 新增

- **品牌全套替换**：opencode → RedCode，包名/URL/环境变量/Logo/图标/Wordmark/启动点阵全部换血
- **万花筒写轮眼图标**：`gen-icon.py` 程序化生成全套 Windows/macOS 图标
- **中文化**：菜单、20+ 斜杠命令、i18n 配色方案标签全部中文
- **三套新主题**：米黄、护眼绿、深蓝
- **记忆系统**：`.opencode/MEMORY.md` + `AGENTS.md` 持久记录主人偏好
- **缓存命中率显示**：TUI 底部栏 `Cache: XX%`；DeepSeek metadata fallback 修复缓存 token 按全价计费
- **Windows 剪贴板**：PowerShell `Get-Clipboard` 回退，修复 TUI 粘贴；对话框 `onPaste` 支持 Ctrl+V
- **标题栏版本号**：`ChannelIndicator` 实时读 package.json；交通灯红黄绿圆点

#### 变更

- 首页简化：删除 `LegacyHome`、频道门控、装饰性按钮；侧边栏左对齐
- UI 精简：移除帮助按钮/外网链接/Sentry/Discord；错误页仅保留「导出日志」
- 底部栏去重：移除冗余 token 用量（右侧面板已有）
- 货币符号 `$` → `¥`

#### 修复

- **桌面端 sidecar**：Bundle 留原位解析依赖 + `@parcel/watcher` shim + `await new Promise` 保活 + IPC 错误监听 + 崩溃日志
- **桌面端白屏/灰屏**：NSIS→dir-only 免安装版；`awaitInitialization` 改 `Promise.withResolvers`；`refcount.ts`/`new-session-layout.ts` 恢复
- **桌面端图标/类型**：`extraResources` + `nativeImage`；`server-sync.tsx` 参数序/`bootstrapGlobal` 属性名/三斜线指令修复
- **TUI 版本号**：`build-node.ts` 改读 RedCode package.json（原错误注入 upstream `1.15.10`）
- **上游 Logo 残留**：`logo.tsx` 全重写（Mark/Splash/Logo）；`wordmark-v2.tsx` 改 Space Grotesk 文字
- **TUI Proxy 崩溃**：`opencode.json` 格式错误致 `TypeError: Proxy target should be Object`
- **标题栏宽度/双交通灯**：`env(titlebar-area-width)` fallback `100vw`；`<Match when>` 互斥分支

### [0.2.1] - 2026-05-26

> 已合并入 0.3.0 汇总条目。缓存命中率显示、Windows 剪贴板、底部栏去重、帮助菜单精简。

### [0.2.0] - 2026-05-26

> 已合并入 0.3.0 汇总条目。首页/频道简化、i18n 补全、`refcount.ts` 白屏修复。

### [0.1.0] - 2026-05-24

> 已合并入 0.3.0 汇总条目。中文化、三套主题、记忆系统、品牌全套替换、桌面端 sidecar 修复。

### [0.0.1] - 2026-05-24

- 项目 Fork：基于 opencode (sst.dev) 二次开发，品牌重命名 opencode → RedCode
