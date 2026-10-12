# 第三方审计：原生 compaction 能不能完全代替 DCP 的 compress

状态:proposed

## 问题

用户要求以第三方审计视角审 `E:\AI\RedCode-dcp`（DCP 定制仓，HEAD `8fce0f8`），判断 RedCode 0.12.7 的原生 compaction 到底有没有能力**完全代替** DCP 的 `compress`。

审计口径：不站队、不预设结论。逐条读 DCP 的 `compress` 实现，逐条在 RedCode 源码里找对应物，找不到就记缺口，找到了就记等价度与证据行号。**「刻意不做」与「做不到」分开记**——前者是设计取舍，后者才是缺口。

承接关系：
- `implemented/feature/2026-10-10-native-compaction.md` —— 当时为什么这么设计，含 `assertExclusive` 明确二者互斥的决策。
- `proposed/architecture/2026-10-12-codex-compaction-design-comparison.md` —— 与 Codex 的结构性差异。
- **本篇** —— 与**被替代方**的能力面对照，回答「替代是否完整」。

一句话结论：**不能完全代替。** 范式上二者刻意不同（这是设计决定，可接受）；能力面上有 **9 项硬缺口**，其中 `condensedSummaries` 一项直接压在「压不动」的结构性根因上，另有 6 项属于「DCP 有、RedCode 没有」的运维与保护能力。

## 决策

本次只做审计，不改代码、不改配置。以下为逐维度事实对照，全部带行号。

### 〇、先纠正一个易错的前提：两者都是「非破坏投影」

审计中最初的一个直觉是「DCP 非破坏、RedCode 破坏性改写历史」。**读源码后判定：这个直觉是错的**，两边都是发送时投影，落库的原始 message/part 都不改。

| | DCP | RedCode |
|---|---|---|
| 投影位置 | `lib/hooks.ts:110-173` `createChatMessageTransformHandler`，就地改 `output.messages`（出站副本） | `native-context-runtime.ts:19-39` `history()` + `project()`，从 DB 流式过滤 |
| 被折叠消息 | `lib/messages/prune.ts:220-227` `activeBlockIds.length > 0` → `continue` 丢弃 | `context-compaction.ts:94` `hidden` 集合 → `[]` |
| 摘要注入 | `prune.ts:178-206` 在锚点插一条 **synthetic user message** | `context-compaction.ts:96-109` 把锚点消息的 parts **整体换成**一条 synthetic text part |
| 原始消息可读回 | `fetchSessionMessages` 原样取 | `getRaw()` `context-compaction.ts:315-320` 从 `MessageTable` 原样取 |

**差异只在承载物**：DCP 的账本挂 JSON 状态文件（`saveSessionState`），RedCode 挂 DB 表（`context_compaction`）+ 一个 `revision()` 哈希做缓存结算（`native-context-runtime.ts:10-17`）。这一层 RedCode 反而更强（重启/恢复不依赖插件旁路状态）。

⚠️ 有一个真实差异：DCP 注入的是一条**新建的 synthetic user 消息**（`prune.ts:204-206` `createSyntheticUserMessage`，以最近一条真实 user 消息为模板），RedCode 是**保留锚点消息的原角色**、把它的 parts 整体换成一条 synthetic text part（`context-compaction.ts:99-109`）。锚点取 `selected[0]`，即选段第一条消息，实践中通常是会话开头那条 user 消息。

**差异的实质是语义标记方式**：DCP 靠"这就是一条 user 消息"承载摘要，RedCode 靠 `render()` 首行的显式声明 `[Historical context summary. This is not a new user instruction or authorization.]`（`context-compaction.ts:83`）把摘要与真实指令区分开。RedCode 的写法对注入攻击更稳（摘要不会被当成新授权），**属于实现细节差异，不构成缺口**。

### 一、能力面对照总表

