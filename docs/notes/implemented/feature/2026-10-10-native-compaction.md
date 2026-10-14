# 原生压缩（native compaction）：DCP 选段、legacy 摘要与 Codex 检查点的整合

状态:implemented

## 问题

会话上下文压缩此前有三套并存机制，各自为政：

- **DCP 插件 compress**（主力）：模型自己选段写摘要，受保护原文机械拼回；但它是插件，独立仓库独立构建独立维护，状态在插件侧 JSON，模型不调就压不动。
- **legacy compaction**（兜底）：引擎确定性摘要，但摘要把媒体剥掉、工具输出截到 2000 字符，整段历史一刀切，细粒度证据全靠摘要模型转述。
- **Codex 的机制**（调研结论）：opaque 服务端压缩项不可审计不可移植，但其检查点持久化、待处理输入安全、模型窗口预算检查、"继承的上下文 ≠ 授权"值得吸收。

用户决策：把三者好的部分整合进原生 compaction，消掉插件这份维护。初版压缩钉在约 250k（用户确认：当时长任务缓存命中率仍能回到 98%+；超 300k 有注意力稀释的顾虑）。2026-10-12 根据 1M 窗口模型的实际使用，将兜底线调整为 400k、压后目标统一为 120k；当前值见文末更新。

## 决策

**一个账本/投影/提交/预算边界，两个摘要生产者。**

- **持久化账本** `session/context-compaction.sql.ts`（表 `context_compaction_block`，data JSON 存 Block）+ `session/context-compaction.ts`（同步内核：`commit`/`list`/`project`/`render`/`deactivate`/`invalidate`/`clone`/`read`/`search`）。原始 message/part 记录零改动——投影是查询期视图，摘要永远"历史交接、非新授权"，`deactivate`/`context_restore` 可完整回退。
- **模型生产者**：内建工具 `compress`/`context_read`/`context_search`/`context_restore`（`tool/context.ts`），沿用 DCP 的选段+保护语义（用户原文、受保护工具输出机械保留，`{{block:<id>}}` 嵌套拼接或 `condensedSummaries` 显式收束），回执走 `metadata.nativeCompression`，与既有 `request-evidence.ts` 的 DCP 回执同管道记账。
- **引擎生产者**：`compaction.ts` 的 `processNative`——预采样选段（保护最新真实用户请求）、使用触发压缩的用户轮次模型与 variant 生成摘要、走同一个 `commit`；失败/取消不落投影。自动触发的重试豁免防循环（见后果）。
- **预算**：`config/native-compaction.ts`，`compaction.native.enabled` 默认 false——不打开时 legacy 路径逐字节不变。当前 `trigger 400k / target 120k / reminder 220k`，小窗口按配置比例夹取；`overflow.ts` 的 `ceiling`/`isOverflow` native 打开时改看 trigger，legacy threshold 退位不叠加。预警比例为 0.8/0.9，TUI/GUI 档位统一为 320k 黄、360k 橙、400k 红。
- **缓存结算**：账本修订版（活跃块 ID 的 sha256）挂在 `msgPin.nativeRevision`，修订变化时结算一次 msgPin/modelMsgs——不是每轮重置。压缩后第一次请求缓存命中率下降是正常成本（用户确认），长任务趋势收益为正。
- **互斥**：native 与 DCP 不能同管一个会话（`assertExclusive` 检查插件工具名冲突）；旧 DCP 状态用 `session/context-import.ts` 显式导入（严格校验当前持久化格式、活跃块、端点可证实，歧义/缺源/超预算全拒绝，幂等按内容指纹）。
- **生命周期**：fork 只整块克隆（源全被映射才拷），revert 删除消息前 `invalidate` 失效引用块。

**安全边界**（对照 Codex 教训）：排队/steer 输入不是压缩边界也不进选段；未完成工具拒压；继承的摘要不授予新授权（模板+渲染头双重声明）；latest user 保护包含纯图片消息。

## 备选与否决理由

