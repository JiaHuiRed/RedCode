# Codex 压缩设计对照：RedCode 原生 compaction 的结构性不足与可借鉴点

状态:proposed

## 问题

用户要求对照 `E:\AI\codex`（HEAD `a9b0815167`，2026-10-11；Rust 全量源码）的 compaction 设计，找出 RedCode 0.12.7 引入原生 compaction 后的不足，以及更适合本仓的地方。

本篇承接两篇既有笔记，回答的是它们没回答的那一层：

- `implemented/feature/2026-10-10-native-compaction.md` —— **当时为什么这么设计**（账本/投影/提交/预算边界的整合决策，含对 Codex 机制的初版调研结论）。
- `proposed/bug-fix/2026-10-12-native-compaction-under-reduction.md` —— **实际代价有多大**（用 `~/.redcode/data/redcode.db` 实测：GPT 归约率中位 39.8% → 20.5%，单会话 10 次压缩烧 1,571,823 token 全价）。
- **本篇** —— **结构性差异在哪**：同样"压不动"，codex 的机制为什么不会退化成压缩风暴，以及哪些设计能直接借。

一句话结论：**RedCode 每次压缩是在历史里再套一层，Codex 每次压缩是把历史压回一个常数。** 前者的压后体积随压缩次数线性增长，后者的上界与压缩次数无关——这正是"压不动"的设计层来源。

## 决策

本次只做对照，不改代码、不改配置。以下为两边实现的逐维度事实对照（全部带行号）。

### 一、根本差异：有界重建 vs 累积套娃

**Codex = 有界重建（bounded rebuild）。** `core/src/compact.rs:386` 从**空向量**开始构建新历史：

```rust
let mut new_history = build_compacted_history(Vec::new(), &user_messages, &summary_text);
```

`build_compacted_history_with_limit`（`compact.rs:690-770`）只往里放三样东西：

1. **用户消息**：从末尾倒序累加，上限 `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`（`compact.rs:63`）；超限的那条用 `truncate_text` 截断并 `mark_retained_sources_incomplete()` 标注（`:715-737`）
2. **摘要**：`history.push(CompactionSummary)`（`:765-767`），永远在最后
3. **窗口前缀 + 初始上下文**：由 `insert_initial_context_before_last_real_user_or_summary`（`:615-675`）插到"最后一条真实用户消息之前"，保证摘要仍在末位

最终形状 = `[窗口前缀 + 初始上下文] + [≤20k token 的最近用户消息] + [摘要]`。**上界是常数**：20k + 摘要（受模型 output limit）+ 固定前缀。三个关键性质：

- **旧摘要被替换而非嵌套**：`compacted_user_message` 用 `is_summary_message`（`:591-593`、`:601-603`）把上一条摘要从候选里**过滤掉**，所以摘要不会层层套娃。
- **该形状可复现**：`session/rollout_reconstruction.rs:536-537` 用同一组函数从持久化 rollout 重建历史——它是规范形状，不是运行时巧合。
- **本地压缩不保留任何工具输出**：`build_compacted_history` 只接收 `user_messages`，工具输出全部靠摘要转述。只有 `Feature::RetainClientToolOutputs` 显式标记的 client-authored 输出才按 `compact_retained_tool_outputs.rs:7-20` 保留，且注释写明「**share the normal history token budget and are retained whole or dropped**」——共享预算、整条保留或整条丢弃。

**RedCode = 累积套娃。** 账本 `context_compaction_block` 是链式的。`context-compaction.ts:150-200` 的 `commit` 在处理被选段时：

- `sources.push(...old.sourceMessageIDs)`（`:163`）—— 旧块的源消息 ID **全量继承**
- `protectedRecords.push(...old.protectedRecords)`（`:164`）—— 旧块的保护记录 **全量继承**
- `anchorID: selected[0]!.info.id`（`:193`）—— 锚点是**被选段的第一条消息**，而选段起点恒为 `0`（`native-context.ts:80`：`start = latestUser > 0 ? 0 : latestUser + 1`），于是锚点**恒等于会话首条消息**
- `project()`（`:88-110`）把块渲染成锚点消息的**唯一正文**，旧源消息全部 hidden

