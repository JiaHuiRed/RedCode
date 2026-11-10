# 锚点窗口压缩：选段从前移锚点起算，逼近闸门时合并旧窗口

状态:implemented（2026-10-22 同日落地，实现差异见文末）
分区:architecture
日期:2026-10-22

## 问题

原生压缩的残余成本集中在两处，且共用同一个结构性根源——**选段起点恒为会话首条消息**：

1. **摘要冷输入吃全历史**。每次压缩的摘要请求都要重读投影内全部历史：现场实测 GLM 单次摘要 75,642 输入、GPT 111,234 输入，全部是零缓存的全价冷输入。历史越长，这笔越大，且与压缩次数成正比。
2. **压后前缀从消息 0 起全灭**。新块 `anchorID = selected[0].info.id`，而 `planAutomatic` 的选段起点恒为 0（`native-context.ts:87`），于是每次压缩都把会话第一条消息的投影改写，KV 缓存从历史最前面作废——现场实测压后首个主请求 166,312 token 零命中（GPT 类严格缓存家族）。

`context_compaction_block` 全表 74 块复核（2026-10-22）：**所有会话的所有块 anchorID 都等于会话首条消息**。同会话多块序列的 `sourceMessageIDs` 全部单调增长（10-16 会话 76→189→305），账本层「新块消费旧块」的链从未断过。

拟修 C（`carryProtected` 预算携带 + `required` 口径扣除，`4b8560ad` 起）已经把保护记录膨胀兜住：10-14 会话 protChars 96,451→90,663 出现回落（`fitActive` 降级实跑），不再是 10-12 风暴期的单调暴涨。**但 C 治的是「压后体积」，治不了「每次压缩都从头改写」**——摘要冷输入与压后重建两个痛点原封不动。

外部参照（两份独立调研收敛到同一形状）：

- **codex**（`docs/notes/proposed/architecture/2026-10-12-codex-compaction-design-comparison.md` 借鉴项 #1/#3/#9）：有界重建 + `advance_auto_compact_window` 窗口链 + `BodyAfterPrefix` 触发口径。当时拟修 B 未落地，因 C 的收益尚待观察而搁置。
- **context-mode**（`E:\AI\context-mode`，2026-10-22 调研）：窗口化事件账本 + 压缩后只处理增量、逼近阈值时合并。其「检索式恢复」部分本仓已有原生等价物（账本 + `context_read`/`context_search`/`context_restore`），无增量价值；其窗口化思想与本条目一致。

## 决策

**平时增量，必要时合并：把块从「全历史消费链」改成「窗口序列」，窗口边界 = 上一活跃块的 sources 末尾。**

1. **选段起点前移**：`planAutomatic` 增加窗口边界入参（最后活跃块的 `sourceMessageIDs` 末尾在消息数组中的位置 + 1），选段不再从 0 开始。`latestUser` 保护、queued/未完工具切断、`required` 口径（含 C 的 retained 扣除与实报锚点归一）全部不变。
2. **摘要带背景**：增量摘要请求的输入 = 上一活跃块的摘要文本（作背景，不可压内容）+ 新历史投影。摘要 prompt 追加一句「先前摘要已提供，聚焦新增进展，延续既有线索」。成本每块只多付一份旧摘要（≤16k），换摘要的全局连贯性。
3. **旧块默认保持活跃**：新块不吞旧块，`consumedBlockIDs` 为空。投影天然支持多块（`project()` 的 anchors Map 不需要改）。
4. **合并出口（防套娃回归）**：当 `checkActive` 判定「现有活跃块 + 新块」将超 `active_max_tokens`/`active_max_bytes`，或活跃块数超 `maxBlocks` 时，选段扩展为「从最旧活跃块锚点起」（即回到现状的全吞行为），一次合并把窗口归一。合并周期内缓存全灭是显式接受的代价——它把「每轮多付 N 份旧块渲染」换回「单块有界投影」。`fitActive` 降级保持现状（只收束新块保护正文），不因合并改变语义。
5. **触发口径跟随**（codex 借鉴项 #3 的轻量版）：`planAutomatic` 的 `total`/`required` 已用实报锚点归一（C 批次），本条目不改触发检测；`overflow.ts` 与预警档位维持全量 ctx 口径。多块渲染体积受 80k 闸门约束后，对触发线的影响有上界，不值得为此再动一条检测链。
6. **窗口号**：Block 增加单调 `windowNumber`（`list()` 按序分配即可，不必进 schema——投影顺序即窗口序），日志与 `shortfall` 回执带上，让「这个会话压了几次/当前第几窗口」可一次查询看出（codex 借鉴项 #9）。