- **继续维护 DCP 插件**：否决——独立仓库、独立构建、状态旁路引擎，模型可见性与引擎演进脱节；维护成本用户明确想消。
- **provider 原生 opaque 压缩（Codex V2 风格）**：v1 否决——不可审计、不可移植、依赖特定 provider 能力；保留为远期观察项。
- **替换 legacy compaction**：否决——native 默认关闭，legacy 继续作为未开启用户与回退路径；`processNative` 失败时任务标记错误停止，不静默降级到 legacy 硬压。

## 后果

- **每次自动压缩只尝试一次**（`nativeAutoAttempted`，成功后重置）：commit 失败是结构性原因（预算配错、窗口太小），重试只会反复堆失败任务；且最后一条 summary assistant 带 error 时直接禁用自动触发，交还用户。这是审查发现的 livelock（queued 消息在位时 selectAutomatic 边界口径与 commit 不一致 → 必然失败 → prompt 重入无限建任务）的修复面。
- **sourceHashes 记录但活跃块嵌套时不回验**：已知限制。普通提交靠实时指纹比对防陈旧，嵌套消费沿用父块快照；raw 在块生效后被第三方改动（绕过 revert）不会被发现。识别签名：嵌套摘要与实际原文脱节但 commit 不报错。
- **registry 在实例构建时读一次 native 开关**：会话中途改配置不会刷新工具表（工具 execute 仍按次校验），行为一致但表滞后。
- **导入器不迁移 DCP 的 nudge/economics/工具缓存**：只导压缩块本身；导入后统计口径从原生回执重新累计。
- **牵连**：`CompactionPart` 加 `native` 可选字段（旧数据兼容）；`filterCompactedOrdered` 对 native 标记不裁原文（账本拥有裁剪权）；SDK/OpenAPI 未重新生成（`native` 字段与 config schema 有公共面，发版前需跑两条生成命令）。

回链：`context-compaction.ts` 头注、`native-context.ts`、`context-import.ts`、`tool/context.ts`。

## 现场失败修复

- 旧会话三次摘要生成均成功，但提交被遗留 `running` 工具拒绝，错误为 `Cannot compress queued input or pending tools`。失败守卫原先放在 `NativeRuntime.project()` 之后，而投影恰好隐藏 native 摘要，导致守卫永远读不到错误。现提前到原始可见历史取证，回归覆盖连续两条新用户消息正常回复、摘要数量不增加。
- 当前诊断会话的 625 token 是摘要生成请求的输入，不是压缩后的完整上下文。固定前缀与工具定义触发预算时，历史本身低于 target，负的回收需求使选择器只取最初用户提问；摘要自然看不到后续进度，最终被 `Compression has no positive savings after protection` 拒收。随后正常请求实报 74052 token，原始历史未被替换。
- 自动选择器按连续可提交段搜索，queued/未完工具作为断点；先扣除 `protect()` 或已活跃块的机械保留正文，回收需求至少包含摘要预算，避免只抽受保护用户文字。纯图片的最新请求与 commit 使用同一保护口径。无法找到可回收段时，先写有终态的错误摘要记录，不调用模型；选择或提交失败均广播 `session.error`，避免只静默停止。保留「失败不自动回退 legacy、不在同一轮自动重试」的既有边界。
- TUI 上下文、模型与速率从非摘要主请求取数，摘要成功/失败都不替换它；会话累计用量继续统计全部 assistant，只有摘要时也不漏记其成本。625 显示不是丢失整段历史的证据。
- 现场只读回放：旧会话 586 条原始消息、274 条可见消息，新选择器选 144 条、估算可回收 150689 token；未选择 pending/running 工具或最新真实用户请求。当前诊断会话同样验证失败记录仍能被守卫读取。回放只以只读 SQLite 连接读取数据，不调用引擎数据库 Client、不写投影。
- 验证覆盖 `native-context.test.ts`、`context-compaction.test.ts`、`native-compaction-budget.test.ts`、`compaction.test.ts`、`prompt.test.ts`、`sidebar-context.test.ts`、`transcript.test.ts`；按完整文件路径和 `--timeout 30000` 运行，类型检查走包脚本。并行初跑时既有 250ms 取消计时断言实测 278ms，串行重跑通过，未修改计时阈值。tsgo 崩溃时由既有脚本回退 TypeScript 5.9.3。
- 部署边界（初始配置）：本机 `redcode.local.jsonc` 当时使用 250000/160000/220000，DCP 继续停用；后续配置更新见文末 2026-10-12 记录。`bun run dev` 不带 watch，编辑不会热替换已加载模块；需重启 dev 才能应用源码与配置修改。真实 provider 上的压缩后续跑仍需新进程验收，不以只读回放替代。
- 后续截图里的提醒来自引擎保存的 `synthetic: true` 文本 part（metadata 为 `native_context_nudge.revision`），不是模型复述。用户消息和导出已经过滤 synthetic，助手 `TextPart` 渲染及复制路径却没有过滤。现共用 `isVisibleTextPart`，隐藏模型内部提醒并保留未标记 synthetic 的真实引用文字；不删除数据库 part、不改变模型输入或持久化日志。