于是压后体积**随压缩次数线性增长**。实测同一会话（`ses_ffe5ed25a2347ffez61We6cc4mxJ4O`）10 次压缩：

| | #1 | #2 | #3 | #4 | #5 | #6 | #7 | #8 | #9 | #10 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `sourceMessageIDs` | 37 | 56 | 117 | 148 | 294 | 303 | 404 | 412 | 426 | 447 |
| `protectedRecords` | 41 | 43 | 45 | 48 | 75 | 76 | 97 | 99 | 100 | 100 |
| 保护正文（字符） | 25,932 | 26,549 | 26,638 | 26,782 | 45,968 | 45,984 | 82,444 | 82,450 | 82,454 | 82,454 |

**没有常数上界**，只有 `active_max_tokens` 80,000 / `active_max_bytes` 524,288 的粗闸门（`config/native-compaction.ts:68-73`）。

另外，`mode: "model"` 与 `condensedSummaries` 这两条"模型生产者"路径**在生产代码里已无调用方**：`8372782d`（0.12.5）退役 `compress` 工具后，只剩 `mode: "auto"`（`compaction.ts:518`，引擎生产者）与 `mode: "import"`（`context-import.ts:120`，DCP 导入）。`condensedSummaries` 只有类型声明与 `commit` 内部的两处自用（`context-compaction.ts:67/167/202`），`{{block:<id>}}` 嵌套拼接的守卫（`:175-176`）也随之不可达——**有测试覆盖但没有生产入口**。这是本仓红线「永远不要静默跳过一个解析不到的引用」的同形问题，单独记在后果里。

### 二、逐维度对照

