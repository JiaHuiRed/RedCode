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

## 迁移步骤

| 步 | 内容 | 风险 | 状态 |
| --- | --- | --- | --- |
| 1 | 删 `ConfigAgent.loadMode` 与 `config.ts:714` 的调用 | **零**——全机零文件 | 未做 |
| 2 | 删随包 YAML profile 三份 + `agent/profile/{load,resolve,types,index}.ts`；`explore`/`general` 的 description/prompt 收回内建 | **零**——`agent.yaml` 已被 disable，另两份与内建重复，用户目录空 | 未做 |
| 3 | `{agent,agents}` 收成只认 `agent/`（顺带清掉审计记的「seed 单复数双套」） | 低 | 未做 |
| 4 | 五个角色写成 `seed/agent/*.md`。**`sync-home` 对 agent 是「只补缺失、不覆盖」**，本机已有的三份不会被盖——这一步必须手动对齐一次 live | 中 | 未做 |
| 5 | `Info` 拆成姿态/工种两个类型；内建裁到机件 + 一个最小 fallback | 中 | 未做 |
| 6 | `agent.*` 去掉「创建」分支，只留覆写 + disable | 低 | 未做 |

每步独立可回退。1、2 当天可落可验。

## 明确不做的

- **不动 `task` 工具的调用面**（`subagent_type` 仍是字符串，老的 `architect`/`reviewer`/`fixer` 名字在第 4 步之前照常可用）
- **不改 `Permission.merge` 的语义**——本方案只动「谁来定义角色」，不动「权限怎么叠」