模型可见四问：
1. 提示词、工具 schema/description 和保护记录的渲染文字不变；只纠正被选择的历史段和失败后的发送路径，原先仅最初提问的摘要输入现在包含可压缩进度。
2. 固定前缀增量为 0；变量历史用量随正确选段变化，没有新增固定注入。
3. 未成功提交时不改变投影和修订版；成功提交后仍由原有 revision 结算，从首个改变的历史位置起失效一次，不每轮重置缓存。
4. 无新增注入项；沿用 `max_messages`、`summary_max_tokens`、`summary_max_bytes`、`active_max_tokens`、`active_max_bytes` 等原有硬预算。默认单份摘要上限 16000 token（超过 10K）：保留长任务的路径、证据和未完成工作，仍按配置封顶，不新增无界内容。

- 提醒过滤之后又发现选段深度不足（现场复核）：IndexGraph 旧会话手动压缩显示 171k→150k（27.0s），但横条是历史粗估、完整请求实报 250,218→222,126 只降 11%。根因是两本账：触发按完整请求（usage ≥ trigger 250k），`selectAutomatic` 的回收需求却按历史粗估对照 target——`required = max(16k, 171k−160k+16k) = 27k`，7 条消息就满足提前收工；粗估 chars/4 低估 CJK（171k 估算 vs ~222k 实际历史），固定前缀（system+tools ≈ 28k）又不在账上。修法：`selectAutomatic` 增加可选 `currentTokens` 锚点（provider 实报 usage，取投影内最后一条非摘要 assistant 的 `tokens.context`，缺失退回粗估同旧），粗估与实报的偏差按统一比例 `total/measured` 归一，released 与 required 保持同单位。保护边界不动：latest user 仍不可压、queued/未完工具仍切断、commit 的 positive-savings 校验原样。本机覆盖层 target 同步压到 100k（用户确认）：250k 触发一次应换回约 150k 余量，仓库默认 160k 不变。测试：`native-context.test.ts` 新增锚点缩放直测（无锚 16 条 / 锚 100k 23 条），`compaction.test.ts` 新增完整请求口径用例（实报 60k 强制覆盖到第二条 completed，旧口径只会压第一条）；两文件 82 pass / 0 fail，typecheck EXIT=0（tsgo 崩溃按脚本回退 TS 5.9.3 复跑通过）。
- 模型可见四问：① 提示词/工具 schema/保护渲染文字零变化，变的只是被选中压缩的历史段深度；② 固定前缀增量为 0，变量历史随选段加深而减少；③ 未成功提交不动投影；成功提交仍由 revision 结算一次失效，不改变每轮重置行为；④ 无新增注入项，沿用既有硬预算。

## compress 退役（同日第二批）