| 维度 | Codex（`a9b0815167`） | RedCode 0.12.7 | 差距 |
|---|---|---|---|
| **压后历史形状** | 有界重建，常数上界（≤20k 用户消息 + 摘要 + 前缀），`compact.rs:386/690-770` | 累积块链，`sourceMessageIDs`/`protectedRecords` 线性增长，`context-compaction.ts:163-164/193` | **致命** |
| **锚点/窗口推进** | `advance_auto_compact_window()`：`window_number+1`、新 `window_id`（UUIDv7）、`previous_window_id` 链接，`state/auto_compact_window.rs:77-85` | `anchorID` 冻结在会话首条消息，从不前移 | **致命** |
| **摘要关系** | 替换——旧摘要被 `is_summary_message` 过滤，`compact.rs:591-593` | auto 路径模型看到的是旧块渲染全文（含旧摘要+旧保护正文），重写出的新摘要叠在旧摘要之上；保护记录另加机械继承 | 大 |
| **保留内容预算** | 整条保留或整条丢弃，**共享同一 token 预算**；`RETAINED_MESSAGE_TOKEN_BUDGET=64_000`、`MAX_RETAINED_AGENT_MESSAGE_TOKENS=10_000`、用户消息 20k，`compact_remote_v2.rs:78-79/548-597` | `protectedRecords` 独立预算、机械继承、**不参与 `required` 计算**（同一份内容既进 `total` 又不进 `released`，`native-context.ts:86-88/102`） | **大（压不动的直接来源）** |
| **工具输出** | 本地压缩**全部丢弃**，只靠摘要转述；仅 client-authored 按 feature 保留 | 受保护工具输出**逐字保留**（`protect()`，`context-compaction.ts:355-363`），默认 `[task, task_status, skill, todowrite, todoread]` | RedCode 更保真，也正是累积源 |
| **触发口径** | 双 scope `{Total, BodyAfterPrefix}`；`BodyAfterPrefix` 用 `active − window.prefill_input_tokens`，**压缩后从 0 重新起算**，`session/context_window.rs:62-81`；`fallback_buffer_tokens` 让压缩**提前**触发 | 单一全量 ctx ≥ `trigger_tokens`；**无 scope、无 prefill baseline** | 中 |
| **阈值来源** | 每模型元数据 `model_info.auto_compact_token_limit()`，可被 config 覆盖（`config/mod.rs:653`） | 全局常量 250k，按模型 `usable` 比例夹取（`config/native-compaction.ts:19-21/176-185`） | 中 |
| **时机/阶段** | 四相 `{PreTurn, MidTurn, PostTurn, StandaloneTurn}` + `Trigger{Auto,Manual}` + `Reason{UserRequested,ContextLimit,ModelDownshift,CompHashChanged}` | 阈值/溢出触发 + 手动；无相、无 reason | 中 |
| **实现档位** | 三档并存：Remote V2（服务端摘要）/ Local Responses（模型文本摘要）/ TokenBudget（**跳过摘要，直接重置窗口**，`compact_token_budget.rs:58`）；+ `compact_model_fallback` 换模型重试 | 一档（引擎摘要 + 账本）+ legacy prune 廉价档（`PRUNE_PROTECT=40_000`，`compaction.ts:37-40`） | 中 |
| **遥测** | `CodexCompactionEvent` 全字段：`active_context_tokens_before/after`、`retained_image_count`、`compaction_summary_tokens`、`cached_input_tokens`、`cache_write_input_tokens`、`duration_ms`、`status`、`phase`、`trigger`、`reason`；**失败也 track**（`compact.rs:472-519`） | compaction part 上只有 `tokens_before/after/duration_ms`（`compaction.ts:537-548`） | 大 |
| **预算超限行为** | 截断/丢弃（`truncate_retained_messages`、`truncate_text`）——压缩总能完成 | **抛错**（`checkActive`，`context-compaction.ts:376-381`）→ 整次压缩失败、历史完全不缩 | 中（悬崖） |
| **溢出兜底** | 压缩中遇 `ContextWindowExceeded` → `history.remove_first_item()`（**从头删**，保 prefix 缓存 + 保近期消息），retries 归零重试（`compact.rs:338-350`） | `selectAutomatic` 静默 best-effort（`native-context.ts:112-113`；本次工作区已加 `log.warn` 降级告警）；`context-compaction.ts:199` 只要求"有一点点正收益" | 大 |
| **用户可见降级** | 压缩后发 `WarningEvent`：「Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible…」（`compact.rs:421-424`） | 只有预警档位（黄/橙/红），无"压缩质量下降"提示 | 小 |
| **Hook** | `PreCompact`（可 `should_stop` **阻止**压缩）+ `PostCompact`，`hooks/src/events/compact.rs:254-341` | 只有 `compact.post`，且 `Effect.catch(() => Effect.void)` 吞错（`compaction.ts:561`） | 小 |
| **摘要提示词** | 435 字节极简 handoff（`prompts/templates/compact/prompt.md`） | 6 条，含 provenance/trust、observation vs hypothesis、意图 vs 已完成、"保护内容由引擎追加不要重复"（`native-context.ts:41-50`） | **RedCode 更优** |

### 三、RedCode 的不足（按严重度排序）

1. **压后体积无上界。** 上表第 1、2 行。`anchorID` 不前移 + `sources`/`protectedRecords` 机械继承，使每次压缩的输入都比上次更大，`required` 因此越来越够不到。**这是"压不动"的第一因**，也是 codex 用"有界重建"整体规避掉的那一类问题。
2. **保护记录既不收敛也不参与回收账。** 上表第 4 行。`retainedTokens`（`context-compaction.ts:346-349`）对锚点消息直接返回**整块**的 `protectedRecords` 估算值，于是同一份正文既计入 `total`（`native-context.ts:86`）又不计入 `released`（`:102` 减掉 `retained`）。codex 的对策是让保留量与摘要**共享同一个预算**（共享 total，谁多了谁被截），而不是各记一套账。
3. **没有 scope / prefill baseline。** codex 的 `BodyAfterPrefix` 把触发量算成"压缩窗口之后的新增部分"，压缩完自动归零重新起算；RedCode 用的是全量 ctx，压后的残余立刻又被算进下一轮触发量，与第 1 条叠加成风暴。
4. **可观测性缺失。** codex 每次压缩（含失败）都有完整事件；RedCode 只有 part 上两个 token 数与耗时，且没有失败记录路径。「压了等于没压」能伪装成成功两天，直接原因是这个。
5. **预算超限是硬失败而非降级。** `checkActive` 抛错 → 压缩整次失败 → 历史完全不缩 → 下一轮再触发。codex 选择截断/丢弃，压缩总能完成。当前实测保护正文 ≈82,454 字符（≈28k token）距 80k 闸门尚有余量，但这是个**悬崖**，不是渐变。
6. **没有 pre-compact 阻断点。** codex 允许 hook 阻止压缩；RedCode 只有 post 且吞错。
7. **溢出兜底不如 codex 的 `remove_first_item` 可控。** codex 从头删、保住 prefix 缓存与近期消息，是有明确意图的降级；RedCode 的静默 best-effort 只是"能拿多少拿多少"。

