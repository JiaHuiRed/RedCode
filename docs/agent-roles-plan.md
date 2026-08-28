# 子代理与会话姿态收口方案

> 2026-08-28 起草。起因是「来源太多」——同一个角色最多能被四个地方改写，而覆盖顺序只写在代码里、没有任何地方声明。本文件是这项收口的权威底本（模式同 `parallel-systems-plan.md`、`dsh-adoption-plan.md`），每步落地后更新状态表。调研数据出自 08-28 会话，全部实测。

## 结论先行

问题不是「角色太多」，压成一张 5 行的表治不了它。问题是**一张 `Agent.Info` 表里塞了三种互不相干的语义**，而五条装载路径全部往同一个 `cfg.agent` 里 `mergeDeep`。拆开语义，路径自然收敛。

## 现状一：五条装载路径、三层覆盖

| # | 路径 | 全机实际内容 |
| --- | --- | --- |
| 1 | 内建 native（`agent/agent.ts` 硬编码） | 默认 **8** 个（含 3 个 hidden）；开 `REDCODE_EXPERIMENTAL_SCOUT` 才是 9 个 |
| 2 | 随包 YAML profile `agent/profile/default/*.yaml` + 用户 `.opencode/profiles/` | 随包 3 份；**用户目录全机为空** |
| 3 | `{agent,agents}/**/*.md`（`ConfigAgent.load`） | 本机 3 份：architect / fixer / reviewer |
| 4 | `{mode,modes}/*.md`（`ConfigAgent.loadMode`） | **全机零文件** —— 只有 loader 还在跑 |
| 5 | 配置 `agent.*` | 能 `disable` 删掉任何一个，也能**凭空创建**（`mode` 默认 `all`） |

3/4/5 全部 `mergeDeep` 进同一个 `cfg.agent`，且**每个扫描目录各跑一遍** 3 和 4；第 2 层覆盖时 `mode: profile.mode` 是**无条件赋值**（不是 `??`）。

一个现成的病例：随包 `agent.yaml` 的 description 与内建 `build` 一字不差，在切换列表里就是重复项，而**从配置里删条目没用**——每次启动被 profile 加载器重新造出来，只能 `"agent": { "disable": true }`。本机配置里那条注释记的就是这件事。

## 现状二：三种语义共用一张表

| 语义 | 成员 | 有什么 | 没有什么 |
| --- | --- | --- | --- |
| **会话姿态**（人切换） | redmind / build / plan | 只有权限档位 | 不带模型、不带超时 |
| **子代理工种**（`task` 派） | explore / general / architect / fixer / reviewer / scout | 自己的模型 + prompt + 工具白名单 + 超时/fallback，跑独立会话 | 人切不到 |
| **内部机件**（引擎自调） | compaction / title / summary | 固定 prompt、`*: deny` | 不进任何列表 |

**硬证据**：上游那条至今还在跑的 loader 就叫 `{mode,modes}/*.md` —— 第一类本来就叫 *mode*，不叫 agent。是后来被并进同一张 `Info` 表的，而 `mode: "primary" | "subagent" | "all"` 这个字段名本身就是那次合并留下的疤：第三类被迫标成 `primary`，只能靠 `hidden: true` 从列表里藏起来，`defaultInfo()` 里还得专门写代码跳过它们（`agent.ts:437-443`）。

## 现状三：build 与 redmind 的唯一差别是 `plan_enter`

```
defaults = { "*": allow, destructive/doom_loop: ask, question: deny,
             plan_enter: deny, plan_exit: deny, repo_clone: deny, repo_overview: deny, ... }

build   = defaults + { question: allow, plan_enter: allow }
redmind = defaults + { question: allow }
plan    = defaults + { question: allow, plan_exit: allow,
                       edit: { "*": deny, ".redcode/plans/*.md": allow, <global plans>: allow } }
```

实际后果：**默认代理 redmind 下，模型没法自己提议进入计划模式**（`plan_enter` 被 `defaults` deny 掉且没补回来）；build 可以，但没人用 build。看 redmind 的 description（只讲「敏感操作先问」，不提计划）判断，这是定义时漏了一条，不是有意分工。

所以 build 不是 redmind 的别名，也不该留成隐藏别名——**把 `plan_enter` 补给 redmind，然后 build 合并删除**。

## 目标形态

### 会话姿态：2 个

结构里**不带 `model` / `prompt` / `timeoutMs` / `fallbackModel` 字段**，只有权限。从类型上杜绝与工种互相污染。

| 姿态 | 权限 |
| --- | --- |
| `redmind`（默认） | defaults + `question: allow` + **`plan_enter: allow`** |
| `plan` | 现状不变 |

`build` 合并删除。

### 子代理工种：2 个

带 model + prompt + 工具白名单 + 超时/fallback。（起草时是 3 个，`advise` 在 08-28 落地当天并回了 `explore`，理由见修正十四。）

| 工种 | 写 | 吸收 | 模型 |
| --- | --- | --- | --- |
| `explore` | 只读 | `scout` + `architect` + `reviewer` + `advise` | `stepfun-step-plan/step-3.7-flash`，`timeout_ms: 600000` |
| `execute` | 可写 | `general` + `fixer` | `opencode-go/glm-5.3-flash`，`timeout_ms: 900000` |