- 模型侧 compress 工具整体移除：压缩生产者只剩引擎 `processNative` 与 `/compact` 手动入口，`context_read`/`context_search`/`context_restore` 三工具保留。`assertExclusive` 冲突名单不变——DCP 或用户插件再注册叫 `compress` 的工具仍拒绝共存。实测退役前工具定义（id+description+JSON Schema）序列化 1101 字节 ≈ 275 token，即 native 开启时的固定前缀净减量。
- 「逼近提醒」（`[Context notice, not a user request] … Use compress…`）随工具退役停止生成：它是给模型的手动压缩指引，没有对象就只剩干扰；`message-v2` 对旧会话遗留的提醒 part 在出站副本剥离（判据 `synthetic && metadata.native_context_nudge`），原文、账本指纹、TUI 过滤与导出行为不变。
- 模型可见四问：① 工具表少 compress、旧提醒不再入模，context_* 三工具 schema 不变；② native 开启固定前缀 −275 token、关闭 0；③ 均在新进程生效，工具区前缀失效一次属预期，账本 revision 不因此变化；④ 无新增注入项，净删除。
- 顺带修正 `test/session/message-v2.test.ts` 存量断言：RejectedError 文案改为 "The question was dismissed" 时测试未跟更（git show HEAD 证实红灯先于本批存在），按现文案对齐。

## 2026-10-12 更新：压缩继承主模型与预算线调整

### 问题

固定 Step 5 摘要模型会把一次压缩切到另一供应商/额度通道，增加等待与额度不足的风险；而用户希望当前上下文由当前主力模型直接处理。

### 决策

legacy 与 native 压缩都从触发压缩的父 user 消息读取 provider/model。`SessionCompaction.create` 保留 user model variant，native 与 legacy 摘要记录同一 variant。`agent.compaction.model/variant` 不再参与模型选择，live 与 seed 配置移除固定 Step 5 覆盖。当前预算为 trigger 400000、target 120000、reminder 220000；TUI/GUI 预警线为 320k/360k/400k，native 比例 0.8/0.9。

### 备选与否决理由

- **继续使用独立 Step 摘要模型**：否决——用户明确希望避免等待与额度分流，并由处理当前上下文的主力模型完成摘要。

### 后果

压缩成本与耗时由当前主力模型承担；同一会话的模型与 variant 保持一致。压缩配置和代码修改都需重启引擎生效。`test/session/compaction.test.ts` 71 pass，opencode typecheck 通过。

## 保护预算收敛与超限降级

### 问题

`carryProtected()` 原先只计算记录正文，不计算来源标签与分隔符；遇到一条装不下的记录就结束遍历，后面能装下的小证据也被丢弃。同一次提交消费多个旧块时，每块各拿一笔 `retained_max_tokens`，总携带量能超过该值。选段侧 `retainedTokens()` 又按旧块的全部保护记录估算，与提交时的预算携带不一致。

新选段提取的保护记录不受继承预算约束，仍可能让 `checkActive()` 拒绝整个提交；摘要请求已经付费，但投影完全不缩。此前“携带 ≤20k，因此整个压后 floor 有常数上界”的判断不完整：20k 只约束继承记录，新保护记录与未消费的活跃块必须另按全局 active 预算核算。

### 决策

1. **完整渲染口径的共享携带预算**：同一个新块消费的所有旧记录共享 `retained_max_tokens`，来源标签与分隔符计入预算。用户原文优先，同类按原始来源顺序取最近记录，不按 messageID 字典序猜时间。装不下一条时跳过它，继续尝试后面的整条记录；不截半条。选段侧对旧锚点调用相同的携带策略，普通新消息仍按其完整保护记录估算。
2. **active 超限时可控降级**：仅引擎 `mode: "auto"` 在完整投影超过 `active_max_tokens` 或 `active_max_bytes` 时，预算携带本次新块的保护记录。先为未消费的旧块及新摘要预留空间，再以用户原文优先、同类最新优先的顺序装入整条记录；过大项跳过。未消费的旧块不改，摘要不截断，最新真实用户请求、排队输入与未完成工具的保护边界不变。摘要加未消费旧块本身装不下时仍显式失败；导入模式保持严格拒绝。