### 四、RedCode 优于 Codex、必须保住的部分

1. **摘要提示词更严谨。** `native-context.ts:41-50` 显式要求区分 observation/hypothesis、区分意图/已完成动作、声明历史指令是证据不是新授权、并告知模型"保护内容由引擎追加，不要重复"。codex 的 435 字节 prompt 不含这些约束。
2. **账本可审计、可回滚。** `deactivate`/`invalidate`/`clone`（`context-compaction.ts:222-273`）支持"恢复某次压缩"与会话 fork 时整块克隆。codex 是替换式历史，压完就不可回退。（注意：同段的 `condensedSummaries` 已死，见后果节「死路径清查」，不要把它算进这项优势。）
3. **被压内容可读回。** `read(sessionID, "block:<id>")` 与 `search`（`:275-317`）能从账本取回原始正文。codex 丢弃后不可读。
4. **陈旧提交防护。** `sourceHashes` + `fingerprint()`（`:183`、`:383-388`）与 `Compression block view is stale`（`:161`）保证提交时源内容未被第三方改动。codex 无此校验。
5. **range 级细粒度预算。** `maxRanges`/`maxBlocks`/`maxMessages`/`summaryMaxBytes`/`activeMaxBytes` 等一整套（`config/native-compaction.ts:62-95`），codex 只有少量常量。
6. **工具输出逐字保留。** 长任务里 `task` 输出是主要证据面（本仓 `task`/`skill`/`todowrite` 默认受保护），codex 本地压缩全丢、只靠摘要转述。这是 10-10 刻意的设计选择，**不要为了对齐 codex 而放弃**。
7. **`assertExclusive` 显式互斥**（`native-context.ts:32-39`）：native 与 DCP 不能同管一个会话，配错在加载时就响。

### 五、可借鉴项（按性价比，与 10-12 回归笔记的拟修对齐）

| # | 借鉴项 | codex 出处 | 对应本仓拟修 |
|---|---|---|---|
| 1 | **有界重建**：压后只留"最近 N 条用户消息（≤X token）+ 一份新摘要"，丢弃全部旧块 | `compact.rs:386/690-770` | 拟修 B 的**更彻底版** |
| 2 | **保留量共享预算 + 整条保留或丢弃**：`protectedRecords` 纳入 `required` 计算，并给它独立且可截断的预算 | `compact_retained_tool_outputs.rs:1-2`、`compact_remote_v2.rs:78-79` | 拟修 C |
| 3 | **prefill baseline（`BodyAfterPrefix`）**：压缩后把 baseline 设为压后 ctx，下一轮从 0 起算 | `session/context_window.rs:62-81`、`state/auto_compact_window.rs:108-130` | 新增（10-12 笔记未覆盖） |
| 4 | **压缩事件遥测**：把 `released`/`required`/`status`/失败原因/`cached_input_tokens` 落到结构化事件，失败也记 | `compact.rs:472-519` | 拟修 A 的**完整版** |
| 5 | **预算超限改降级**：`checkActive` 从抛错改为截断/丢弃 | `truncate_retained_messages`、`truncate_text` | 新增 |
| 6 | **溢出兜底学 `remove_first_item`**：从头删以保住 prefix 缓存 | `compact.rs:338-350` | 新增 |
| 7 | **`PreCompact` hook**：让插件能在压缩前阻止（RedCode 已有 `compact.post`，补 `compact.pre` 成本低） | `hooks/src/events/compact.rs:254-341` | 新增 |
| 8 | **压缩后用户可见提示**：直接借鉴 codex 的 `WarningEvent` 文案 | `compact.rs:421-424` | 新增 |
| 9 | **`window_number` 单调计数器**：即使不做有界重建，也给每个块一个单调窗口号，让"压了几次"可被一次查询看出 | `state/auto_compact_window.rs:77-85` | 识别签名的落地形式 |

