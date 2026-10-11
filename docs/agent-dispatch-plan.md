# 派发机制收口方案（agent-roles-plan 续篇）

> 2026-10-11 起草。权威底本 `docs/agent-roles-plan.md`（08-28）已完成角色收口：9 → 4（redmind/plan 姿态 + explore/execute 工种）+ 3 机件，三构造器互不可污染。但那份底本「明确不做的」里刻意划走了 **task 工具调用面**——四个月缝缝补补后，所有新痛点恰好都聚在这块空白里。本文件收口调用层，与底本互为回链。
>
> 起因是实证三犯：① 只读调查任务误带 `isolation:"worktree"`（白隔离 + 读到旧代码 + worktree 垃圾）；② execute 带隔离派「往主仓写文件」任务，子代理被 `external-directory.ts:40-49` 硬 die 挡死（"refusing to write outside it"，设计如此，三犯）；③ explore 不能续跑，任何追问都是全新上下文重付全量调查成本。机制现状全部实测定位于 2026-10-11，锚点 HEAD `060b1ebd`。

## 结论先行

角色层没有问题——explore/execute 的职责与权限在底本落地后运转良好。问题集中在**派发参数没有守门**：

| 参数 | 现状 | 痛点 |
| --- | --- | --- |
| `isolation` | 模型自由裁量，无任何校验 | 与 subagent_type 的非法组合静默通过，失败形态滞后且难归因（三犯） |
| `task_id`（resume） | explore 一律拒绝（`task.ts:192-201`） | 追问式续查重付全量成本 |
| 回传契约 | 模型侧只有自由文本；`ResultPacketSchema` 六字段是运行时占位自填（`task-runtime.ts:81-94`） | `changedFiles:[]`、`verification:not_run` 是**假数据**，比没有更误导 |
| `background` | 机制可用（flag 默认开），无使用规范 | 派发方（模型）行为不一致：有时阻塞等待有时真后台 |

## 现状证据（实测定位，行号随代码漂移）

- **worktree 语义**：`session/prompt.ts:207-244` 建目录 `~/.redcode/data/worktree/<project.id>/<slug>`、分支 `redcode/<name>`；run 期间 InstanceRef/IsolationBoundaryRef 指向 worktree。**回传不合并**——输出一行 worktree 路径，集成责任在调用方模型（`task.md:6`）；成功任务 7 天保留窗后 reap（`worktree/index.ts:574-587`），失败即删（`prompt.ts:225-240`）。
- **隔离下的主仓写**：`tool/external-directory.ts:40-49` 对 `write:true` 硬 die，且 `:15` 明确不接受 external_directory 授权突破——**这是正确设计**（隔离边界不许被配置穿透），错的是调用方把不相容的任务派进隔离。
- **resume 判据**：`task.ts:192-195` 对 `subagent_type==="explore"` 无条件编译 packet，`:199-201` 见 `task_id` 即 fail。execute/general 系全部可续跑。
- **权限引擎防护**：tree-sitter（bash+powershell）`descendantsOfType("command")` 逐命令节点授权（`tool/shell.ts:248-250,543-572`）；`;` `|` `&&` 拆成独立节点各自 evaluate（`permission/index.ts:187-212`）——**分隔符防护是结构性的**，不是正则黑名单。残余面：单节点内命令替换 `$(...)` 的回复端匹配未逐行核验。
- **回传结构**：`ResultPacketSchema`（`task-runtime.ts:54-71`）只落盘不进上下文；字段全是运行时占位。模型看到的 `<task_result>` 只有 task_id 行 + 自由文本（`task.ts:86-94`）。
- **explore 能力**：白名单含 jcodemunch_* 检索 MCP 但无 bash——git 历史/churn/归因全查不了；`explore.md:70-76` 只有「未索引→建」分支，无「陈旧→增量刷新」指引（260930 实踩：靠调用方 prompt 显式指令才刷新）。

## 设计

### D1 isolation 守门（本方案核心）

原则：**隔离是有代价的（旧代码视图 + 清理责任），无收益时不许开。**

1. **explore + isolation = 参数校验直接拒绝**。只读工种与文件系统隔离正交，不存在合法组合—— explore 读工作树都只读，隔不隔离不影响写安全；唯一「效果」是读到过时代码。落点：`task.ts` 参数校验一处 + `task.md` schema description 声明「explore 不接受 isolation」。报错文案给出原因（防模型重试）。
2. **execute + isolation 保留**，但 schema description 写明唯一适用场景：**并行实验性分支改动**（想在独立分支上试一个改法、失败即弃）。并明示两条边界：隔离内写不了主仓绝对路径（设计行为）；回传不含合并，集成责任在调用方。
3. **调用方守则**（进 explore.md/execute.md 的「何时该被派发」段 + 全局记忆）：主仓内写任务永不含 isolation；只读调查任务永不含 isolation；isolation 只在「我要一个可丢弃的分支」时出现。

### D2 explore 放开续跑，带上限

`task.ts:192-201` 的拒绝改成：explore 允许 `task_id` 续跑，**同一 task_id 最多续 2 次**（轮数计数进 job 元数据）。理由：追问式续查（对报告某条结论要证据、补查一个文件）占比高，每次重付全量调查成本；上限防上下文无限膨胀。超限报错文案引导开新任务。

