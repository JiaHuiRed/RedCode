# 子代理与会话姿态收口方案

> 2026-08-28 起草。起因是「来源太多」——同一个角色最多能被四个地方改写，而覆盖顺序只写在代码里、没有任何地方声明。本文件是这项收口的权威底本（模式同 `parallel-systems-plan.md`、`dsh-adoption-plan.md`），每步落地后更新状态表。调研数据出自 08-28 会话，全部实测。

## 结论先行

问题不是「角色太多」，压成一张 5 行的表治不了它。问题是**一张 `Agent.Info` 表里塞了三种互不相干的语义**，而五条装载路径全部往同一个 `cfg.agent` 里 `mergeDeep`。拆开语义，路径自然收敛。

## 现状一：五条装载路径、三层覆盖

| # | 路径 | 全机实际内容 |
| --- | --- | --- |
| 1 | 内建 native（`agent/agent.ts` 硬编码） | 9 个（含 3 个 hidden），`scout` 由 `REDCODE_EXPERIMENTAL_SCOUT` 控制 |
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

### 子代理工种：3 个

带 model + prompt + 工具白名单 + 超时/fallback。

| 工种 | 写 | 吸收 | 模型 |
| --- | --- | --- | --- |
| `explore` | 只读 | + `scout` | `stepfun-step-plan/step-3.7-flash`（现状），`timeout_ms: 180000` |
| `advise` | 只读 | `architect` + `reviewer` | **`deepseek/deepseek-v4-flash-vision-exp`（官方源）** |
| `execute` | 可写 | `general` + `fixer` | `opencode-go/hy3` + `variant: none`（现状 fixer 的配置） |

`advise` 合并的理由：architect 与 reviewer 都是「只读 + 输出判断」，区别只在输入是需求还是 diff——而 `task` 调用本来就带 prompt，靠 prompt 区分即可。选官方源 vision 是因为审查/设计都可能要看截图，而它是官方 provider 下唯一的多模态模型。**注意**：vision-exp 的推理消耗波动极大，`advise` 必须给足输出预算，必要时配 `timeout_ms` + `fallback_model`。

### 内部机件：3 个

`compaction` / `title` / `summary`。纯内建、配置碰不到、不出现在「角色」这个概念里。

对用户可见的就是 **2 + 3 = 5**，分属两张互不覆盖的表。

## scout 并入 explore 的坑

scout 的招牌能力是 `repo_clone` / `repo_overview`（把依赖仓 clone 进托管缓存）。**0.9.8 已经把这两个工具放进 `GATED_TOOLS` 默认不注册**（`tool/registry.ts:71`），所以光在 explore 的权限白名单里放行**不够**——模型的工具表里根本没有它们。

两条路，二选一：

- **（倾向）接受 scout 的依赖缓存能力就此退役**。它默认关、全量历史零调用，`repo_clone`/`repo_overview` 同样零调用——这正是它们进 gated 名单的原因。
- 要留，就得给 explore 的模型显式 `provider.<id>.models.<id>.tools.repo_clone = true`，等于把 0.9.8 那笔前缀瘦身退回去一部分。

## 装载路径收敛后的形态

| | 唯一入口 | 配置能做什么 |
| --- | --- | --- |
| 姿态 | 内建 2 个 | 只能调权限，**不能新增**（姿态是引擎语义，不是用户内容） |
| 工种 | `agent/*.md` | 覆写 model / variant / timeout / permission；`disable` 保留 |
| 机件 | 纯内建 | 碰不到 |

## 2026-08-28 调研修正（五路并行 + 反驳式复核）

上面「目标形态」不变，但第 4 步的**做法**被调研推翻了三处。以下每条都带 file:line，是复核后净下来的判断。

### 修正一：底本自相矛盾，已定死为「姿态不写 md」

本文件上面写了姿态「结构里不带 model / prompt / timeoutMs 字段」、「唯一入口是内建 2 个」，第 4 步却写「**五个**角色写成 md」——五个必然含 redmind 与 plan。**定死：只有三个工种写 md，姿态保持内建。** 理由是 `Info.prompt` 的语义（见修正二）——姿态一旦有 md 正文，就会顶掉模型家族提示词。