### 账（按现场数据）

以 GLM 长会话一个压缩周期（trigger 400k / target 120k，新增可压历史 ~250k）计：

| 项 | 现状（全吞） | 窗口化 | 差 |
|---|---:|---:|---|
| 摘要冷输入 | ~75k（全历史投影） | ~5k 旧摘要背景 + ~250k 增量历史的**未压部分**（约 120k+，投影内已有内容的工具输出不再重读） | 摘要输入显著下降；且第 2+ 次压缩的背景只有几 k |
| 压后重建（KV 作废范围） | 从消息 0 起（实测 166k 零命中） | 从新窗口锚点起（旧窗口渲染逐字节保住） | 保住 Σ旧块渲染 ≈ 20–60k read |
| 每轮固定体积 | 单块渲染（摘要 ≤16k + 携带 ≤20k + 新保护） | N 块渲染之和，受 80k 闸门 | 合并前每轮多付 ~20–40k read 价 |

GPT 类严格缓存家族收益最大（压后重建从 82% 缺失比例下调）；DeepSeek 类几乎无感（本就不依赖跨改写缓存），符合「代价按 provider 分层」的既有结论。

## 备选与否决理由

- **维持现状（单块全吞链）**：否决——摘要冷输入与压后重建两个痛点不动，长会话每 8–25 分钟重复支付；C 只治了体积，账单主体仍在。
- **纯 codex 式有界重建（每轮替换唯一摘要、删窗口链）**：否决——丢失账本可回滚性与 `block:<id>` 读回能力（10-10 笔记确立的优势项）；窗口化 + 合并出口保住同一有界性，同时保留回滚。
- **增量摘要不帶旧摘要背景**：否决——块 N 摘要看不到块 1..N-1 的目标/未完成工作，「延续性 handoff」质量塌方；几 k 背景是必要成本。
- **把合并出口做成自动阈值而不是选段扩展**：暂缓——合并本质是「一次特殊的全吞压缩」，复用既有选段/提交/校验链最稳；独立合并例程会多出一条需要单独测试的写路径。
- **顺手改触发检测为 `BodyAfterPrefix` scope**：暂缓——本条目的收益不依赖它；多块渲染体积有 80k 上界，触发线偏移有界。等窗口化落地后按实测数据再议。

## 后果

- **模型可见改动（四问）**：
  1. 模型看到的历史形状从「单块摘要渲染」变为「多窗口摘要渲染序列」（合并后回到单块）；单块渲染格式与 `render()` 逐字节不变；摘要 prompt 增加一句背景说明。
  2. 固定前缀增量 0（prompt 变化在摘要请求内，不进每轮前缀）；变量历史按窗口数增加（受 80k 闸门）。
  3. KV cache：压缩后前缀作废范围从「消息 0 起」缩到「新窗口锚点起」；合并周期全灭一次（显式接受）。摘要请求自身的前缀不受影响。
  4. 无新增无界注入：窗口渲染沿用 `summaryMaxTokens`/`retainedMaxTokens`/`activeMaxTokens`/`activeMaxBytes` 既有硬预算；背景摘要受 `summaryMaxTokens` 约束。