保留的已知取舍：续跑会话继承首跑的全部上下文，长调查 + 两次追问后上下文可能逼近模型窗口——真发生时是报错而非静默截断，可接受。

### D3 回传契约：删假字段，不造机械校验

- `ResultPacketSchema` 的运行时占位字段（`changedFiles`/`verification`/`toolCalls` 中采集不到的）**从 schema 删除**——落盘假数据会误导后续审计（宁可没有）。
- 「未核验项必须单列」维持提示词约束（explore.md 红线段已有），**不做**「结论必须引用证据 ID」之类机械校验——无法判定语义依赖，校验只会制造假绿。
- 主线程复核纪律（#144：子代理审计结论逐条复核、性能建议先 benchmark）写进本文件「调用方守则」，不进引擎。

### D4 explore 补两件能力（低风险高频）

1. **git 只读白名单**：explore.md 权限块追加
   ```yaml
   bash:
     "*": deny
     "git log *": allow
     "git show *": allow
     "git diff *": allow
     "git blame *": allow
     "git rev-parse *": allow
     "git ls-files *": allow
     "git branch *": allow
   ```
   分隔符防护是结构性的（见现状证据），git 只读子命令无破坏面。残余的 `$(...)` 命令替换面：`git log -S $(cat x)` 这类——tree-sitter 的 command 节点内是否含 command_substitution 待实施时验证（B1 批次验收项），含则该 pattern 落 ask 不落 allow。
2. **索引刷新指引**：explore.md 工作流段补一条「resolve_repo 返回 indexed_at 明显早于会话日期、或检索结果缺近期改动时，先 `jcodemunch_index_folder`（incremental）再查」。

### D5 后台派发使用规范（纯文档，不改代码）

今天实测验证的工作流写进调用方守则：`background:true` 默认派发 → 主线程继续独立工作 → 仅硬依赖结果时 `task_status(wait:true)` join；完成时引擎自动注入 + 空闲自动续跑，无需轮询。这不进引擎——它是「我」的纪律。

## 调用方守则（主线程纪律，不进引擎）

- **isolation 三不**：只读调查不带 isolation（白隔离 + 旧代码视图 + worktree 垃圾）；主仓内写任务不带 isolation（external-directory 硬 die，三犯）；只给「可丢弃的实验分支」开。
- **后台优先**：`background:true` 默认，继续独立工作；join 仅在下一步硬依赖结果时（`task_status(wait:true)`）。阻塞式等待 = 白白放弃并发（260917 实测反思）。
- **报告复核**：子代理审计结论逐条复核后才采信（全局记忆 #144）；性能建议先 benchmark 再照抄；「已补齐了」这类收尾结论要数一遍函数复核（本仓 replacer 家族漏补前科）。
- **委派 prompt 带锚点**：跨仓委派开头写「默认 CWD 不是目标仓，动手前 git -C <路径> rev-parse --show-toplevel 自证」+ 预置 HEAD 对账锚点；收到结论先对锚点，对不上整份作废（两犯教训）。
- **子代理报告的 uncertainties 是必读段**：里面有未核验项就别把它的结论当事实转述给用户。

## 实施批次

| 批 | 内容 | 风险 | 状态 |
| --- | --- | --- | --- |
| B1 | explore.md：索引刷新指引 + git 只读白名单 + 三处「没有 bash」旧说明同步；execute.md：worktree 隔离场景说明；task.ts guard 同步摘 bash（260929 假门票教训：guard 与白名单必须同批摘/加）；agent.test.ts 正测 14 断言 | 低（提示词 + 权限白名单，各自独立可回退） | **已做 2026-10-11**（未 commit） |
| B2 | task.ts：explore+isolation 拒绝、explore resume 放开 + 2 次上限；task-runtime.ts：删占位假字段；task.md schema description 同步 | 中（动 task 工具，需要定向测试） | 待批 |
| B3 | 本文件与底本互回链；全局记忆沉淀调用方守则 | 零 | 随 B1/B2 |

`$(...)` 验证项已有答案，无需新测试：shell.test.ts:491-501（bash）与 :547-557（PowerShell）已断言命令替换内层是**独立授权节点**（`cat "file"` / `Get-Content …` 单独成 pattern）——explore 白名单下 `git log $(cat x)` 的内层 `cat x` 不命中即 deny，结构性安全成立。

模型可见四问（B1/B2 合并答）：① explore 工具表 +bash（六个 pattern），task schema description 变化；② 固定前缀 +bash 白名单 ~60 token，D2/D3 零增量；③ 前缀从工具表起失效一次属预期；④ 占位文本与拒绝文案皆有界。

## 明确不做的

- 不动角色定义层（底本 4 角色收口不动）。
- 不做「isolation 合法性语义分析」（解析 prompt 判断任务该不该隔离）——守门只看参数组合，语义判断留给调用方守则。
- 不做 ResultPacket 机械强制校验（理由见 D3）。
- 不给 explore 开 write/bash 任意命令——分隔符结构性防护不等于单节点内任意命令安全。

## 遗留物

今日调查产生的孤儿 worktree：`sunny-falcon`、`brave-garden`、`witty-sailor`、`eager-garden`（`~/.redcode/data/worktree/d6d579c4…/`，分支 `redcode/*`，全部零未合并改动）。reap 窗口 7 天会自动收；手动清理需用户授权（红线）。