合并的统一理由：这些角色的**权限逐条相同**，差别只在提示词，而 `task` 调用本来就带 prompt——靠调用方的 prompt 区分 FIND / DESIGN / REVIEW 即可。模型是唯一无法按次表达的东西，所以只有「需要不同模型」才构成拆分理由。

### 内部机件：3 个

`compaction` / `title` / `summary`。纯内建、配置碰不到、不出现在「角色」这个概念里。

对用户可见的就是 **2 + 2 = 4**，分属两张互不覆盖的表。

## scout 并入 explore 的坑

scout 的招牌能力是 `repo_clone` / `repo_overview`（把依赖仓 clone 进托管缓存）。**0.9.8 已经把这两个工具放进 `GATED_TOOLS` 默认不注册**（`tool/registry.ts:71`），所以光在 explore 的权限白名单里放行**不够**——模型的工具表里根本没有它们。

两条路，二选一：

- **（倾向）接受 scout 的依赖缓存能力就此退役**。它默认关、全量历史零调用，`repo_clone`/`repo_overview` 同样零调用——这正是它们进 gated 名单的原因。
- 要留，就得给 explore 的模型显式 `provider.<id>.models.<id>.tools.repo_clone = true`，等于把 0.9.8 那笔前缀瘦身退回去一部分。

## 装载路径收敛后的形态

| | 唯一入口 | 配置能做什么 |
| --- | --- | --- |
| 姿态 | 内建 2 个 | 只能调权限，**不能新增**（姿态是引擎语义，不是用户内容） |
| 工种 | 内建，定义在 `src/agent/definition/*.md`（构建期内联，见修正九） | 覆写 model / variant / timeout / permission 走 `agent.<name>`；`disable` 保留。用户仍可自建 `~/.redcode/agent/*.md` 造**新**工种 |
| 机件 | 纯内建 | 碰不到 |

## 2026-08-28 调研修正（五路并行 + 反驳式复核）

上面「目标形态」不变，但第 4 步的**做法**被两轮调研推翻了多处。以下每条都带 file:line，是复核后净下来的判断。

修正一~六出自 08-28 上午（五路并行 + 反驳式复核），落地了 4a/4b。**修正七~十二出自 08-28 下午的第二轮**（六路并行 + 三路反驳式复核，含真构建产物字节扫描、权限 findLast 实测矩阵、live 库只读统计），它推翻了修正五、补齐了修正三的行号与清单，是第 4c 步的直接依据。

### 修正一：底本自相矛盾，已定死为「姿态不写 md」

本文件上面写了姿态「结构里不带 model / prompt / timeoutMs 字段」、「唯一入口是内建 2 个」，第 4 步却写「**五个**角色写成 md」——五个必然含 redmind 与 plan。**定死：只有三个工种写 md，姿态保持内建。** 理由是 `Info.prompt` 的语义（见修正二）——姿态一旦有 md 正文，就会顶掉模型家族提示词。

`PROMPT_PLAN` 也不能折进 `seed/agent/plan.md`：它走的是合成 user 消息 part（`session/reminders.ts:26-35`），与 `Info.prompt` 是两条通道。

### 修正二：prompt 搬进 md，不能做成「运行时读盘」

`with { type: "text" }` 是**构建期内联**，而 `seed/` 既不进构建也不进发布包（`script/sync-home.bat` 是它唯一出口）。改成运行时从磁盘读 md，等于把内建角色的提示词从二进制里拿掉——只有跑过 sync-home 的开发机才有。

更糟的是失败形态：`Info.prompt` 的唯一消费点 `session/llm/request.ts:60` 是**替换**模型家族提示词（default.md/deepseek.md…）而非追加，所以 md 缺失不会崩，而是**静默回落**。机件三件套受害最重——`title`（`prompt.ts:379`）与 `compaction`（`compaction.ts:545`）显式传 `system: []`，md 一空就是一份系统提示词都没有。

**做法**：保留静态 text 导入，把导入目标指向 `seed/agent/*.md`，模块顶层用 `gray-matter`（已是运行时依赖）剥 frontmatter 取正文。现成先例是 `project/bootstrap.ts:20-22` + `:56-68`（内联 text 导入 + 首次启动不存在才落盘），不是 `build.ts:63-66`（那是生成的虚拟入口里的 `type: "file"`）。注意 `ConfigMarkdown.parse` 用不上——它是路径读盘器（`config/markdown.ts:70-71`），内联字符串得直接 `matter(text)`。

### 修正三：别名的落点与它够不到的硬编码（行号见修正十、清单见修正十一）

md 路线表达不了别名——`config/agent.ts:143` 是 `result[config.name] = ...`，**key 强制等于 name**，写 `name: advise` 只会造出第二个 advise。配置层加 `alias` 字段要动 schema + 重跑 OpenAPI/SDK，为一轮过渡不值。

落点是 `agent/agent.ts:378-380` 的 `get`——全部 14 个服务端解析点都经它，别名不进 `agents` 记录就自动缺席 `list()`、@ 补全、姿态切换列表**和 `describeTask`**（最后这项是 `hidden` 做不到的：`tool/registry.ts:356` 只按 `mode !== "primary"` 过滤，压根不看 hidden）。

**但别名表够不到这六处，必须逐个改**：

