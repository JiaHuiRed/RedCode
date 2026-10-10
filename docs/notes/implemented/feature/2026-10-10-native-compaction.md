# 原生压缩（native compaction）：DCP 选段、legacy 摘要与 Codex 检查点的整合

状态:implemented

## 问题

会话上下文压缩此前有三套并存机制，各自为政：

- **DCP 插件 compress**（主力）：模型自己选段写摘要，受保护原文机械拼回；但它是插件，独立仓库独立构建独立维护，状态在插件侧 JSON，模型不调就压不动。
- **legacy compaction**（兜底）：引擎确定性摘要，但摘要把媒体剥掉、工具输出截到 2000 字符，整段历史一刀切，细粒度证据全靠摘要模型转述。
- **Codex 的机制**（调研结论）：opaque 服务端压缩项不可审计不可移植，但其检查点持久化、待处理输入安全、模型窗口预算检查、"继承的上下文 ≠ 授权"值得吸收。

用户决策：把三者好的部分整合进原生 compaction，消掉插件这份维护。压缩钉在 ~250k（用户确认：250k 档位下长任务缓存命中率仍能回到 98%+，比携带超量上下文便宜；超 300k 有注意力稀释的顾虑，未作为硬定律编码）。

## 决策

**一个账本/投影/提交/预算边界，两个摘要生产者。**

- **持久化账本** `session/context-compaction.sql.ts`（表 `context_compaction_block`，data JSON 存 Block）+ `session/context-compaction.ts`（同步内核：`commit`/`list`/`project`/`render`/`deactivate`/`invalidate`/`clone`/`read`/`search`）。原始 message/part 记录零改动——投影是查询期视图，摘要永远"历史交接、非新授权"，`deactivate`/`context_restore` 可完整回退。
- **模型生产者**：内建工具 `compress`/`context_read`/`context_search`/`context_restore`（`tool/context.ts`），沿用 DCP 的选段+保护语义（用户原文、受保护工具输出机械保留，`{{block:<id>}}` 嵌套拼接或 `condensedSummaries` 显式收束），回执走 `metadata.nativeCompression`，与既有 `request-evidence.ts` 的 DCP 回执同管道记账。
- **引擎生产者**：`compaction.ts` 的 `processNative`——预采样选段（保护最新真实用户请求）、专职压缩模型生成摘要、走同一个 `commit`；失败/取消不落投影。自动触发的重试豁免防循环（见后果）。
- **预算**：`config/native-compaction.ts`，`compaction.native.enabled` 默认 false——不打开时 legacy 路径逐字节不变。`trigger 250k / target 160k / reminder 220k`，小窗口按配置比例夹取；`overflow.ts` 的 `ceiling`/`isOverflow` native 打开时改看 trigger，legacy threshold 退位不叠加。
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
- 部署边界：本机 `redcode.local.jsonc` 已恢复 250000/160000/220000，DCP 继续停用；seed 没有 native 临时数字，无需把本机覆盖层复制进模板。用户当前已改为 `bun run dev` 启动，不应再把该进程称为旧 exe。该 dev 命令不带 watch，编辑不会热替换已加载模块；无需重编 exe，但仍需重启 dev 才能应用后续源码修改。真实 provider 上的压缩后续跑仍需新进程验收，不以只读回放替代。
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
