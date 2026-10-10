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