| # | 位置 | 不改的后果 | 必要性 |
| --- | --- | --- | --- |
| 1 | `cli/cmd/tui/routes/session/index.tsx:319` `local.agent.set("build")` | 客户端字面量，`local.tsx:85` 先校验 name 在 list 里，不中弹 toast → **plan_exit 后 TUI 卡在 plan 姿态出不来** | 必须 |
| 2 | `session/reminders.ts:37` `input.agent.name === "build"` | BUILD_SWITCH 提醒**静默失效**（不抛错、不降级，最难发现） | 必须 |
| 3 | `agent/agent.ts` 的 `defaultInfo` 与 `list` 排序谓词 | `default_agent: "build"` 的配置升级后直接抛错；只修一处则排序退化、默认姿态静默变 plan。**行号与做法见修正十** | 必须 |
| 4 | `tool/plan.ts:57` `agent: "build"` 写进**新造的** MessageV2.User | 写入侧不改就一直在生产老名字（但别名删不掉另有更硬的原因，见修正十二） | 应该 |
| 5 | `session/goal-continuation.ts:64/96` `?? "build"` | 兜底指向已下线的名字（**不是**「唯一无条件跑到」的——`:47` 的 `goal_auto_continue !== true` 同样默认关，与 plan.ts:57 可达性同级） | 应该 |
| 6 | `config/config.ts:222-227` 具名 key `build`/`general`/`scout` | 经 `cli/cmd/generate.ts:10` 的 `Server.openapi()` 出仓（**不经 handlers**，schema 在 `groups/config.ts:17/27/28`）、生成进 `sdk/openapi.json:14546/14549/14555`。**这张表已漏了 redmind**，本来就该修 | 应该 |

第 7~11 处（调研新发现）见**修正十一**。

**硬约束**：`session/prompt.ts:1195-1198` 在续跑时对最后一条 user 消息的 agent 名做 `get` + 抛 `agentNotFound`。同类抛点共四个（`:467-470` 重放 task part、`:615-618` createUserMessage、`:1909-1912` slash 命令），第五个在 `session/prompt/shell.ts:43-50`。所以 `build`/`general` **必须留别名、不能物理删**——任何历史会话续跑就炸，不是降级。

**CHANGELOG 别写错**：老 `@architect` 手打**不再可用**——交互式 @ 提及的 part 由客户端从 `list()` 造（`autocomplete.tsx:517`、`app/prompt-input.tsx:664`），别名进不去。仍可用的老入口只有：`subagent_type`、历史会话续跑、`--agent`（非 `--attach` 路径）、`default_agent`。

### 修正四：权限不能取并集

`Permission.merge` 就是数组 concat（`core/permission.ts:33-35`），`evaluate` 是 **findLast**（同文件 21-31）。所以把 architect 块和 reviewer 块首尾相接，**后一个块开头的 `"*": deny` 会把前一个块的所有 allow 全部作废**。三个工种必须各**手写一份扁平白名单**，第一个键是 `"*": deny`。

两处真冲突要拍板：`advise` 的 `bash`（reviewer 有、architect 无）；`execute` 更大——general 是 `"*": allow`（继承 defaults）、fixer 是 `"*": deny` + 白名单，**根本不是同一档，写法上必须二选一**。

### 修正五：sync-home 先不动 —— **已被修正九推翻，见下**

live 的 `~/.redcode/agent/` 是**私仓工作树**，三份都在版本控制里（`git ls-files agent/`），而且历史上有 4 次在 live 侧的直接编辑。所以「手动对齐一次 live」的正解是私仓 `git rm` 一次，一步到位、零新增机械。

记账法（`.seeded-agents` 清单 + `.trash`）是为「以后还会再删角色」和「多机」买的保险，单维护者 ROI 低，**拆成独立提案**。同类先例：`CHANGELOG.md:843` 的 FreeLLMAPI 反复重现（`merge-home-config` 同样只增不删），当时的修法也是「模板与 live 两处同时删」，不是做记账。

顺带：`sync-home.bat:29` 的注释已陈旧（还写 `{agent,agents}`），改这块时一并修。

### 修正六：scout 与它的 flag 要分开

`scout` 挂在 `flags.experimentalScout` 下（`agent.ts:248`），**默认关**，所以合并它的成本比读起来低。但 `experimentalScout` 这个 flag 还门控着 @reference 的 git 物化（`reference.ts:128/208/218/224`）与 `repo_clone`/`repo_overview` 的注册（`registry.ts:313`）——**别把 flag 跟 agent 一起删**，要清单独立项并先改名。

### 测试面比原估计大一个量级

`"build"` 在 `packages/opencode/test/` 下是 **42 个文件 / 162 行**，不是三个。确定会红的：`test/tool/task.test.ts:222`（不是 :221——:221 只比 explore 与 alpha，:223 因 `general=-1` 反而假绿通过）、`test/session/prompt.test.ts:1910` 的 `toEqual(["build"])`、`test/config/agent-color.test.ts:35` 的 `get("build")`。而 architect/reviewer/fixer **零调用零断言**，改名几乎免费。


### 修正七：advise / execute **必须内建**，md-only 在发布二进制里根本不存在

拿 `packages/opencode/dist/redcode-windows-x64/bin/redcode.exe`（08-27 16:22 的真构建产物）做字节扫描：静态导入的 md（`src/agent/prompt/scout.md` 正文）**在**；构建时就已存在的三份 md-only 角色的 ASCII 标记（`name: architect`、`model: opencode-go/hy3`）**全部不在**。`~/.redcode/agent/` 的唯一写入者是 `script/sync-home.bat:33`，只被 `packages/opencode/build.bat:2` 与 `packages/desktop/build-and-package.bat:2` 调用；`project/bootstrap.ts` 只播 souls/MEMORY 与 skill，一行都不碰 agent/。