净收益校验在完成预算收束之后进行，所有校验通过才写入块与消费关系。减少保护投影时写 `native compaction protection reduced to active budget` WARN，只有会话 ID、记录数量与 active token/byte 数，不记录正文或认证信息。原始 message/part 不改，已消费块仍存档；退投影的旧记录可从旧块或源消息读回，新记录从源消息读回。恢复父块后旧块重新激活，最后可恢复完整原始历史。

### 备选与否决理由

- **加窗口计数器当作收敛修复**：暂缓；计数本身不会缩短 `sourceMessageIDs` 或保护正文。
- **给 shortfall 判定放宽 95%**：暂缓；当前原生路径无论 shortfall 与否都提交 best-effort，放宽只会减少日志，不会增加回收量。DCP 的覆盖率规则针对其物理封顶后的可压账本覆盖，不等于原生 `released / required`。
- **删除原始历史、截断摘要、修改未消费的旧块**：否决；破坏回读或回滚，以及既有缓存 revision 边界。
- **把所有新保护记录都压进 20k 继承预算**：否决；新证据在 active 预算允许时继续逐字保留，只有实际超限才退投影。

### 后果与验证

两个新失败用例先在旧实现上复现：过大继承项阻断小证据；新保护输出超限导致提交失败。覆盖完整渲染预算、多旧块共享预算、token/UTF-8 byte 独立超限、未消费块不改、导入严格拒绝、摘要自身超限仍失败、原文回读与恢复。

最终五套件（context-compaction、context-import、native-context、native-compaction-budget、compaction）121 pass / 0 fail，449 expect；opencode typecheck、版本一致性及 `git diff --check` 通过。

收尾补充两个边界回归：故意反置 messageID 字典序，确认携带的是实际较新的用户来源；同次提交两段新历史，确认 active token/UTF-8 byte 预算按两块总和计算、优先保用户及较新工具证据、被退投影的原文可读回。补测后 context-compaction 单文件 14 pass / 0 fail、128 expect，typecheck 通过；本批只补测试，不改变已重编的运行时代码。

连续八个工具任务窗口走真实 `Session` / `ContextCompaction` 账本路径，检查每轮 active 投影不超过 512 token / 1600 byte，当前请求保留、原始消息逐项不变、读回成功、重复提交幂等，最后逐层恢复原始历史；三次重复共 24 轮通过。这里是隔离测试数据库与固定摘要，不是实际供应商任务，不能据此宣称缓存命中率或额度消耗已经改善。源码需重编重启后，真实任务再观察降级 WARN、压后实报用量和恢复轮命中率。

模型可见四问：
1. 提示词、工具 schema、摘要头、保护记录标签原文都不变；变化是过大历史的保留集合及摘要输入选段估值。
2. 固定前缀增加 0 token；变量历史在预算收束时减少，没有新增注入文本。
3. 成功提交仍通过新块 ID 更新 revision，从首个变化的历史位置起结算一次缓存；失败不改投影，不触碰未消费旧块或每轮固定前缀。
4. 无新增预算字段或无界注入；沿用 `retained_max_tokens`、`active_max_tokens`、`active_max_bytes` 和原有摘要、消息、块数上限。默认 active 上限 80k token 仍是长任务证据的既有配置预算，不是本次新增的固定前缀。

## 阶段耗时取证

用户观察原生压缩比 DCP 等待更久。现场日志的一次 GLM 摘要从 11:51:02 的模型流到 11:53:14 的缓存结算约 132 秒；已有 `llm.ttft=6415ms` 是首个协议事件，不是首次非空内容。总耗时不能直接归因于模型或本地处理，因此先补观测，不换模型、不缩摘要预算、不改选段或工具输出裁剪。

`processNative` 每次终态写一条 `native compaction stages` WARN，GUI 的 WARN 门槛也能落盘；只写固定数量的 ID、状态、毫秒与计数，不写提示词、摘要或认证内容。用单调时钟量阶段，异常或取消由 `Effect.onExit` 保留已观测记录，不新增持久化 schema 或 SDK 字段。