DCP `compress` 的能力按「谁决定 / 保什么 / 拦什么 / 怎么触发 / 怎么恢复 / 运维」六组拆开，逐条判定：

| # | DCP 能力 | 证据 | RedCode 对应 | 判定 |
|---|---|---|---|---|
| A1 | 模型自选压缩范围 | `range.ts:88-101` | `planAutomatic` 引擎自选（`native-context.ts:60-114`） | **刻意不同** |
| A2 | 模型自写摘要（主模型同轮） | `range.ts:62` summary 字段 | 独立 compaction agent 独立请求（`compaction.ts:502-512`） | **部分等价** |
| A3 | `message` 模式（逐条批量） | `message.ts:46-197` | 只有 `Range(startId,endId)`，startId==endId 可退化 | **部分等价** |
| A4 | 一次多范围不重叠 | `range.ts:51-71` | `ranges: Range[]`，`maxRanges=8` | ✅ 等价 |
| A5 | 嵌套折叠（范围含旧块） | `state.ts:78-89` `consumedBlockIds` | `consumedBlockIDs`（`context-compaction.ts:190`） | ✅ 等价 |
| A6 | `condensedSummaries`：折叠旧块时**重写为更短摘要** | `range.ts:63-65, 116-121`；`range-utils.ts resolveCondensedSummaries` | **无**。auto 分支只 `replaceAll(marker, old.summary)` 原样继承（`context-compaction.ts:176-177`） | ❌ **硬缺口** |
| B1 | 用户消息逐字保护 | `protected-content.ts:16-54` | `protect()` `context-compaction.ts:351-359` + `protectUserMessages` | ✅ 等价 |
| B2 | `protectTags`：`<protect>…</protect>` 逐字提取 | `protected-content.ts:56-108` | **无**（全仓无 `protectTags`） | ❌ **硬缺口** |
| B3 | `protectedTools` 白名单逐字 | `protected-content.ts:110-208` | `protectedTools`（`native-compaction.ts:104-107`） | ✅ 等价 |
| B4 | `protectedFilePatterns`：按工具参数里的文件路径保护 | `protected-content.ts:136-141`；`protected-patterns.ts` | **无**（全仓无 `protectedFilePatterns`） | ❌ **硬缺口** |
| B5 | subagent 结果合并进保护输出 | `protected-content.ts:154-192` | **无** | ❌ 缺口 |
| B6 | `workingState` 机械快照（filesTouched/failedCalls/userPrompts） | `working-state.ts:52-130`，1024 字符硬上限 | **无**。`carryProtected`（`context-compaction.ts:364-376`）是「继承旧块保护记录」，不是「从本轮 selection 机械提取」——语义不同 | ❌ **硬缺口** |
| C1 | 净增拦截（摘要 ≥ 被替换内容 → 拒绝） | `viability.ts:104-107, 116-118` | `if (Token.estimate(render(block)) >= before) throw`（`context-compaction.ts:197`） | ✅ 等价 |
| C2 | 最小选择下限 `MIN_SELECTION_TOKENS=1000` | `viability.ts:23, 112-114` | **无** | ❌ 缺口 |
| C3 | 恢复档预算校验，不够就**拒绝并回话让模型改选** | `viability.ts:129-180`；`range.ts:256-260` | `planAutomatic` 算 required/released 并 `log.warn("native compaction shortfall")`（`compaction.ts:484-487`），但**降级仍 best-effort 提交** | **刻意不同** |
| C4 | 双口径核算（新消息 vs 被折叠旧块注入文本） | `viability.ts:46-78` | `retainedTokens` 扣除单一口径（`context-compaction.ts:342-345`），全局 `activeMaxTokens` 兜底 | **部分等价** |
| C5 | 拒绝理由回给模型 | `formatViabilityRejection` `viability.ts:187-204` | 无（因为不拒绝） | **刻意不同** |
| D1 | 逐模型两档触发线表 | `inject/utils.ts:123-124`；`config.ts:22-23` | 单组 `triggerTokens`/`reminderTokens` 按模型窗口比例缩放（`native-compaction.ts:183-192`） | **部分等价** |
| D2 | `recovering` 恢复态（压到 min 才松手） | `state/types.ts:105-119` | **无** | ❌ 缺口 |
| D3 | 四类 nudge 注入驱动模型主动压 | `inject/utils.ts:557-614` | 无（模型侧无 compress 工具，不需要） | **刻意不同（自洽）** |
| D4 | 锚定 nudge，只挂最新锚避免刷前缀 | `state/types.ts:116-118` | `annotate()` 只在出站副本加稳定引用（`native-context.ts:10-30`） | ✅ 等价（同目的不同手段） |
| D5 | 缺键告警门禁 | `state/types.ts:140-142` `warnedModelLimitKeys` | 无（不是键表，不适用） | 不适用 |
| E1 | 非破坏投影 | `hooks.ts:110-173` | `native-context-runtime.ts:19-39` | ✅ 等价 |
| E2 | `/dcp decompress <blockId>` 用户级还原 | `commands/decompress.ts`，含父子顺序约束 | 只有 `context_restore` **工具**（`tool/context.ts:51-61`），无用户命令 | **部分等价** |
| E3 | `/dcp recompress` 重压 | `commands/recompress.ts` | **无** | ❌ 缺口 |
| E4 | `dcp_read` / `dcp_search` 有界回读 | `commands/context.ts` 等 | `context_read` / `context_search`（`tool/context.ts:29-49`） | ✅ 等价 |
| E5 | 块账本字段 | `state/types.ts:49-78` | `Block`（`context-compaction.ts:43-59`）缺 `runId`/`durationMs`/`effectiveToolIds`/`directMessageIds` | **部分等价** |
| E6 | economics 台账 + 数字回执 | `compression-economics.ts`；`pipeline.ts:139-162` | 只有 `tokens_before`/`tokens_after`/`duration_ms` 落 compaction part（`compaction.ts:537-548`） | **部分等价** |
| E7 | `/dcp stats` `/dcp context` `/dcp sweep` | `commands/stats.ts` 等 | **无** | ❌ 缺口 |
| F1 | 权限 ask/allow/deny | `compress-permission.ts` | `ctx.ask({permission})`（`tool/context.ts:16-27`） | ✅ 等价 |
| F2 | `manualMode`（只在允许时压） | `hooks.ts:246-276`；`state.manualMode` | 有 `/compact` 触发（server route + acp），语义不同 | **部分等价** |
| F3 | `turnProtection`（最近 N 轮不压） | `config.ts:70`；`lib/config.ts:228-247` | **无**（只有 latestUser 当前请求保护 + queued/pending 切断） | ❌ 缺口 |
| F4 | 工具输出裁剪 strategies | `prune.ts:73-157`；`strategies/{deduplication,purge-errors}.ts` | legacy `prune()`（`compaction.ts:381-427`）**在 native 模式下被显式跳过**（`prompt.ts:2092` `!nativeSpec.enabled`） | ❌ **native 下缺口** |
| F5 | 幻觉剥离 `stripHallucinations` | `hooks.ts:139, 300-307` | `Unknown nested block marker` 抛出（`context-compaction.ts:186`）+ `fingerprint` 陈旧检测 | ✅ 等价（同类目，机制不同） |
| F6 | 子代理开关 | `config.ts:58` `allowSubAgents` | 未对照（不构成本题缺口） | — |
| F7 | TUI 侧边栏 / 通知 | `tui/`、`ui/notification.ts` | compaction part + TUI 徽标 | **部分等价** |