所以别名指向一个 md-only 的目标 = 把今天能用的 architect/reviewer/fixer 变成「不存在」。链路：`get("architect")` → 别名 → `agents["advise"]` = undefined → `session/prompt.ts:1195-1198` 历史会话续跑**硬抛** `agentNotFound`（不是降级）。live 数据：以 `general` 结尾的会话 15 个、`reviewer` 1 个。

**内建化是别名表的前置条件，不能拆成「先加别名、后内建」两个提交。**

### 修正八：md 的扁平 `"*": deny` 会打掉 defaults 里的**对象型**权限

`"*": deny` 的 rule 是 `permission="*", pattern="*"`，findLast 下匹配一切 —— 包括 defaults 里那些写成对象的权限。实测三笔：

- **`external_directory` 塌成 deny**：三份 md 都没写它，于是 defaults（`agent.ts:135-138`）整段白名单作废。项目外 ask→deny、`~/.redcode/skill/*` allow→deny、`Global.Path.tmp` allow→deny、工作区 `.redcode/temp` allow→deny。而 deny 在 `permission/index.ts:196-199` 是直接 `DeniedError` **硬失败**，不是弹询问。（live 的 architect/fixer/reviewer 今天就这样，读不了全局技能目录。）
- **`read` 的 .env 护栏失效**：defaults 是 `read: { "*": allow, "*.env": ask, ... }`（`agent.ts:145-150`），被 md 的扁平 `read: allow` 顶掉 → `execute` 能静默读 .env，而它同时有 write/edit。
- **`destructive` / `doom_loop` 从 ask 变 deny**：advise.md 与 execute.md 的注释写着「破坏性操作仍由 defaults 的 `destructive: ask` 拦着」，**与实际相反**。行为上这和 fixer 今天一致（同样 `"*": deny` 开头），所以**不改行为、只改注释**。

修法：`read` 在 md 里写成对象形式即可（静态可表达）；`external_directory` 依赖 `ctx.directory` 与 `skill.dirs()`，静态表达不了，**只能由代码在 md 块之后、`user` 之前重新宣告**：

```ts
Permission.merge(defaults, Permission.fromConfig(fm.permission),
                 Permission.fromConfig({ external_directory: readonlyExternalDirectory }), user)
```

被实测否掉的两个替代：放进 `agent.ts:371-385` 那个循环后补丁，会把用户自己在 `permission.external_directory` 里配的白名单从 allow 压成 ask（`instance-context.ts:23` 就是这个用法的官方示例）；循环后再补一遍 `user`，会把「per-agent > 全局」的优先级颠倒过来。

### 修正九：三份工种 md **不能再回流**（推翻修正五的「sync-home 先不动」）

`sync-home.bat:33` 把 `seed/agent/*.md` 拷进 `~/.redcode/agent/`，`ConfigAgent.load` 再把同一份塞进 `cfg.agent`，`agent.ts:368` 把**同一段白名单接到最末尾**（在 `user` 之后）。实测后果两条：修正八的补丁**一跑 build.bat 就作废**，四项全部退回 deny；而且 md 尾巴会让用户全局 `permission` 整段失效（`bash: ask` → allow、`websearch: deny` → allow）。

这不是能糊过去的实现细节：**「内建吃 frontmatter」与「同一份 md 经配置回流」在 findLast 语义下必然打架**。

**定死**：三份工种 md 移出 `seed/`，落 `packages/opencode/src/agent/definition/*.md`；`sync-home.bat` 的 agent 块整块删掉（`seed/agent/` 清空后不再存在）。用户**仍可**自建 `~/.redcode/agent/*.md`（md 型 agent 语义不变），只是我们不再默认发一份同名的进去。4a 提交里那句「同一个文件同时是构建期内联的提示词、又是运行时可覆写的定义」**作废**。

### 修正十：别名解析要在**三处**共用，配置层的 key 还要先规范化

- `Agent.defaultInfo`（`agent.ts:406`）与 `list()` 的排序谓词（`:397`）都**绕开 `get`**（`:387-389`）。只在 get 加别名，`default_agent: "build"` 仍在 `:407` 抛 `default agent "build" not found`；只修 `:406` 不修 `:397`，排序退化成 name-asc，客户端按 primary 过滤后 `at(0)` 实测是 **plan** —— TUI（`local.tsx:82`）与 GUI（`app/src/context/local.tsx:91` + `:113`）都会静默进只读姿态。
- 顺序必须**「直查优先、别名兜底」**：`agent.ts:344-351` 对任何未知 key 凭空造一个 `mode:"all"` 的角色，别名优先会被这个幽灵劫持。
- 还得在配置循环里**先规范化 key**，否则老配置里的 `agent: { build: {...} }` 会复活一个 `native:false`、`mode:"all"`、权限 `"*": allow`、description 为 undefined 的幽灵 build：它通过 `registry.ts:356` 的 `mode !== "primary"` 过滤，**同时出现在 @ 补全与 `describeTask` 里**，而 `question` 又被 defaults 的 deny 经 `registry.ts:382` 整个下架——比今天的 build 还低一档。`mode: { build: {...} }` 那条 deprecated 路径（`config.ts:789-796`）造出的更是 `mode:"primary"` 的幽灵。
- **`disable` 走别名 key 时按 no-op 处理**：`agent: { build: { disable: true } }` 不能拿去删 redmind —— redmind 是默认姿态，删了 `defaultInfo` 直接抛「no primary visible agent found」。