| 字段 | 口径 |
| --- | --- |
| `queue_ms` | compaction user 标记创建到 processNative 进入；含调度及上游准备，不声称是精准的触发检测时间 |
| `stages_ms.setup` / `projection` | 解析配置、agent/model；原生历史投影 |
| `selection` | 摘要消息建档、账本读取与选段 |
| `processor_setup` / `conversion` | processor 创建（含初始快照）；消息转模型输入 |
| `request` | 整次 processor.process，含流事件处理、用量归档、重试等待与 cleanup |
| `commit` | 摘要读取、校验与账本提交 |
| `metrics` / `finalize` | 压前/压后估算及标记落盘；继续通知、事件与 compact.post |
| `total_ms` | 原生处理入口到终态，包括旧 UI duration_ms 未覆盖的后续收尾；不改旧字段语义 |

`model_ms` 是 request 阶段内的观测，**不能和主阶段重复相加**：

- `first_event`：首个流事件；`first_content`：首次非空 text-delta 或 reasoning-delta，空 delta 和 start 事件不算；未观测到为 null。
- `stream_complete`：finish 事件到达；包含逐事件本地处理，不当作纯供应商计算时长。
- `event_handling`：成功完成的流事件处理累计时间；含增量落盘、插件、快照与用量归档。抛错事件的部分处理不计入此子项，但仍包含在 request / total。
- `usage`：step-finish 处理（含快照、计费与持久化）；`cleanup`：processor 收尾。两者与 event_handling / request 有包含关系。

另记请求尝试次数、选段消息数、实际摘要 UTF-8 字节、账本 output/reasoning token 数。失败前没发生的阶段不补造数值；没有模型请求时模型时间为 null，attempts 为 0。失败终态另记有限错误 tag（typed error 的 `_tag`/`Error.name`，或 `Interrupted`/`Defect`/`UnknownFailure`），不写错误正文或堆栈。原始消息、压缩投影、预算及模型输入保持原行为。

定向回归使用真实 SessionCompaction 和 SessionProcessor，只脚本化 LLM 事件流：覆盖成功阶段、保护历史拒绝且不发请求、空 delta 不被当成内容；compaction 与提示词路由三文件 87 pass / 0 fail，opencode typecheck 通过。计时 matcher 对深拷贝做匹配，避开本机 Bun 1.3.14 `toMatchObject` 用 asymmetric matcher 改写原记录的行为；临时打印已删除。

模型可见四问：① 提示词、工具 schema 和输出协议不变；② 固定前缀增量 0；③ 不改变 KV 前缀或 revision 结算；④ 没有新增模型注入项，既有摘要、保护与 active 预算不变。日志字段数固定，无正文载荷。

部署边界：源码需要重编重启。此次只建立计时反馈，不以隔离测试宣称实际压缩已提速，也不把本会话旧进程的请求算成本批验证。

## 中断恢复与状态可见性

### 现场证据

会话 `ses_ffe5ecd1d1526ffeW9F9LdqzuXCGiw` 的 13:33 摘要在 13:39 因流静默 120 秒停止；随后 13:39 的 GPT 请求及 13:41、13:43 的 GLM 请求都仍是 compaction，而非正常助手回复。数据库保存了后三条用户消息、四条未提交的摘要终态；第一条为 `UnknownError`，后三条为 `MessageAbortedError`，均有 `time.completed`、无 `finish`。取消只说明终止结果，用户因看不到进展而主动取消，不能将其归为模型故障。

这四次没有新块落入 `context_compaction_block`；此前 12:54 的块仍活跃，原始历史没有被删除。只读回放真实 `MessageV2.latest()`，修前仍返回旧 compaction task，修后为空；不是数据库死锁，也不是用户消息没保存。