`PROMPT_PLAN` 也不能折进 `seed/agent/plan.md`：它走的是合成 user 消息 part（`session/reminders.ts:26-35`），与 `Info.prompt` 是两条通道。

### 修正二：prompt 搬进 md，不能做成「运行时读盘」

`with { type: "text" }` 是**构建期内联**，而 `seed/` 既不进构建也不进发布包（`script/sync-home.bat` 是它唯一出口）。改成运行时从磁盘读 md，等于把内建角色的提示词从二进制里拿掉——只有跑过 sync-home 的开发机才有。

更糟的是失败形态：`Info.prompt` 的唯一消费点 `session/llm/request.ts:60` 是**替换**模型家族提示词（default.md/deepseek.md…）而非追加，所以 md 缺失不会崩，而是**静默回落**。机件三件套受害最重——`title`（`prompt.ts:379`）与 `compaction`（`compaction.ts:545`）显式传 `system: []`，md 一空就是一份系统提示词都没有。

**做法**：保留静态 text 导入，把导入目标指向 `seed/agent/*.md`，模块顶层用 `gray-matter`（已是运行时依赖）剥 frontmatter 取正文。现成先例是 `project/bootstrap.ts:20-22` + `:56-68`（内联 text 导入 + 首次启动不存在才落盘），不是 `build.ts:63-66`（那是生成的虚拟入口里的 `type: "file"`）。注意 `ConfigMarkdown.parse` 用不上——它是路径读盘器（`config/markdown.ts:70-71`），内联字符串得直接 `matter(text)`。

### 修正三：别名只能落在 `Agent.get`，且它够不到六处硬编码

md 路线表达不了别名——`config/agent.ts:143` 是 `result[config.name] = ...`，**key 强制等于 name**，写 `name: advise` 只会造出第二个 advise。配置层加 `alias` 字段要动 schema + 重跑 OpenAPI/SDK，为一轮过渡不值。

落点是 `agent/agent.ts:378-380` 的 `get`——全部 14 个服务端解析点都经它，别名不进 `agents` 记录就自动缺席 `list()`、@ 补全、姿态切换列表**和 `describeTask`**（最后这项是 `hidden` 做不到的：`tool/registry.ts:356` 只按 `mode !== "primary"` 过滤，压根不看 hidden）。

**但别名表够不到这六处，必须逐个改**：

| # | 位置 | 不改的后果 | 必要性 |
| --- | --- | --- | --- |
| 1 | `cli/cmd/tui/routes/session/index.tsx:319` `local.agent.set("build")` | 客户端字面量，`local.tsx:85` 先校验 name 在 list 里，不中弹 toast → **plan_exit 后 TUI 卡在 plan 姿态出不来** | 必须 |
| 2 | `session/reminders.ts:37` `input.agent.name === "build"` | BUILD_SWITCH 提醒**静默失效**（不抛错、不降级，最难发现） | 必须 |
| 3 | `agent/agent.ts:397` `agents[c.default_agent]` | `default_agent: "build"` 的配置升级后直接抛错；顺带 `:388` 排序谓词按 name 比、`:397` 按 key 查，两边口径本来就不一致 | 必须 |
| 4 | `tool/plan.ts:57` `agent: "build"` 写进**新造的** MessageV2.User | 写入侧不改，别名表**永远删不掉**——「一轮过渡」的承诺落空 | 应该 |
| 5 | `session/goal-continuation.ts:64/96` `?? "build"` | 唯一**无条件**跑到的兜底（plan 那条挂在 `experimentalPlanMode` 上默认不注册） | 应该 |
| 6 | `config/config.ts:222-227` 具名 key `build`/`general`/`scout` | 经 `handlers/config.ts:14-16` 出仓、生成进 `sdk/openapi.json:14546/14549/14555`。**这张表已漏了 redmind**，本来就该修 | 应该 |

**硬约束**：`session/prompt.ts:1195-1197` 在续跑时对最后一条 user 消息的 agent 名做 `get` + 抛 `agentNotFound`。所以 `build`/`general` **必须留别名、不能物理删**——任何历史会话续跑就炸，不是降级。

**CHANGELOG 别写错**：老 `@architect` 手打**不再可用**——交互式 @ 提及的 part 由客户端从 `list()` 造（`autocomplete.tsx:517`、`app/prompt-input.tsx:664`），别名进不去。仍可用的老入口只有：`subagent_type`、历史会话续跑、`--agent`（非 `--attach` 路径）、`default_agent`。