（旧行号已陈旧 9 行：底本先前写的 `:378-380`/`:388`/`:397`/`:248` 分别对应现在的 `:387-389`/`:397`/`:406`/`:257`。）

### 修正十一：硬编码不是六处，是十一处

修正三表里的 1~6 之外，调研另找到五处：

| # | 位置 | 不改的后果 | 必要性 |
| --- | --- | --- | --- |
| 7 | `agent/agent.ts:338-351` 配置循环不规范化 key | 见修正十：老配置复活一个权限更宽的幽灵 build，而且从配置里删条目也删不掉 | 必须 |
| 8 | `seed/command/subtask.md:4` `agent: general` | 走 `prompt.ts:1856` → `:1909` **硬抛** `agentNotFound`（live 已装同一份）。别名能接住，但它是老名字的永久生产者 | 必须（等同级） |
| 9 | `cli/cmd/run/runtime.lifecycle.ts:118` `?? "build"` | `redcode run` 不带 `--agent` 时页脚显示一个已不存在的角色名 | 应该 |
| 10 | 两处提示词「call the task tool with subagent **scout**」 | 指使模型去调一个 `describeTask` 里不存在的名字 | 应该 |
| 11 | `skill/prompt/customize-redcode.md` 的内建 agent 清单 | **今天就已经错**（写成 `OPENCODE_` 前缀、漏了 redmind）；这是进模型上下文的提示词，说错内建角色直接误导模型 | 应该 |

另有约五处纯文案/注释兜底（`tool/plan.ts` 的 "Build Agent" 文案、`cli/cmd/run/tool.ts` 与 `subagent-data.ts` 的 `subagent_type || "general"` 兜底、`demo.ts:892`、`github.ts:955` 注释），零功能影响，顺手改。

### 修正十二：别名**退不了休**，别写「一轮过渡」

`session/compaction.ts:582 / :610 / :630 / :763` 四处直接 `session.updateMessage` 铸 `role:"user"` 消息，**绕开 `createUserMessage` 与 `Agent.get`**，把历史 agent 名原样重铸。所以跑到自动压缩的老会话每压一次就再生一条 `agent:"build"`。

另一条独立通道：`session/processor.ts:588` 读的是 **assistant** 消息的 agent（来源 `prompt.ts:426-427`，重放 subtask part 时原样落库），紧接着 `:585` 就 `agent.permission`，**没有 undefined 守卫** —— 它和 `prompt.ts:1195` 那道守卫读的根本不是同一个字段。

live 规模（只读查 `~/.redcode/data/redcode.db`）：session.agent `build` 56 / `general` 15 / `reviewer` 1；message assistant `build` 17607 / `general` 197；part 表历史 `subagent_type` `general` 15 / `reviewer` 1。

**结论**：别名表按长期存在设计。CHANGELOG 里别承诺「一轮过渡后删掉」。

### 修正十三：三个工种的模型与超时兑底（08-28 落地时定的）

**前提变了**：主力收敛到 DeepSeek vision 与 glm-5.3-flash 两个多模态模型之后，**识图不再派子进程**
——主会话直读。所以 4b 给 `advise` 选官方源 vision、以及中途给 `execute` 选多模态 mimo 的那条理由
（「审查/设计要看截图」）**已经不成立**，多模态从此只是顺带属性，不是选型依据。

| 工种 | 模型 | in / out | ctx / out上限 | timeout | fallback |
| --- | --- | --- | --- | --- | --- |
| `explore` | `stepfun-step-plan/step-3.7-flash` | 走阶跃额度 | 256K / 256K | 180s | `opencode-go/glm-5.3-flash` |
| `advise` | `deepseek/deepseek-v4-flash-vision-exp` | 0.14 / 0.28 | 1M / 384K | 600s | `opencode-go/glm-5.3-flash` |
| `execute` | `opencode-go/glm-5.3-flash` | **0.075 / 0.25** | 1M / 131K | 900s | `opencode-go/mimo-v2.5` |

三条要点：

- **`execute` 从 `hy3` 换成 `glm-5.3-flash`**：hy3 是纯文本、256K/64K；glm-5.3-flash 是主力之一
  （质量有第一手判断）、1M/131K，而且比中途考虑过的 mimo-v2.5（0.14/0.28）还便宜近一半。
  **`variant` 字段删掉** —— `variant: none` 是为 hy3 的 effort 档位写的，glm-5.3-flash 的 effort 只有
  `low/high/max`，**没有 `none`**；mimo-v2.5 更是 `reasoning_options: []`。写了都是空操作。
- **超时兑底的机制**（`tool/task.ts:299-319`）：`timeout_ms` 罩的是**整个子代理运行**，不是单次请求。
  超时先 `ops.cancel`，再用 `fallback_model` 在**同一个子会话**里重发一次同样的 prompt——所以兑底模型
  看得到第一次留下的历史，是「接着干」不是「从头来」。两次都超时才 fail。
  **只配 `timeout_ms` 不配 `fallback_model` = 超时即硬失败**（explore 此前就是这样，白等三分钟）。