`latest()` 原先只用 provider `finish` 判断任务是否越过执行边界；中断摘要没有该字段，旧标记永远 pending。`nativeFailed` 仅挡新自动触发，挡不住旧任务调度。调度又用最新用户作为摘要 parent，导致新消息被用于重跑。TUI 隐藏 compaction assistant，分割线只用 session 级 `time.compacting` 和成功 token 数：失败后没有持久终态，重跑无独立可见反馈，旧成功横条也会被 session 标志覆盖。

### 决策

- 已落 `error` 且 `time.completed` 的 summary，只退出其 parent 对应的 compaction task；不伪造通用 `finish`，不丢弃 subtask，不屏蔽新手动 compaction，也不丢弃从未完结的可恢复任务。不通过修改 live 数据库修会话。
- TUI 直接读取现有摘要的 error/time 和成功 token 记录，显示进行中、成功、失败、已取消或未完成。错误原因持久可见，展开显示详情；折叠预览按 Unicode code point 截断，避免切开代理对。marker 已创建但压缩 process 尚未开始时用中性 `Compaction`，不提前报「未完成」。部分摘要标记为未提交草稿。只给当前 checkpoint 标进行中；输入区常驻显示压缩阶段、真实摘要模型与计时，结束后消失。无需新增公共字段、数据库迁移或 SDK 生成物。
- 缓存核验发现 `prompt.ts` 在查询锚点前已保存本轮空 assistant，旧谓词每次先命中零用量占位，实报优化实际退回粗估。现先找最新非摘要有效实报，再校验 provider/model 与最新活跃块的提交时间；不越过较新的其他模型实报借用旧同模型数值，也不拿压缩前用量触发压缩后下一轮。触发线、目标、摘要与保护预算不改。

### 验证口径

失败用例先复现：两种无 finish 终态仍出现在 tasks；两条新用户消息返回 summary 而不是正常回复。修后覆盖终态错误与取消、新标记及其他 subtask 保留、未完成摘要可恢复；真实 SessionCompaction/SessionProcessor 与脚本化 HTTP LLM 走 provider error 和主动取消，确认终态落库、compacting 清除、下一条请求正常回复。额外覆盖零用量占位、切换模型又切回、真实账本提交后的用量代边界。

OpenTUI 真组件渲染与鼠标点击覆盖失败/取消无 finish、原因持久显示及展开、草稿标签、未完成不误报运行中、新压缩不覆盖旧成功或未完成线，以及常驻指示随启动/结束变化。没有调用真实供应商、没有修改现场数据库；源码重编重启后的旧会话续跑仍是部署验收边界。

### 上个会话缓存核验

按数据库逐 assistant 消息统计非摘要主请求，缺用量不当零命中；分母为 `tokens.context`，不是仅未缓存的 `tokens.input`：

| 主模型 | 有 context 的请求 | 累计 context | cache.read | 加权命中率 |
| --- | ---: | ---: | ---: | ---: |
| GLM-5.3-Flash | 195 | 31,509,913 | 31,234,880 | 99.127% |
| GPT-6.1 Sol | 65 | 16,339,140 | 15,181,568 | 92.915% |

摘要另计：GLM 成功摘要 101,773 输入、0 读取；GPT 成功摘要 111,234 输入、111,104 读取。未完整回执的失败/取消请求不能并入命中率。

GPT 四个零命中主请求中，11:55 首次换模型、12:54 压缩后的首次主请求是预期冷启动；另有 11:56 与 12:55 的完整原始 usage 显式 `cached_tokens: 0`。12:55 这次日志证明 system/tools/parameters 不变、history append，不能归为 SDK 缺字段假零，也不能据此确定具体哪层服务端路由失效。

`7ff5acb6` 的三态和 transport 取证在实跑日志中可见；`4d1234c1` 的触发锚点代码已装，但存在本次复现的占位遮蔽，不能用高合计命中率宣称该路径有效；`4b8560ad` 的保护携带代码在位，本会话没有 active-budget 降级 WARN，两次成功压缩本身不证明降级分支实跑过。压缩前后 343,299 → 222,380 的完整主请求输入说明历史确实减少，不等于任一单独优化的因果证明。