**注意 #1 与 #6 的性质不同**：#1 是**改变压后形状**（影响模型看到的历史），#6 只是**溢出时的兜底**。#1 需要先有 #4（可观测）才能验证效果，否则改完仍然看不见差别。

## 备选与否决理由

- **直接采用 Codex V2 远程压缩（服务端 opaque 摘要）**：否决——`implemented/feature/2026-10-10-native-compaction.md` 已否决（不可审计、不可移植、依赖特定 provider 能力），本次对照不改这个结论。codex 自己也把它作为**可选档**（`RemoteCompactionSupport::{V2, Unsupported}`，`tasks/compact.rs:63-96`），本地档始终存在。
- **全盘照搬 codex 丢弃工具输出**：否决——codex 能丢，是因为它的 harness 不把逐字工具输出当主要证据面，且它有三档实现兜底。RedCode 的长任务里 `task` 输出是主要证据来源，丢了会显著降质。正确做法是**保留逐字保留的语义，但给它收敛出口**（借鉴项 #2），而不是取消保护。
- **改用 codex 的每模型阈值元数据**：暂缓——RedCode 的 `resolve()` 已按 `usable` 窗口比例夹取（`config/native-compaction.ts:176-185`），形状上够用；引入每模型元数据是另一条数据链（需要模型信息维护），收益不足以先动。
- **为对齐 codex 而砍掉账本的可回滚能力**：否决——可审计/可回滚是本仓相对 codex 的**优势项**（第四节第 2、3 条）。有界重建应该实现为"账本保留全部块、但 `project()` 只物化最近一个窗口"，而不是删掉账本。
- **把 trigger 调低来省 token**：否决——见 10-12 笔记拟修 D，压不动 + 低触发线 = 风暴。

## 后果

- **识别签名**（本篇新增，补充 10-12 笔记的签名集）：① 压后 ctx 随压缩次数单调上升；② 各块 `anchorID` 恒定；③ 无 `window_number` 类单调计数器可用于回答"这个会话压了几次"。三条命中任一即说明压后形状仍是无界的。
- **基线钉住**：codex 侧结论对应 HEAD `a9b0815167`（2026-10-11）。上游常量（`20_000`/`64_000`/`10_000`）与默认值可能随版本变化，引用时**带行号**，不要只写数字。
- **样本限制**：codex 侧是**静态代码分析**，未运行其测试套件；RedCode 侧数据来自 `~/.redcode/data/redcode.db` 实测（口径见 10-12 笔记的"数据质量规则"节）。本对照不做性能对比。
- **死路径清查（2026-10-12 16:07 按当前工作区核实，判据=全仓 ripgrep 排除 node_modules + 逐调用方可达性推理）**：`Ledger.commit` 的生产调用方**恰好两个**——`compaction.ts:517-518`（`mode: "auto"`）与 `context-import.ts:116-120`（`mode: "import"`）。但后者所在的**整个 `context-import.ts` 模块没有生产调用方**：`importDcp` 只被 `test/session/context-import.test.ts` 调用，`ContextImport` 命名空间导出（`context-import.ts:127`）全仓无人 import，CLI/server/desktop/app 内搜 `dcp` 零命中。**所以生产实际只走 `mode: "auto"` 一条路。** 由此：

  | 项 | 位置 | 判定 | 依据 |
  |---|---|---|---|
  | `mode: "model"` | 类型成员 `context-compaction.ts:51` | **死** | 无生产调用方；仅 `test/session/context-compaction.test.ts:49/67/94` 使用，而那三处 fixture 无嵌套块，`mode` 不影响其行为 |
  | `mode: "import"` | `context-import.ts:120` | **测试专用** | 调用方模块自身不可达 |
  | `condensedSummaries` | 声明 `:68`、消费 `:173-179`、校验 `:208` | **死** | 全仓含测试**零调用方**，消费分支与校验均不可达 |
  | `usedOverrides` | 声明 `:136`、写入 `:176`、读取 `:208` | **死** | 只被死分支写入，只被死校验读取 |
  | `Missing nested block marker` 抛出 | `:181-182` | **不可达** | 需「被选消息是既有活跃块的锚点」且 `mode !== "auto"`，生产只传 auto |
  | `Unknown nested block marker` 抛出 | `:194` | **活守卫，未触发** | auto 路径可达（模型吐出 `{{block:…}}` 才触发；渲染给模型看的是单花括号 `[block:<id>; sources: …]`） |
  | `summary.replaceAll(marker, old.summary)` | `:184` 附近 | **活，未触发** | 同上一行，依赖模型吐出双花括号 |

  另一条判据：`mode` 在 `commit` 里**只被读一次**（`:181`），`Block.mode` 存库后 `src/` 内无任何消费者（除赋值外零读取）。
  **更正**：本篇初稿写「`{{block:<id>}}` 守卫不可达」是过度概括——`Missing` 抛出确实不可达，但 `Unknown` 抛出与 auto 路径的 `replaceAll` 在原理上可达，属"活守卫、实际不触发"。按本仓红线「误配置要响」「永远不要静默跳过一个解析不到的引用」，死的那几项要么补回入口要么显式删除——**不要留着"有测试的活代码"的错觉**。处理方式另行决策，本篇只登记。