- **兑底一律换族**：失效模式是「模型自己卡住/推理烧不完」，同族换路由治不了它。`advise` 尤其需要
  上限——vision-exp 的推理消耗实测同一 prompt 能差 65 / 490 token。
  ⚠ `execute` 可写，重试意味着「半截改动 + 换模型接着干」，看它的汇报别只看结果。

超时的三个数字是**按用途估的、不是实测出来的**：explore 180s 沿用原值；advise 600s 给「读一圈再出
结论」；execute 900s 给「跑测试 / 跑构建」。它们只该在真卡死时触发——如果开始误杀慢活，往上调，
别往下调。

### 修正十四：`advise` 并回 `explore`（08-28 落地当天）

**触发点**：主力收敛到 DeepSeek vision 与 glm-5.3-flash 两个多模态模型之后，一个跑主力模型的只读子代理
相对主会话已经没有「换个脑子看」这层价值了。

**判据**：实测 dump 显示 `advise` 与 `explore` 的**权限逐条相同**（同一份扁平白名单，连
`external_directory` / `read(.env)` 的判定都一样），差别只有三样——提示词、模型、超时。模型这一层的
区分度一消失，`advise` 就只是「换了个提示词的 explore」。而**提示词是可以按次传的**（`task` 的入参就是
prompt），模型才是唯一按次表达不了的东西。所以：**只有「需要不同模型」才构成拆分一个工种的理由。**

这正是 4b 合并 architect + reviewer 时用的同一条逻辑，只是当时没把它推到底。

**做法**：advise.md 的正文并进 explore.md，explore 的 description 与提示词改成三段式
（FIND 找东西 / DESIGN 出方案 / REVIEW 做审查，含 reviewer 那套报告门禁），别名 `architect` /
`reviewer` / `advise` 全部指向 `explore`。`explore` 的 `timeout_ms` 从 180s 提到 **600s** —— 它现在要
干「读一圈再出结论」的活，180s 会误杀真在跑的运行；超时只在卡死时触发，对快搜索零成本。

**保留的两个已知取舍**：

- explore 仍跑 `step-3.7-flash`（走阶跃额度、256K 上下文）。它是调用量最大的工种（live 库 277 个会话，
  对比 general 15 / reviewer 1），换主力模型是一笔真实开销。**如果审查/出方案的质量不够**，改 md 里
  `model:` 一行即可，这是独立一笔、可以看效果再定。
- 256K 上下文对「审一个大 diff」可能是上限。真撞到了同样是改一行。

## 迁移步骤

| 步 | 内容 | 风险 | 状态 |
| --- | --- | --- | --- |
| 1 | 删 `ConfigAgent.loadMode` 与 `config.ts:714` 的调用 | **零**——全机零文件 | **已做 2026-08-28** |
| 2 | 删随包 YAML profile 三份 + `agent/profile/{load,resolve,types,index}.ts`；`explore`/`general` 的 description/prompt 收回内建 | **零**——`agent.yaml` 已被 disable，另两份与内建重复，用户目录空 | **已做 2026-08-28**（连带清掉 seed 里那条已失效的 `agent.disable`；live 配置同步见私仓） |
| 3 | `{agent,agents}` 收成只认 `agent/`（顺带清掉审计记的「seed 单复数双套」） | 低 | **已做 2026-08-28**（复数目录存在时打 warning，不静默丢定义） |
| 4a | `explore` 的提示词与权限并成一份 md，验证「prompt 搬进 md」这条机制 | 低 | **已做 2026-08-28**（`0419c3a8`） |
| 4b | 新增合并后的 `advise` 与 `execute`（只新增、不删旧） | 低 | **已做 2026-08-28**（`5b48e1af`） |
| 4c-1 | 三个工种**全部内建**（连 frontmatter 一起吃，见修正七）；md 移进 `src/agent/definition/`、退出 sync-home（修正九）；权限按修正八补 `external_directory` 与 `read`；删 `seed/agent/{architect,fixer,reviewer}.md` | 中 | **已做 2026-08-28**（`f952f07b`） |
| 4c-2 | 别名表 + 三处共用 resolve + 配置 key 规范化（修正十）；删内建 `build`/`general`/`scout` 与 `PROMPT_SCOUT`/`scout.md`；`redmind` 补 `plan_enter: allow`；十一处硬编码（修正十一） | 中 | **已做 2026-08-28**（`236d0bc4`，测试面并进同一提交，见下注） |
| 4c-3 | `config.ts` 具名 key 换成 redmind/plan/explore/advise/execute + 机件三件套，重跑 `gen:openapi` 与 SDK | 低 | **已做 2026-08-28**（`dc34fe97`） |
| 4 | live 对齐（**私仓**）：`git rm agent/{architect,fixer,reviewer}.md`；`command/subtask.md:4` 改 `agent: execute` | 低 | **已做 2026-08-28**（私仓 `32adb92`，未 push） |
| 5 | 三种语义各拆出自己的构造器（`posture` / `subagent` / `machine`），定义处不再互相污染 | 中 | **已做 2026-08-28**（做法与原文不同，见修正十五） |
| 6 | `agent.*` 去掉「创建」分支，只留覆写 + disable | 低 | **已做 2026-08-28**（含 fixture 的 `files` 选项与插件通道，见修正十六） |

每步独立可回退。1、2 当天可落可验。