- **兼容**：旧数据零迁移——已有块就是「窗口 1」，首个窗口化提交天然接在它后面；`clone`/`invalidate`/`deactivate`/导入路径按块粒度工作，无窗口概念依赖。
- **风险与识别签名**：合并出口失效会退化回套娃——识别签名沿用 codex 对照笔记（同会话块 anchorID 恒定 + 压后体积单调上升），外加新签名「活跃块数 >`maxBlocks` 却无合并提交 WARN」。合并发生时写一条结构化 WARN（窗口数、合并前后 active token），不记正文。
- **测试面**：`native-context.test.ts`（窗口边界选段直测）、`context-compaction.test.ts`（多块投影、合并提交、checkActive 触发合并）、`compaction.test.ts`（processNative 端到端带旧块）、`native-compaction-budget.test.ts`（合并后预算收束）。全部按完整文件路径 + `--timeout 30000` 跑。
- **验收口径**：真实长会话（顶得到 400k）上观察三次压缩——第 2、3 次的摘要输入 token、压后首个主请求 cache.read、活跃块数。不以其会旧会话回放宣称收益。
- 回链：实现落地时在 `native-context.ts`（planAutomatic 窗口入参）、`context-compaction.ts`（合并出口与 WARN）头注释回链本文件；本文件状态行届时改 implemented。

## 与 context-mode 调研的关系（结论存档）

2026-10-22 应用户要求调研 `E:\AI\context-mode`（MCP/hooks 形态的上下文节省工具）：其 sandbox 执行、routing block（~3.7KB/轮注入）、FTS5 检索恢复均与本仓既有机制重复或违背注入面纪律，**不引入**；其「窗口化 + 增量处理 + 阈值合并」思想由本条目吸收。调研细节由会话记录承载，不另立文档。

## 落地记录（2026-10-22）

- **实现与设计的差异**：
  1. 合并出口做成了**选段前判定**而非提交后重试：`processNative` 在选段前算 `activeTokens + summaryMaxTokens + retainedMaxTokens > activeMaxTokens`，超限直接 `floor=0` 全吞（合并模式）并打 `native compaction window merged` WARN。原设计的「窗口提交失败再全吞重试」需要第二次摘要请求且摘要/选段可能错位，判定前置后合并与旧路径完全同构、无白付摘要。
  2. `windowBoundary(view, blocks)` 以**投影后视图**为输入（设计稿写的「sources 末尾」在原始消息序里不可定位——投影已移除 hidden 消息），实现为「最后活跃锚点位置 + 1」。
  3. 背景摘要拼进摘要请求的指令 user 消息头部（`[Previous window summary — background context only, …]` 前缀），不改 `toModelMessagesEffect` 输入结构；背景内容是上一块的 `summary` 字段（≤summaryMaxTokens），不带保护记录渲染。
- **改动面**：`native-context.ts`（`planAutomatic`/`selectAutomatic` 第 7 参 `startFloor`，默认 0 逐字节同旧行为；无效边界自动回退全吞）、`context-compaction.ts`（新增 `windowBoundary` 导出）、`compaction.ts`（`processNative` 边界/合并判定/floor 接线 + 背景注入 + shortfall 日志加 `windowFloor`）。commit/账本/`clone`/`invalidate`/导入零改动——多块共存与合并消费是既有能力（`fits a new range without rewriting untouched active blocks` 等用例已覆盖）。
- **验证**：新增用例——`native-context.test.ts` 窗口化 4 例（边界选段、无效边界回退、required 全量口径、floor=0 旧行为逐字节一致），`context-compaction.test.ts` 边界 1 例（投影视图上最后锚点之后）。四套件 `native-context` / `context-compaction` / `compaction`（80 pass）/ `native-compaction-budget`（21 pass）全绿，opencode typecheck 通过（tsgo 崩溃回退 TS 5.9.3 复跑，EXIT=0）。真实 provider 上的收益验收（第 2+ 次压缩的摘要输入 token、压后首请求 cache.read、活跃块数）仍需长会话实跑，不以隔离测试宣称。
- **既有 flaky 登记（非本批次引入，基线复现）**：`context-compaction.test.ts` 的 `fits two fresh ranges to one global budget` 在全文件连跑时偶发失败（基线 3 跑 2 挂、单跑恒绿），失败前有 DB 层 ERROR 日志指向第二个 range 提交。疑似测试间共享状态或 ID 时序问题，与窗口化无关（该用例纯 commit 层多 range，不经过选段路径）。修复属独立批次。