- **与本仓既有 note 的关系**：本篇是设计层对照（静态），10-12 笔记是数据层诊断（实测），10-10 笔记是落地决策（why）。三篇构成"为什么这么设计 → 实际代价多大 → 结构性差异在哪"的完整链。三篇互不回链为权威：**实现变化时以代码为准，结论以 10-12 笔记的实测数据为准**。
- **工作区状态（2026-10-12 16:07 核实，注意工作区在被并行会话实时编辑）**：
  - 拟修 A 已于 `4d1234c1`（2026-10-12 15:59，[YuQi]「原生压缩触发改实报锚点、选段降级可见」）**提交**，`10-12` 笔记中"尚未实施"的表述已过时。同期 `7ff5acb6` 提交了 GPT `cached_tokens` 取证补盲与 codex 路由指纹。
  - 截至核对时刻的未提交改动是 **本笔记借鉴项 #2 的落地**：`context-compaction.ts` 新增 `carryProtected()`（保护记录按预算携带、整条保留或丢弃、被丢弃的退到账本可经 `block:<id>` 读回），`config/native-compaction.ts` 新增 `retained_max_tokens`（默认 **20_000**，与 codex `COMPACT_USER_MESSAGE_MAX_TOKENS` 同位），`Limits` 加必填 `retainedMaxTokens`，`test/session/context-compaction.test.ts:13` 已跟更。改动注释直接回链本笔记——**本对照已被采用，后续引用请以代码为准**。
  - 该批次核查发现：`test/session/context-import.test.ts:13-17` 的 `Limits` 字面量**未跟更** `retainedMaxTokens`（必填），而该文件在核对时刻未被修改——属该批次的漏改，见 typecheck 结果。
- **回链**：RedCode —— `packages/opencode/src/session/context-compaction.ts:163/164/175/193/199/346-349/376-381`、`session/native-context.ts:80/86-88/102/112-113`、`session/compaction.ts:37-40/484-487/518`、`config/native-compaction.ts:19-21/62-95/176-185`。Codex —— `codex-rs/core/src/compact.rs:63/338-350/386/421-424/472-519/591-593/615-675/690-770`、`core/src/state/auto_compact_window.rs:77-85/108-130`、`core/src/session/context_window.rs:62-81`、`core/src/compact_remote_v2.rs:78-79/548-597`、`core/src/compact_retained_tool_outputs.rs:1-20`、`core/src/compact_token_budget.rs:58`、`core/src/tasks/compact.rs:63-96`、`core/src/session/rollout_reconstruction.rs:536-537`、`prompts/templates/compact/prompt.md`。