### 二、结论：三档判定

**第一档 — 已完全等价，可以直接替代（11 项）**：A4、A5、B1、B3、C1、D4、E1、E4、F1、F5，加上投影承载物本身。

**第二档 — 部分等价，语义可接受但不同（9 项）**：A2、A3、C4、D1、E2、E5、E6、F2、F7。

两处需要点名：

- **A2（摘要作者）**：DCP 是主模型在同一轮里写摘要（它知道自己下一步要什么），RedCode 是另起一个 `compaction` agent 发独立请求（`compaction.ts:502-512`，system 只有 `summaryPrompt` + `SUMMARY_TEMPLATE`）。**后者省一次主模型往返，但摘要质量取决于那段固定提示词能否还原主模型的意图。** 这是设计取舍，不是 bug，但确实是"替代"的语义损失点。
- **A3（message 模式）**：RedCode 的 `Range` 在结构上能用 `startId == endId` 退化成单条，但 DCP 的 message 模式**明确豁免**了体积下限（`viability.ts:80-84`「message 模式一个 plan 就是一条消息，几百 token 是它的既定粒度」），而 RedCode 的净增拦截（`context-compaction.ts:197`）对单条小消息几乎必然触发。**所以退化路径存在、但实际压不动单条小消息**——`message` 模式在 RedCode 里没有真正的对应物。