原计划里单列的「4c-4 测试面」已并进 4c-2 —— 改代码的那一刀就会让测试红，分成两个提交等于中间
留一个红的 dev。落地时的实测基线也和调研估的不一样：`test/agent test/config test/tool test/session`
的存量红是 **35 条**不是 33 条（`revert-compact.test.ts` 那两条调研没数进去，已在 4b / 4c-1 / 4c-2
三个点位 A/B 过，动手前就是红的）。另外 `test/server` 的红条数抖动极大，且**会被磁盘占满伪装成
大面积回归**（08-28 实遇：C 盘满时同一批从 13 红涨到 44~64 红），量它必须先看 `df`。

### 修正十五：第 5 步只拆构造器，**不拆 Schema**

原文写的是「`Info` 拆成姿态/工种两个类型；内建裁到机件 + 一个最小 fallback」。两处不能照做：

- 「内建裁到机件」与**修正一**（姿态保持内建、不写 md）和**修正九**（工种也内建）直接冲突。
  起草时的形态已被两轮调研推翻，这半句作废。
- **`Info` 是 wire 契约**：它带 `identifier: "Agent"`，出现在 `/agent` 端点、`sdk/openapi.json`、
  `types.gen.ts` 的 `Agent`，TUI 与 GUI 都直接吃。拆成联合类型等于改契约 + 重生成 + 所有客户端做
  类型收窄，而底本要的收益（「从类型上杜绝与工种互相污染」）**在定义处就能拿到** —— 内建条目是
  唯一会手写这些字段的地方。

**实际做法**：`agent/agent.ts` 里三个构造器，各自结构上拿不到对方的字段：

| 构造器 | 语义 | 能给什么 |
| --- | --- | --- |
| `posture({ name, description, displayName?, color?, permission })` | 会话姿态 | 只有权限与展示。**没有** model / prompt / timeout / variant / steps |
| `subagent(name)` | 子代理工种 | 整份定义来自 `src/agent/definition/*.md` 的 frontmatter |
| `machine({ name, prompt, temperature? })` | 内部机件 | 固定 prompt + 全 deny + `hidden: true` |

`agents` 记录从约 110 行手写字面量收成 40 行。新增一条运行时守卫用例（三类角色的形态各自成立、
机件不进可见列表、可见列表恰好是 redmind/plan/explore/execute 四个）。

**没做的一半**：底本「装载路径收敛后的形态」写姿态「只能调权限」，但现在 `agent.redmind.model`
仍然能给姿态钉一个模型。没去堵，因为那更像**功能**而不是污染（「计划模式固定用便宜模型」是个合理
需求），而且它是配置层的行为、与这一步的类型隔离无关。要堵是独立一笔。

### 修正十六：第 6 步的两个前提

- **md 与 jsonc 落进同一个 `cfg.agent`**，光看值分不出来源，所以加了派生字段 `agent_origins`
  （照 `plugin_origins` 的先例：不进 Schema、`writable()` 里剥掉、不落盘）记住「哪些名字是 md 定义的」。
- **插件也是合法创建通道**：插件的 `config` 钩子直接往 `cfg.agent` 塞新 key
  （`test/agent/plugin-agent-regression.test.ts` 守这个）。所以 `plugin/index.ts` 在钩子跑完后要把
  新增的 key 补进 `agent_origins`，否则插件注册的 agent 会被静默丢掉。这条差点漏。
- 测试面：六个用例靠 jsonc 造 agent。为改成 md，给 fixture 加了 `files` 选项（实例启动**前**落文件）
  —— 在测试体里写 md 已经晚了，配置那时已读完并缓存（先试过一次，三条红）。
- **这是一次明确的能力删除**：`customize-redcode.md` 原本写「Two ways to define an agent」，
  jsonc 那条路没了，文档已同步。

## 升版时要写进 CHANGELOG 的（第 1~4c 步累计）

第 1~4c 步都没动 CHANGELOG（这一串按仓里惯例，条目在切版本时一次写）。切版本时**必须**包含
下面这些，都是对用户可见的行为变化：

- **角色从 9 个收成 4 个**：姿态 `redmind` / `plan`，工种 `explore`（只读：找东西 / 出方案 / 做审查）
  与 `execute`（可写）；机件 `compaction` / `title` / `summary` 不进任何列表。
- **老名字只经别名解析可用，且手打 `@architect` 不再可用** —— 交互式 @ 提及的 part 由客户端从
  `list()` 造（`autocomplete.tsx:517`、`app/prompt-input.tsx:664`），别名进不去。仍可用的老入口只有
  `subagent_type`、历史会话续跑、`--agent`（非 `--attach`）、`default_agent`、配置里的 `agent.<老名>`。
  **别写「一轮过渡后删掉别名」**，理由见修正十二。
- **`general` → `execute` 会静默换模型**：general 从前不带 model、跟随会话模型，execute 自带
  `opencode-go/glm-5.3-flash` + 900s 超时。影响历史 `subagent_type: "general"` 与 `/subtask`。
- **两个工种都配了超时兑底**（explore 600s / execute 900s，各带换族的 `fallback_model`）。
  此前只有 explore 有 `timeout_ms` 且没有兑底，超时是硬失败。
- **`execute` 比 general 严一档**：`"*": deny` 白名单意味着它**一个 skill 都看不见**
  （`skill/index.ts` 按 `evaluate("skill", name)` 过滤），`task` 与任意非白名单前缀的 MCP 工具也被禁。
  要放宽在 `src/agent/definition/execute.md` 里显式写 `skill: allow`。