模型可见四问：
1. 提示词、工具描述/schema、摘要模板、正常请求输出协议不变；变量请求路由从旧摘要重跑恢复为用户正常轮，自动压缩的触发判断使用正确实报。TUI 文案只到客户端，不进入模型。
2. 固定前缀增量 0；不新增模型注入项，不为高命中率改写上下文。
3. 不新增缓存布局或逐轮重置；成功压缩仍按原 revision 结算，失败/取消不提交投影。正常续跑和避免错误触发改变请求发生时机，不承诺服务端命中率。
4. 无新无界输入；沿用 summary/messages/active/retained 原有硬预算。错误原因的展开属于客户端显示，不注入模型；无需公共 schema 或 SDK 变更。

最终串行验证：message-v2/prompt 两文件 133 pass / 13 skip / 0 fail、404 expect；TUI compaction-fold 10 pass / 0 fail、30 expect；opencode typecheck 在 tsgo 崩溃后回退 TS 5.9.3，通过。两文件首轮 PTY 执行曾在已有 `reserved queued messages stay editable only after release` 测试触发 Windows `taskkill` 启动 `uv_spawn EUNKNOWN`，单跑和最终串行整文件复核均通过，未改该测试或进程实现。上个会话遗留的 budget/compaction/system 路由四文件 94 pass、core 锁两文件 27 pass，core 与 scripts 类型检查通过；预算 CLI 从 repo/package 两个 cwd 得到相同 25,841/32,768 字节，pre-push Git Bash 语法与版本一致性检查通过。未执行整套 pre-push、真实 provider 续跑、重编、提交或推送。

## GUI 四态状态补充

GUI 时间线复用相同的 compaction marker、summary `mode`/`parentID`、error 与 `tokens_after` 判据；成功显示 tokens，失败/取消显示原因和未提交标记，未完成与进行中区分。composer dock 复用 `session.time.compacting`，显示 spinner 与经过时间。与 TUI 一样，marker 先创建而 process 尚未启动时使用中性标签；`TurnDivider` 缓存 key 同时包含 `state` 与 `attemptStarted`，避免状态仍为 incomplete 时沿用旧行。

验证：GUI 状态 helper 14 pass / 0 fail，timeline 数据 40 pass / 0 fail，session context metrics 29 pass / 0 fail；packages/app、packages/ui typecheck 通过。OpenTUI compaction-fold 12 pass / 0 fail；原生压缩 72 pass / 0 fail；packages/opencode typecheck 通过。未重启 app/server，未做真实浏览器视觉冒烟；新 UI 实际显示仍需宿主侧运行确认。

## 忙时手动压缩后的续跑

现场在主请求的工具检查尚未返回时创建 `auto: false` 标记。工具完成后摘要成功提交，日志返回 `status=continue`，下一次 loop 却把摘要的 `finish=stop` 当成原任务完成，立即退出。数据库中原主请求仍为 `tool-calls`，压缩没有失败，检查进程也没有被压缩终止。

native 与 legacy 共用 `hasUnfinishedTurn()`：排除当前标记、旧压缩产物及未领取队列，按真实用户与普通 assistant 的时间、finish/error 和本地工具记录判断是否还有工作。成功压缩且原轮未完成时，复用现有有界 `compaction_continue` 通知；已完成或报错的原轮不凭空开工。失败、取消和未提交摘要仍不续跑，不改变取消、重试、选段及预算策略。

回归先复现两个未完成轮次缺少通知；修后四个 native/legacy × 忙/闲用例通过。真实 HTTP fixture 另覆盖工具调用进行中排入手动压缩，确认两条路径均发出摘要后正常任务请求、返回普通助手答复，而非返回摘要作为最终答复。仅使用隔离数据库与本地服务。

模型可见四问：① 通知原文和摘要模板不改，只把既有续跑通知用于忙时手动压缩；② 固定前缀增量 0，变量历史增加一条既有固定短通知；③ 成功提交仍按原 revision 从改写历史处结算，不新增逐轮重置；④ 通知长度固定，摘要、消息、active/retained 硬预算沿用既有配置。