**第三档 — 明确缺失（9 项硬缺口）**：

1. **A6 `condensedSummaries`** —— 折叠旧块时无法把旧摘要**改短**。RedCode 只做 `replaceAll(marker, old.summary)` 原样继承。⚠️ **这一项与「压不动」的结构性根因直接相关**：Codex 对照笔记里记的 `protectedRecords 41→100 条 / 25,932→82,454 字符` 单调膨胀，机制上就是"旧摘要只进不出"。DCP 用模型重写摘要做了出口，RedCode 现在靠 `carryProtected` 的预算裁剪做出口（部分缓解），但**摘要正文本身仍然只增不减**。
   - ⚠️ 重要澄清：这一项在 RedCode 侧**确实不可达**，我上一轮把它当死路径删掉是**正确的**（模型侧 `compress` 工具 0.12.5 退役后没有任何调用方能传 `condensedSummaries`）。**删代码对、能力缺口也是真的**——两件事不矛盾。要恢复的是「出口」这个能力，不是那段死代码。
2. **B2 `protectTags`** —— `<protect>…</protect>` 逐字提取。用户在提示词里显式标记"这段别压"，RedCode 现在无处可标记。
3. **B4 `protectedFilePatterns`** —— 按文件路径保护工具输出（如 `**/*.md` 的 read 结果）。RedCode 只能按工具名白名单。
4. **B6 `workingState` 机械快照** —— 文件清单 / 失败调用 / 用户提示，1024 字符硬上限，按 `userPrompts → filesTouched → failedCalls` 丢弃。这是**压缩后模型最容易失忆的那三样**，RedCode 完全没有对应物。
5. **E7 运维命令** —— `stats` / `context` / `sweep`。DCP 用户能查"这个会话压了多少、省了多少、还剩哪些块"；RedCode 只能看 DB。
6. **E3 `recompress`** —— 重压入口。
7. **C2 最小选择下限** —— 防"为了几百 token 打掉整条前缀缓存"。
8. **D2 `recovering` 恢复态** —— 防"压到阈值下 1K 就收手，两轮后又过线"（DCP 注释里实测一个会话压 9 次）。
9. **F3 `turnProtection`** —— 最近 N 轮不压。RedCode 只有"当前请求"这一层保护。

**额外一条不算缺口但值得记的**：**F4 工具输出裁剪在 native 模式下被跳过**（`prompt.ts:2092`）。DCP 的 `pruneToolOutputs` / `deduplication` / `purgeErrors` 是**独立于 compress 的零成本本地裁剪**，native 模式把 legacy `prune()` 整个关掉了，等于丢掉了一层免费的上下文回收。这一条严格说不是 "compress 的替代" 问题，但同属"关掉 DCP 后失去的能力"，建议单独跟进。