### 修正四：权限不能取并集

`Permission.merge` 就是数组 concat（`core/permission.ts:33-35`），`evaluate` 是 **findLast**（同文件 21-31）。所以把 architect 块和 reviewer 块首尾相接，**后一个块开头的 `"*": deny` 会把前一个块的所有 allow 全部作废**。三个工种必须各**手写一份扁平白名单**，第一个键是 `"*": deny`。

两处真冲突要拍板：`advise` 的 `bash`（reviewer 有、architect 无）；`execute` 更大——general 是 `"*": allow`（继承 defaults）、fixer 是 `"*": deny` + 白名单，**根本不是同一档，写法上必须二选一**。

### 修正五：sync-home 先不动

live 的 `~/.redcode/agent/` 是**私仓工作树**，三份都在版本控制里（`git ls-files agent/`），而且历史上有 4 次在 live 侧的直接编辑。所以「手动对齐一次 live」的正解是私仓 `git rm` 一次，一步到位、零新增机械。

记账法（`.seeded-agents` 清单 + `.trash`）是为「以后还会再删角色」和「多机」买的保险，单维护者 ROI 低，**拆成独立提案**。同类先例：`CHANGELOG.md:843` 的 FreeLLMAPI 反复重现（`merge-home-config` 同样只增不删），当时的修法也是「模板与 live 两处同时删」，不是做记账。

顺带：`sync-home.bat:29` 的注释已陈旧（还写 `{agent,agents}`），改这块时一并修。

### 修正六：scout 与它的 flag 要分开

`scout` 挂在 `flags.experimentalScout` 下（`agent.ts:248`），**默认关**，所以合并它的成本比读起来低。但 `experimentalScout` 这个 flag 还门控着 @reference 的 git 物化（`reference.ts:128/208/218/224`）与 `repo_clone`/`repo_overview` 的注册（`registry.ts:313`）——**别把 flag 跟 agent 一起删**，要清单独立项并先改名。

### 测试面比原估计大一个量级

`"build"` 在 `packages/opencode/test/` 下是 **42 个文件 / 162 行**，不是三个。确定会红的：`test/tool/task.test.ts:222`（不是 :221——:221 只比 explore 与 alpha，:223 因 `general=-1` 反而假绿通过）、`test/session/prompt.test.ts:1910` 的 `toEqual(["build"])`、`test/config/agent-color.test.ts:35` 的 `get("build")`。而 architect/reviewer/fixer **零调用零断言**，改名几乎免费。


## 迁移步骤

| 步 | 内容 | 风险 | 状态 |
| --- | --- | --- | --- |
| 1 | 删 `ConfigAgent.loadMode` 与 `config.ts:714` 的调用 | **零**——全机零文件 | **已做 2026-08-28** |
| 2 | 删随包 YAML profile 三份 + `agent/profile/{load,resolve,types,index}.ts`；`explore`/`general` 的 description/prompt 收回内建 | **零**——`agent.yaml` 已被 disable，另两份与内建重复，用户目录空 | **已做 2026-08-28**（连带清掉 seed 里那条已失效的 `agent.disable`；live 配置同步见私仓） |
| 3 | `{agent,agents}` 收成只认 `agent/`（顺带清掉审计记的「seed 单复数双套」） | 低 | **已做 2026-08-28**（复数目录存在时打 warning，不静默丢定义） |
| 4 | **三个工种**写成 `seed/agent/*.md`（姿态不写 md，见下节修正）+ 别名表 + 六处硬编码。live 对齐用私仓 `git rm`，不动 sync-home | 中 | 未做 |
| 5 | `Info` 拆成姿态/工种两个类型；内建裁到机件 + 一个最小 fallback | 中 | 未做 |
| 6 | `agent.*` 去掉「创建」分支，只留覆写 + disable | 低 | 未做 |

每步独立可回退。1、2 当天可落可验。

## 明确不做的

- **不动 `task` 工具的调用面**（`subagent_type` 仍是字符串，老的 `architect`/`reviewer`/`fixer` 名字在第 4 步之前照常可用）
- **不改 `Permission.merge` 的语义**——本方案只动「谁来定义角色」，不动「权限怎么叠」