- **`destructive` / `doom_loop` 对三个工种是 deny 不是 ask**（扁平 `"*": deny` 盖掉了 defaults 的
  ask 档），deny 是硬失败不是弹询问。这与 fixer 今天的行为一致，不是新收紧，但要说清。
- **`redmind` 补上了 `plan_enter`**：默认姿态下模型现在能自己提议进计划模式了。
- **scout 的依赖缓存能力退役**：`repo_clone` / `repo_overview` 没有任何角色再放行；
  `REDCODE_EXPERIMENTAL_SCOUT` flag 保留（它还门控 @reference 的 git 物化）。
- **配置里显式写了 `agent.build` / `agent.general` 的用户**：这些 key 现在被规范化到 redmind /
  execute 上，覆写照旧生效；但 `agent.build.disable` 从「删掉 build」退化成 no-op。
- **`~/.redcode/agent/` 不再由 sync-home 播种**（修正九）。用户自建的 md 照常加载。

## 明确不做的

- **不动 `task` 工具的调用面**（`subagent_type` 仍是字符串，老的 `architect`/`reviewer`/`fixer` 名字在第 4 步之前照常可用）
- **不改 `Permission.merge` 的语义**——本方案只动「谁来定义角色」，不动「权限怎么叠」

## 调研顺出来的独立项 —— **08-28 全部处理完**

按被发现的顺序。原计划是「不进本方案」，08-28 当天单独一批做掉了，每条各自一个提交。

1. **`experimentalScout` 改名** → `experimentalReference` / `REDCODE_EXPERIMENTAL_REFERENCE`。
   **已做**：scout agent 没了，这个 flag 还门控着 @reference 的 git 物化与 `repo_clone` /
   `repo_overview` 的注册。**保留 legacy 键** `REDCODE_EXPERIMENTAL_SCOUT`（可能已写在 live 环境里，
   静默失效等于悄悄关掉物化），按 `enableExa` 那套 `Config.all` 三键写法展开。新增用例覆盖
   新键 / legacy 键 / `REDCODE_EXPERIMENTAL` 总闸 / 都不设四条路径。
2. **`agent.ts:368` 的「md 尾巴盖过全局 `permission`」**。**查完不是 bug**：真正出事的是我们自己发的
   工种 md 经 `~/.redcode/agent/` 回流（修正九），那时排在最后的是**我们的**块，已由 4c-1 删掉
   sync-home 的 agent 播种解决。用户自己写的 md 属于「用户的 per-agent 配置」，盖过用户全局是对的。
   优先级钉成一条用例：**defaults < 内建块 < 用户全局 permission < 用户 per-agent 块**。
3. **`redcode agent create` 写进 `agents/`（复数）**。**已做**：两处改单数。同一个坑的另一半在文档里
   （见第 5 条），六处 `~/.redcode/agents/` 一起改了。
4. **`project/bootstrap.ts` 的 skill 播种从 `ctx.directory/seed/skill` 读**。**已做一半**：改成按候选
   顺序找（项目目录、`<dist>/bin/../seed/skill`），找不到且目标目录为空时打 warning 而**不再静默
   early return**。⚠ **长期修法没做**：`seed/skill` 得随发布包一起发 —— 今天只有
   `script/sync-home.bat` 在**构建机**上拷过去，别的机器上从来就没播过。那是构建系统的事。
5. **`packages/web` 的 `agents.mdx` 三语 + `Share.tsx`**。**已做（Share.tsx 明确不改）**：三语文档的
   内建清单、Explore 的三段职能、Execute、老名字别名一节、JSON 一节改成「只能覆写/禁用」、
   `@general` → `@explore`。顺带修了六处 `~/.redcode/agents/`（复数，照着放永远加载不了）。
   `Share.tsx` 那两处 `"build"` 在 v1→v2 消息迁移里给**历史**共享会话补字段，那些消息当年确实跑在
   build 上，如实记录历史不是活引用，改成 redmind 反而是篡改。
   另外修了 `customize-redcode.md` 的全局路径表：原文写 `~/.config/redcode/` 还特意标「NOT
   `~/.redcode/`」，而本 fork 的 `core/global.ts` 把 XDG 目录统一到了 `~/.redcode`，**标反了**。
6. **live 私仓里写死老角色名的提示词**。**已做**（私仓 `3f7acf3`）：`technical-documentation` 的
   「`general` 做汇总综合」改成两半都用 explore（汇总是只读推理，派给可写角色是多给权限）；
   `vision-autoagent` 去掉悬空的 `fixer.md` 引用，并注明识图优先主会话直读。
7. **GUI 的 per-session agent 写进 localStorage**。**已做**：补一条与 `store.current` 同款的自愈
   effect。原来 `pickAgent` 查不到只是回落到 `items[0]`（显示对了、看不出问题），但存的值原样留着，
   `write()` 每次又把 `scope()` 摊开写回去，老名字永远留在盘上，`restore()` 的守卫还保证它再没机会
   被覆盖。
8. **`Agent.get` 的返回类型是谎言**。**已做**：收窄成 `Info | undefined`，编译器一次抓出 9 处，其中
   **src 里两处是真的没守卫** —— `session/processor.ts:588`（agent 名来自落库的 assistant 消息，
   可能已删/已改名，紧接着就 `.permission`，真撞上是 TypeError；修正十二点过名但一直没修，现在回落
   到默认姿态的规则集）与 `session/compaction.ts:476`（内建机件缺失属于不变量被破坏，明着抛）。