### 三、最小补齐集（如果目标是"可关掉 DCP"）

按「性价比 / 是否堵住结构性根因」排序，只列我认为必须的：

1. **A6 摘要收敛出口** —— 让压缩摘要正文本身也有预算（不是只裁 `protectedRecords`）。这是唯一压在根因上的项。
2. **B6 workingState 机械快照** —— 机械提取，不调模型，成本接近零，收益是压缩后不失忆。
3. **B2/B4 两个保护入口** —— 用户显式标记 + 文件路径保护。都是纯配置面扩展，改动小。
4. **D2 恢复态 + C2 最小选择下限** —— 一起做，都是防压缩风暴的闸。
5. **F4 在 native 模式下恢复工具输出裁剪** —— 或者至少让 `prune()` 与 native 并存。
6. **E7 一个只读的 `stats` 出口** —— 运维可观测性，不补的话"压不动"永远只能靠翻 DB 才发现。

A1/A2/D3/C3/C5 属于**范式取舍，不建议补**：RedCode 已用 `assertExclusive`（`native-context.ts:32-39`）明确"原生压缩与 DCP 不能管同一段历史"，把模型从压缩决策里摘出去是有意的。往回补 = 把 DCP 的复杂度请回来。

## 备选与否决理由

**备选一：保留 DCP 插件，原生 compaction 只做兜底。**
否决。两者管同一段历史会互相打架（`assertExclusive` 已经显式拒绝），且 DCP 的发送时改写与 RedCode 的账本投影会在前缀缓存上双重结算。`implemented/feature/2026-10-10-native-compaction.md` 已决策二者互斥，本次审计不推翻。

**备选二：把 A1（模型自选）补回来，即恢复模型侧 compress 工具。**
否决。这正是 0.12.5 退役掉的东西，也是压缩风暴的一个来源（模型在 nudge 逼迫下随手圈小范围交差，`viability.ts:6-22` 的注释记了实测）。要恢复的是「出口」而不是「入口」。

**备选三：只补 A6，其余不管。**
否决。A6 堵根因，但 B6（失忆）与 F4（白丢回收）是独立收益，且成本都低。不过**如果只能做一件事，就做 A6**。

## 后果

**识别签名**：本篇基线为 RedCode `7ea78b2c`（`[YuQi] refactor(core): 清理原生压缩账本的不可达提交分支`）与 DCP `8fce0f8`（`[Karina] fix(compress): 折叠旧块的净增压缩全模式拦截`）。DCP 侧行号基于 `lib/` 源码，非 `dist/`。

**样本限制**：DCP 侧只读了 `lib/compress/`、`lib/messages/`、`lib/state/`、`lib/commands/`、`lib/hooks.ts`、`lib/config.ts`、`lib/prompts/` 的入口层，未逐行读 `lib/prompts/store.ts`（482 行）与 `lib/ui/`。F6/F7 判定较粗，其余判定均有直接源码证据。

**与既有 note 的关系**：
- 本篇的 A6 是 `2026-10-12-codex-compaction-design-comparison.md` 借鉴项 #1/#2（`carryProtected` 预算携带）的**另一面**——那篇说的是"保护记录要有出口"，本篇补上"摘要正文也要有出口"，而 DCP 恰好已经实现过。
- 本篇的 F4 与 `implemented/feature/2026-10-10-native-compaction.md` 的 `prune_ratio` 描述（"native mode does not run legacy pruning"）相互印证。

**死路径清查的补充结论**：`context-compaction.ts` 里 `condensedSummaries` 相关代码删除是**正确且必要**的（RedCode 侧确实零调用方），但审计澄清了它的**功能**在 DCP 侧是活的。**"代码不可达"与"能力缺失"是两个独立判断**，不能因为删了代码就认为缺口不存在。

**工作区状态**：本次审计**只读**，未修改任何代码或配置。产出为本笔记。
